export interface Session {
  id: string
  name: string
  icon: string
  description: string
}

// Default sessions (can be customized by user)
export const DEFAULT_SESSIONS: Session[] = [
  { id: 'claude', name: 'Claude', icon: '🤖', description: 'Claude Code CLI' },
  { id: 'copilot', name: 'Copilot', icon: '🐙', description: 'GitHub Copilot' },
  { id: 'shell', name: 'Shell', icon: '💻', description: 'General terminal' },
]

// Storage key for persisting sessions
export const SESSIONS_STORAGE_KEY = 'termote-sessions'
