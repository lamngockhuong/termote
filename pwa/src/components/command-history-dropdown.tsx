import { Clock, Search, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryCommand } from '../hooks/use-command-history'

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
      className="absolute bottom-full left-0 right-0 mb-2 mx-2 bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-700 max-h-[60vh] flex flex-col animate-in fade-in slide-in-from-bottom-2 duration-150"
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-zinc-200 dark:border-zinc-700">
        <Search size={16} className="text-zinc-400 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search history... (↑↓ to navigate, Enter to select)"
          className="flex-1 bg-transparent text-sm outline-none text-zinc-900 dark:text-white placeholder-zinc-400"
          aria-label="Search command history"
          aria-controls="history-list"
          aria-activedescendant={
            selectedIndex >= 0 ? `history-item-${selectedIndex}` : undefined
          }
        />
        <button
          onClick={onClose}
          className="p-1 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded transition-colors"
          aria-label="Close history"
        >
          <X size={16} className="text-zinc-500" />
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
          <div className="p-4 text-center text-zinc-400 text-sm">
            {search ? 'No matching commands' : 'No command history'}
          </div>
        ) : (
          filtered.map((cmd, index) => (
            <div
              key={cmd.id}
              id={`history-item-${index}`}
              role="option"
              aria-selected={selectedIndex === index}
              data-history-item
              className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                selectedIndex === index
                  ? 'bg-blue-100 dark:bg-blue-900/30'
                  : 'hover:bg-zinc-100 dark:hover:bg-zinc-700/50'
              }`}
              onClick={() => onSelect(cmd.text)}
            >
              <Clock size={14} className="text-zinc-400 shrink-0" />
              <span className="flex-1 text-sm font-mono truncate text-zinc-900 dark:text-white">
                {cmd.text}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(cmd.id)
                }}
                className="hidden group-hover:flex p-1 hover:bg-zinc-300 dark:hover:bg-zinc-600 rounded transition-colors"
                aria-label={`Remove command: ${cmd.text}`}
              >
                <Trash2 size={14} className="text-red-500" />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      {history.length > 0 && (
        <div className="p-2 border-t border-zinc-200 dark:border-zinc-700">
          <button
            onClick={onClear}
            className="w-full px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
          >
            Clear all history
          </button>
        </div>
      )}
    </div>
  )
}
