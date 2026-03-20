import { useState, useCallback, useEffect, useRef } from 'react'
import { Session, DEFAULT_SESSIONS, SESSIONS_STORAGE_KEY } from '../types/session'
import type { XtermTerminalHandle } from '../components/xterm-terminal'

// Load sessions from localStorage or use defaults
function loadSessions(): Session[] {
  try {
    const stored = localStorage.getItem(SESSIONS_STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
  } catch {
    // ignore
  }
  return DEFAULT_SESSIONS
}

function saveSessions(sessions: Session[]) {
  localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions))
}

export function useSession() {
  const [sessions, setSessions] = useState<Session[]>(loadSessions)
  const [activeSession, setActiveSession] = useState<Session>(sessions[0])
  const terminalRef = useRef<XtermTerminalHandle | null>(null)

  useEffect(() => {
    saveSessions(sessions)
  }, [sessions])

  const setTerminalRef = useCallback((ref: XtermTerminalHandle | null) => {
    terminalRef.current = ref
  }, [])

  const switchSession = useCallback(
    (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (session && session.id !== activeSession.id) {
        setActiveSession(session)
        // Switch tmux window, create if not exists
        terminalRef.current?.sendCommand(
          `tmux select-window -t ${session.id} 2>/dev/null || tmux new-window -n ${session.id}`
        )
      }
    },
    [sessions, activeSession.id]
  )

  const addSession = useCallback(
    (name: string, icon = '📺', description = '') => {
      const id = name.toLowerCase().replace(/\s+/g, '-')
      if (sessions.some((s) => s.id === id)) return

      const newSession: Session = { id, name, icon, description }
      setSessions((prev) => [...prev, newSession])
      setActiveSession(newSession)

      // Create new tmux window
      terminalRef.current?.sendCommand(`tmux new-window -n ${id}`)
    },
    [sessions]
  )

  const removeSession = useCallback(
    (sessionId: string) => {
      if (sessions.length <= 1) return

      const idx = sessions.findIndex((s) => s.id === sessionId)
      if (idx === -1) return

      // Kill tmux window
      terminalRef.current?.sendCommand(`tmux kill-window -t ${sessionId}`)

      const nextSession = sessions[idx === 0 ? 1 : idx - 1]
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))

      if (activeSession.id === sessionId) {
        setActiveSession(nextSession)
        terminalRef.current?.sendCommand(`tmux select-window -t ${nextSession.id}`)
      }
    },
    [sessions, activeSession.id]
  )

  return {
    activeSession,
    sessions,
    switchSession,
    addSession,
    removeSession,
    setTerminalRef,
  }
}
