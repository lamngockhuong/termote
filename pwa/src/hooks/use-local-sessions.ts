import { useState, useCallback, useEffect } from 'react'
import { Session, DEFAULT_SESSIONS, SESSIONS_STORAGE_KEY } from '../types/session'
import { selectWindow, createWindow, killWindow, fetchWindows } from './use-tmux-api'

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

export function useLocalSessions() {
  const [sessions, setSessions] = useState<Session[]>(loadSessions)
  const [activeSession, setActiveSession] = useState<Session>(sessions[0])
  const [isReady, setIsReady] = useState(false)

  // Initialize tmux windows on mount
  useEffect(() => {
    const initTmux = async () => {
      try {
        const windows = await fetchWindows()
        // If no windows exist yet, create default ones
        if (windows.length === 0) {
          for (const session of DEFAULT_SESSIONS) {
            await createWindow(session.id)
          }
        }
        setIsReady(true)
      } catch (err) {
        console.warn('[tmux] API not available, fallback to manual mode')
        setIsReady(true)
      }
    }
    initTmux()
  }, [])

  useEffect(() => {
    saveSessions(sessions)
  }, [sessions])

  const switchSession = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (session && session.id !== activeSession.id) {
        setActiveSession(session)
        // Find window index by name or use session index
        const idx = sessions.findIndex((s) => s.id === sessionId)
        await selectWindow(idx).catch(() => {})
      }
    },
    [sessions, activeSession.id]
  )

  const addSession = useCallback(
    async (name: string, icon = '📺', description = '') => {
      const id = name.toLowerCase().replace(/\s+/g, '-')
      if (sessions.some((s) => s.id === id)) return

      const newSession: Session = { id, name, icon, description }
      setSessions((prev) => [...prev, newSession])
      setActiveSession(newSession)

      // Create tmux window
      await createWindow(id).catch(() => {})
    },
    [sessions]
  )

  const removeSession = useCallback(
    async (sessionId: string) => {
      if (sessions.length <= 1) return

      const idx = sessions.findIndex((s) => s.id === sessionId)
      if (idx === -1) return

      // Kill tmux window
      await killWindow(idx).catch(() => {})

      const nextSession = sessions[idx === 0 ? 1 : idx - 1]
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))

      if (activeSession.id === sessionId) {
        setActiveSession(nextSession)
        const nextIdx = sessions.findIndex((s) => s.id === nextSession.id)
        await selectWindow(nextIdx).catch(() => {})
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
    isReady,
  }
}
