import type { SessionPane } from '../types/session'
import { AgentStatusBadge } from './agent-status-badge'
import { FOCUS_RING } from './ui/button'

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
      className="m-0 flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-0 border-b border-border bg-term px-2 py-1 scrollbar-hide"
    >
      {panes.map((pane) => {
        const active = pane.id === activePaneId
        return (
          <button
            key={pane.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(pane.id)}
            className={`flex h-7 items-center gap-1.5 whitespace-nowrap px-2 text-[12px] rounded-control touch-manipulation transition-colors duration-(--duration-fast) pointer-coarse:h-touch ui-terminal:font-label ${FOCUS_RING} ${
              active
                ? 'bg-accent-soft text-accent'
                : 'text-fg-muted hover:bg-surface hover:text-fg'
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
