import type { AgentStatus, Session } from '../types/session'

// Which sessions the sidebar lists: every one, those with a pane waiting on
// the user, those running any agent, or those with a pane at work.
export const SIDEBAR_FILTERS = [
  'all',
  'needs-you',
  'agents',
  'working',
] as const
export type SidebarFilter = (typeof SIDEBAR_FILTERS)[number]

export const DEFAULT_SIDEBAR_FILTER: SidebarFilter = 'all'

// An edited or future config may hold a filter this version does not know.
export function resolveSidebarFilter(value: unknown): SidebarFilter {
  return SIDEBAR_FILTERS.find((f) => f === value) ?? DEFAULT_SIDEBAR_FILTER
}

// Status of each of the session's panes. A tab's own status is only the
// heaviest of them, so a tab with a blocked and a working pane matches both.
function sessionStatuses(session: Session): AgentStatus[] {
  const statuses = session.panes
    ? session.panes.map((p) => p.agentStatus)
    : [session.agentStatus]
  return statuses.filter((s): s is AgentStatus => s !== undefined)
}

function sessionHasAgent(session: Session): boolean {
  return !!session.hasAgent || !!session.panes?.some((p) => p.hasAgent)
}

export function matchesFilter(
  session: Session,
  filter: SidebarFilter,
): boolean {
  switch (filter) {
    case 'needs-you':
      return sessionStatuses(session).includes('blocked')
    case 'working':
      return sessionStatuses(session).includes('working')
    case 'agents':
      return sessionHasAgent(session)
    default:
      return true
  }
}

export interface SessionSummary {
  blocked: number
  working: number
  agents: number
}

// Counts sessions (not panes) for the filter bar.
export function summarizeSessions(sessions: Session[]): SessionSummary {
  const count = (filter: SidebarFilter) =>
    sessions.filter((s) => matchesFilter(s, filter)).length
  return {
    blocked: count('needs-you'),
    working: count('working'),
    agents: count('agents'),
  }
}

// With no agent anywhere the bar is hidden, so a saved filter would leave an
// empty list with nothing to clear it: list everything instead.
export function effectiveFilter(
  sessions: Session[],
  filter: SidebarFilter,
): SidebarFilter {
  return sessions.some(sessionHasAgent) ? filter : 'all'
}

// Sessions with a blocked pane first, the rest in their original order.
export function blockedFirst(sessions: Session[]): Session[] {
  const blocked = sessions.filter((s) => matchesFilter(s, 'needs-you'))
  if (blocked.length === 0) return sessions
  return [...blocked, ...sessions.filter((s) => !matchesFilter(s, 'needs-you'))]
}
