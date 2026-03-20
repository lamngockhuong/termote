export interface Session {
  id: string
  name: string
  icon: string
  description: string
}

// Default sessions (single session on fresh install)
export const DEFAULT_SESSIONS: Session[] = [
  { id: 'shell', name: 'Shell', icon: '💻', description: 'Terminal' },
]

// Storage key for persisting sessions
export const SESSIONS_STORAGE_KEY = 'termote-sessions'
