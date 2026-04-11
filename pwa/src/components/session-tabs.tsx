import { Plus, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Session } from '../types/session'

interface Props {
  sessions: Session[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
}

export function SessionTabs({
  sessions,
  activeId,
  onSelect,
  onAdd,
  onRemove,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // Scroll active tab into view only if not visible
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId triggers scroll when tab changes
  useEffect(() => {
    const el = activeRef.current
    const container = scrollRef.current
    if (!el || !container) return

    const rect = el.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const isVisible =
      rect.left >= containerRect.left && rect.right <= containerRect.right

    if (!isVisible) {
      el.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      })
    }
  }, [activeId])

  return (
    <div className="flex items-center bg-zinc-100 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
      {/* Scrollable tabs container */}
      <div
        ref={scrollRef}
        className="flex-1 flex items-center gap-1 px-2 py-1 overflow-x-auto scrollbar-hide"
      >
        {sessions.map((session) => (
          <button
            key={session.id}
            ref={session.id === activeId ? activeRef : null}
            onClick={() => onSelect(session.id)}
            className={`group relative flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
              activeId === session.id
                ? 'bg-white dark:bg-zinc-700 shadow-sm text-zinc-900 dark:text-white'
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-700/50'
            }`}
          >
            <span className="text-base">{session.icon}</span>
            <span className="max-w-[100px] truncate">{session.name}</span>
            {/* Close button */}
            {sessions.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(session.id)
                }}
                className="hidden group-hover:flex w-4 h-4 items-center justify-center rounded hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors"
                aria-label={`Close ${session.name}`}
              >
                <X size={12} />
              </button>
            )}
          </button>
        ))}
      </div>

      {/* Add button */}
      <button
        onClick={onAdd}
        className="shrink-0 w-8 h-8 flex items-center justify-center mr-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-700/50 transition-colors"
        aria-label="Add session"
        title="Add session"
      >
        <Plus size={18} />
      </button>
    </div>
  )
}
