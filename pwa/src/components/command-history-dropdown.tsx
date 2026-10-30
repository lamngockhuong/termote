import { Clock, Search, Trash2, X } from 'lucide-react'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryCommand } from '../hooks/use-command-history'
import { useExitTransition } from '../hooks/use-exit-transition'
import { useT } from '../i18n/i18n-context'
import { FOCUS_RING } from './ui/button'

interface Props {
  isOpen: boolean
  history: HistoryCommand[]
  onSelect: (text: string) => void
  onRemove: (id: string) => void
  onClear: () => void
  onClose: () => void
}

// Closed, it fades out first, inert; opened again it starts with an empty search
export function CommandHistoryDropdown({ isOpen, ...rest }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const { mounted, closing, opens } = useExitTransition(isOpen, rootRef)
  if (!mounted) return null
  return (
    <OpenDropdown key={opens} rootRef={rootRef} closing={closing} {...rest} />
  )
}

function OpenDropdown({
  rootRef,
  closing,
  history,
  onSelect,
  onRemove,
  onClear,
  onClose,
}: Omit<Props, 'isOpen'> & {
  rootRef: RefObject<HTMLDivElement | null>
  closing: boolean
}) {
  const { t } = useT()
  const [search, setSearch] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = search.trim()
    ? history.filter((c) => c.text.toLowerCase().includes(search.toLowerCase()))
    : history

  // Reset selection only if out of bounds
  useEffect(() => {
    setSelectedIndex((prev) => (prev >= filtered.length ? -1 : prev))
  }, [filtered.length])

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) =>
            prev < filtered.length - 1 ? prev + 1 : prev,
          )
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev))
          break
        case 'Enter':
          if (selectedIndex >= 0 && filtered[selectedIndex]) {
            e.preventDefault()
            onSelect(filtered[selectedIndex].text)
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  )

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-history-item]')
      items[selectedIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // 60cqh: 60% of the app's own height (App makes it a size container), not
  // of the screen. iOS keeps 60vh at the full screen's height with the
  // keyboard up while the app shrinks above it, which pushed the search box
  // off the top; overflow-hidden keeps the list off the toolbar regardless.
  return (
    <div
      ref={rootRef}
      data-history-root
      inert={closing}
      aria-hidden={closing || undefined}
      data-closing={closing || undefined}
      className={`absolute bottom-full left-0 right-0 z-40 mb-2 mx-2 flex max-h-[60vh] supports-[height:1cqh]:max-h-[60cqh] flex-col overflow-hidden rounded-panel border border-border bg-surface-raised text-fg shadow-xl transition-[opacity,translate] duration-(--duration-fast) ease-standard starting:translate-y-1 starting:opacity-0 ui-native:border-0 ${closing ? 'pointer-events-none translate-y-1 opacity-0' : ''}`}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Search size={16} className="text-fg-subtle shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('shell.history.placeholder')}
          className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle ui-terminal:font-label"
          aria-label={t('shell.history.search')}
          aria-controls="history-list"
          aria-activedescendant={
            selectedIndex >= 0 ? `history-item-${selectedIndex}` : undefined
          }
        />
        <button
          onClick={onClose}
          className={`flex size-8 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-touch ${FOCUS_RING}`}
          aria-label={t('shell.history.close')}
        >
          <X size={16} />
        </button>
      </div>

      {/* Command list */}
      <div
        ref={listRef}
        id="history-list"
        role="listbox"
        className="flex-1 overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-sm text-fg-subtle">
            {search ? t('shell.history.noMatch') : t('shell.history.empty')}
          </div>
        ) : (
          filtered.map((cmd, index) => (
            <div
              key={cmd.id}
              id={`history-item-${index}`}
              role="option"
              tabIndex={0}
              aria-selected={selectedIndex === index}
              data-history-item
              className={`group flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors pointer-coarse:min-h-touch ${
                selectedIndex === index ? 'bg-accent-soft' : 'hover:bg-surface'
              }`}
              onClick={() => onSelect(cmd.text)}
            >
              <Clock size={14} className="text-fg-subtle shrink-0" />
              <span className="flex-1 truncate font-term text-sm text-fg">
                {cmd.text}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(cmd.id)
                }}
                className={`flex size-8 items-center justify-center rounded-control transition-colors hover:bg-surface pointer-coarse:size-touch sm:hidden sm:group-hover:flex ${FOCUS_RING}`}
                aria-label={t('shell.history.remove', { text: cmd.text })}
              >
                <Trash2 size={14} className="text-danger" />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      {history.length > 0 && (
        <div className="border-t border-border p-2">
          <button
            onClick={onClear}
            className={`w-full rounded-control px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 pointer-coarse:h-touch ${FOCUS_RING}`}
          >
            {t('shell.history.clearAll')}
          </button>
        </div>
      )}
    </div>
  )
}
