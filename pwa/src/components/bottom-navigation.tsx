import { Monitor, Plus } from 'lucide-react'
import { useHaptic } from '../hooks/use-haptic'
import type { Session } from '../types/session'

interface Props {
  sessions: Session[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onToggleSidebar: () => void
}

export function BottomNavigation({
  sessions,
  activeId,
  onSelect,
  onAdd,
  onToggleSidebar,
}: Props) {
  const { trigger: haptic } = useHaptic()

  const handleSelect = (id: string) => {
    haptic('selection')
    onSelect(id)
  }

  const handleAdd = () => {
    haptic('medium')
    onAdd()
  }

  const handleToggle = () => {
    haptic('light')
    onToggleSidebar()
  }

  return (
    <nav className="flex items-center justify-between px-2 py-2 glass-surface border-t border-zinc-300/30 dark:border-zinc-700/30">
      {/* Left: Sidebar toggle + Add */}
      <div className="flex gap-1">
        <button
          onClick={handleToggle}
          className="w-11 h-11 flex items-center justify-center rounded-lg bg-zinc-200/50 dark:bg-zinc-700/50 active:bg-zinc-300/50 dark:active:bg-zinc-600/50 touch-manipulation transition-colors"
          aria-label="Toggle sessions panel"
        >
          <Monitor size={20} />
        </button>
        <button
          onClick={handleAdd}
          className="w-11 h-11 flex items-center justify-center rounded-lg bg-zinc-200/50 dark:bg-zinc-700/50 active:bg-zinc-300/50 dark:active:bg-zinc-600/50 touch-manipulation transition-colors"
          aria-label="Add session"
        >
          <Plus size={20} />
        </button>
      </div>

      {/* Right: Session tabs */}
      <div className="flex gap-1 overflow-x-auto">
        {sessions.slice(0, 5).map((session) => (
          <button
            key={session.id}
            onClick={() => handleSelect(session.id)}
            className={`min-w-11 h-11 px-3 flex items-center justify-center rounded-lg touch-manipulation transition-colors ${
              activeId === session.id
                ? 'bg-blue-600 text-white'
                : 'bg-zinc-200/50 dark:bg-zinc-700/50 active:bg-zinc-300/50 dark:active:bg-zinc-600/50'
            }`}
            aria-label={session.name}
            aria-current={activeId === session.id ? 'true' : undefined}
          >
            <span className="text-lg">{session.icon}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
