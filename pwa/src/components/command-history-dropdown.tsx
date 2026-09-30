import { Clock, Search, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryCommand } from '../hooks/use-command-history'
import { FOCUS_RING } from './ui/button'

interface Props {
  history: HistoryCommand[]
  onSelect: (text: string) => void
  onRemove: (id: string) => void
  onClear: () => void
  onClose: () => void
}

export function CommandHistoryDropdown({
  history,
  onSelect,
  onRemove,
  onClear,
  onClose,
}: Props) {
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

  return (
    <div
      className="absolute bottom-full left-0 right-0 z-40 mb-2 mx-2 flex max-h-[60vh] flex-col rounded-panel border border-border bg-surface-raised text-fg shadow-xl transition-[opacity,translate] duration-(--duration-fast) ease-standard starting:translate-y-1 starting:opacity-0 ui-native:border-0"
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
          placeholder="Search history... (↑↓ to navigate, Enter to select)"
          className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle ui-terminal:font-label"
          aria-label="Search command history"
          aria-controls="history-list"
          aria-activedescendant={
            selectedIndex >= 0 ? `history-item-${selectedIndex}` : undefined
          }
        />
        <button
          onClick={onClose}
          className={`flex size-8 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-touch ${FOCUS_RING}`}
          aria-label="Close history"
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
            {search ? 'No matching commands' : 'No command history'}
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
                aria-label={`Remove command: ${cmd.text}`}
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
            Clear all history
          </button>
        </div>
      )}
    </div>
  )
}
