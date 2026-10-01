import { ChevronDown } from 'lucide-react'
import type { Session } from '../types/session'
import { AgentStatusBadge } from './agent-status-badge'
import { ConnectionDot, type ConnectionState } from './connection-indicator'
import { FOCUS_RING } from './ui/button'

interface Props {
  session: Session
  // Name of the session's group (tmux session, herdr workspace), if any
  groupName?: string
  // Tabs in that group
  sessionCount: number
  // Other tabs, in any group, with a pane waiting on the user
  blockedElsewhere?: number
  connectionState: ConnectionState
  // The sessions sheet it opens is showing
  expanded: boolean
  onClick: () => void
}

// Mobile top bar: the session on screen (icon, name, agent badge, connection
// dot); a tap opens the sessions sheet to switch or add one.
export function SessionSwitcherChip({
  session,
  groupName,
  sessionCount,
  blockedElsewhere = 0,
  connectionState,
  expanded,
  onClick,
}: Props) {
  const count = `${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`
  const waiting =
    blockedElsewhere > 0
      ? `, ${blockedElsewhere} other ${blockedElsewhere === 1 ? 'session needs' : 'sessions need'} you`
      : ''
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open sessions menu${waiting}`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      className={`flex h-10 min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left transition-colors duration-(--duration-fast) hover:bg-surface ui-native:rounded-full ui-native:bg-surface ui-native:px-3 ${FOCUS_RING}`}
    >
      <span className="shrink-0 text-[18px] leading-none">{session.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[15px] font-semibold leading-tight ui-terminal:font-label ui-terminal:text-[14px]">
            {session.name}
          </span>
          <AgentStatusBadge status={session.agentStatus} size={13} />
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-fg-muted ui-terminal:font-label">
          <ConnectionDot state={connectionState} />
          <span className="truncate">
            {groupName ? `${groupName} · ${count}` : count}
          </span>
        </span>
      </span>
      {blockedElsewhere > 0 ? (
        <span
          aria-hidden="true"
          data-testid="blocked-elsewhere"
          className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-danger px-1.5 text-[11px] font-semibold tabular-nums text-white dark:text-bg"
        >
          {blockedElsewhere}
        </span>
      ) : (
        <ChevronDown
          size={16}
          aria-hidden="true"
          className="ml-auto shrink-0 text-fg-subtle"
        />
      )}
    </button>
  )
}
