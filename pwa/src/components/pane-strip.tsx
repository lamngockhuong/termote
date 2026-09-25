import type { SessionPane } from '../types/session'
import { AgentStatusBadge } from './agent-status-badge'

interface Props {
  panes: SessionPane[]
  activePaneId?: string
  onSelect: (paneId: string) => void
}

// Picks which pane of a split tab the terminal streams. Only rendered for
// tabs with more than one pane.
export function PaneStrip({ panes, activePaneId, onSelect }: Props) {
  if (panes.length < 2) return null
  return (
    <fieldset
      aria-label="Panes"
      className="min-w-0 flex items-center gap-1 px-2 py-1 overflow-x-auto scrollbar-hide bg-zinc-50 dark:bg-zinc-900/60 border-b border-zinc-200 dark:border-zinc-700"
    >
      {panes.map((pane) => {
        const active = pane.id === activePaneId
        return (
          <button
            key={pane.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(pane.id)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs whitespace-nowrap touch-manipulation transition-colors ${
              active
                ? 'bg-white dark:bg-zinc-700 shadow-sm text-zinc-900 dark:text-white'
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-700/50'
            }`}
          >
            <AgentStatusBadge status={pane.agentStatus} size={12} />
            <span className="max-w-[140px] truncate">{pane.label}</span>
          </button>
        )
      })}
    </fieldset>
  )
}
