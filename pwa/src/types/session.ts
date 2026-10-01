// Agent states worth a badge. herdr's "unknown" and any value this bundle
// does not know are dropped (no badge).
export type AgentStatus = 'blocked' | 'working' | 'done' | 'idle'

// Heaviest first: a tab or group shows the heaviest status of its panes.
export const AGENT_STATUS_ORDER: readonly AgentStatus[] = [
  'blocked',
  'working',
  'done',
  'idle',
]

export function toAgentStatus(
  value: string | undefined,
): AgentStatus | undefined {
  return AGENT_STATUS_ORDER.find((s) => s === value)
}

// Heaviest status among the given ones, or undefined when none has a badge.
export function worstAgentStatus(
  statuses: (AgentStatus | undefined)[],
): AgentStatus | undefined {
  return AGENT_STATUS_ORDER.find((s) => statuses.includes(s))
}

export interface SessionPane {
  id: string
  label: string
  hasAgent: boolean
  // Which agent ("claude"), when it runs one
  agentName?: string
  agentStatus?: AgentStatus
}

export interface Session {
  id: string
  name: string
  icon: string
  description: string
  // Group (tmux session, herdr workspace) the tab belongs to.
  groupId?: string
  // Pane the terminal streams for this tab.
  paneId?: string
  // That pane runs a coding agent.
  hasAgent?: boolean
  // Which agent it runs ("claude").
  agentName?: string
  panes?: SessionPane[]
  // Heaviest agent status among the tab's panes.
  agentStatus?: AgentStatus
}

export interface SessionGroup {
  id: string
  name: string
  // Heaviest agent status among the group's tabs.
  agentStatus?: AgentStatus
}

// Default sessions (single session on fresh install)
export const DEFAULT_SESSIONS: Session[] = [
  { id: 'shell', name: 'Shell', icon: '💻', description: 'Terminal' },
]

// Storage key for persisting sessions
export const SESSIONS_STORAGE_KEY = 'termote-sessions'
