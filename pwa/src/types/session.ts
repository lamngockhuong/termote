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

// A metadata token a Herdr plugin or tool reported: plain text from outside
// termote, shown as text only.
export interface MetaToken {
  key: string
  value: string
}

export interface SessionPane {
  id: string
  label: string
  // The name the user gave the pane, which label shows first.
  name?: string
  // Metadata a Herdr plugin or tool reported (plain text, never markup).
  meta?: MetaToken[]
  hasAgent: boolean
  // Which agent ("claude"), when it runs one
  agentName?: string
  agentStatus?: AgentStatus
  // When agentStatus began (server time, RFC 3339); agentSinceFirstSeen:
  // when the server first saw the agent, already in it.
  agentSince?: string
  agentSinceFirstSeen?: boolean
  // Name of its foreground process ("vim"), when the server tells.
  command?: string
}

// Where each pane of a Herdr tab sits on the desktop, in character cells
// from the top left of the tab's area. zoomed: the desktop shows only
// zoomedPaneId, over the whole area.
export interface TabLayout {
  cols: number
  rows: number
  zoomed: boolean
  zoomedPaneId?: string
  panes: { id: string; x: number; y: number; cols: number; rows: number }[]
}

export interface Session {
  id: string
  // Names the same tab while its id changes (MuxTab.key); the id when the
  // server sends none.
  key?: string
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
  // Foreground process names of every pane of the tab, without repeats.
  commands?: string[]
  // The panes' places on the desktop (Herdr).
  layout?: TabLayout
}

export interface SessionGroup {
  id: string
  name: string
  // Heaviest agent status among the group's tabs.
  agentStatus?: AgentStatus
  // Its place in a Herdr worktree group (linked worktree, or the
  // repository's own checkout), the branch, when known, and a linked
  // worktree's repository checkout (parent), when open.
  worktree?: { linked: boolean; branch?: string; parent?: string }
  meta?: MetaToken[]
}

// Default sessions (single session on fresh install)
export const DEFAULT_SESSIONS: Session[] = [
  // i18n-ignore: a stored description, only searched, never shown
  { id: 'shell', name: 'Shell', icon: '💻', description: 'Terminal' },
]

// Storage key for persisting sessions
export const SESSIONS_STORAGE_KEY = 'termote-sessions'
