export interface Session {
  id: string
  name: string
  icon: string
  description: string
  // Pane the terminal streams for this tab (its active pane).
  paneId?: string
  // That pane runs a coding agent (herdr).
  hasAgent?: boolean
}

// Default sessions (single session on fresh install)
export const DEFAULT_SESSIONS: Session[] = [
  { id: 'shell', name: 'Shell', icon: '💻', description: 'Terminal' },
]

// Storage key for persisting sessions
export const SESSIONS_STORAGE_KEY = 'termote-sessions'
