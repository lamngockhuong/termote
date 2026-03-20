import { useState, useCallback, useEffect, useRef } from 'react'
import { Session, SESSIONS_STORAGE_KEY } from '../types/session'
import { selectWindow, createWindow, killWindow, fetchWindows, TmuxWindow } from './use-tmux-api'

// Store metadata (icon, description) in localStorage since tmux only stores window names
interface SessionMeta {
  icon: string
  description: string
}

function loadMeta(): Record<string, SessionMeta> {
  try {
    const stored = localStorage.getItem(SESSIONS_STORAGE_KEY)
    if (stored) return JSON.parse(stored)
  } catch {
    // ignore
  }
  return {}
}

function saveMeta(meta: Record<string, SessionMeta>) {
  localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(meta))
}

// Convert tmux window to Session
function windowToSession(win: TmuxWindow, meta: Record<string, SessionMeta>): Session {
  const m = meta[win.name] || { icon: '📺', description: '' }
  return {
    id: String(win.id),
    name: win.name,
    icon: m.icon,
    description: m.description,
  }
}

export function useLocalSessions() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSession] = useState<Session | null>(null)
  const [isReady, setIsReady] = useState(false)
  const metaRef = useRef<Record<string, SessionMeta>>(loadMeta())

  // Fetch sessions from tmux API
  const refreshSessions = useCallback(async () => {
    try {
      const windows = await fetchWindows()
      if (windows.length === 0) {
        // No windows, create default one
        await createWindow('shell')
        const newWindows = await fetchWindows()
        const newSessions = newWindows.map((w) => windowToSession(w, metaRef.current))
        setSessions(newSessions)
        const active = newWindows.find((w) => w.active)
        if (active) {
          setActiveSession(windowToSession(active, metaRef.current))
        } else if (newSessions.length > 0) {
          setActiveSession(newSessions[0])
        }
      } else {
        const newSessions = windows.map((w) => windowToSession(w, metaRef.current))
        setSessions(newSessions)
        const active = windows.find((w) => w.active)
        if (active) {
          setActiveSession(windowToSession(active, metaRef.current))
        } else if (newSessions.length > 0) {
          setActiveSession(newSessions[0])
        }
      }
      setIsReady(true)
    } catch (err) {
      console.warn('[tmux] API not available:', err)
      // Fallback: create a default session
      const fallback: Session = { id: '0', name: 'shell', icon: '💻', description: 'Terminal' }
      setSessions([fallback])
      setActiveSession(fallback)
      setIsReady(true)
    }
  }, [])

  // Initial fetch and periodic refresh
  useEffect(() => {
    refreshSessions()
    // Refresh every 5 seconds to sync across browsers
    const interval = setInterval(refreshSessions, 5000)
    return () => clearInterval(interval)
  }, [refreshSessions])

  const switchSession = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (session && session.id !== activeSession?.id) {
        await selectWindow(sessionId).catch(() => {})
        setActiveSession(session)
      }
    },
    [sessions, activeSession?.id]
  )

  const addSession = useCallback(
    async (name: string, icon = '📺', description = '') => {
      // Save metadata
      metaRef.current[name] = { icon, description }
      saveMeta(metaRef.current)

      // Create tmux window
      await createWindow(name).catch(() => {})

      // Refresh to get new window
      await refreshSessions()
    },
    [refreshSessions]
  )

  const removeSession = useCallback(
    async (sessionId: string) => {
      if (sessions.length <= 1) return

      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return

      // Kill tmux window
      await killWindow(sessionId).catch(() => {})

      // Remove metadata
      delete metaRef.current[session.name]
      saveMeta(metaRef.current)

      // Refresh to update list
      await refreshSessions()
    },
    [sessions, refreshSessions]
  )

  const updateSession = useCallback(
    (sessionId: string, updates: Partial<Omit<Session, 'id'>>) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return

      // Update metadata
      const oldMeta = metaRef.current[session.name] || { icon: '📺', description: '' }
      metaRef.current[session.name] = {
        icon: updates.icon ?? oldMeta.icon,
        description: updates.description ?? oldMeta.description,
      }
      saveMeta(metaRef.current)

      // Update local state
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, ...updates } : s))
      )
      if (activeSession?.id === sessionId) {
        setActiveSession((prev) => (prev ? { ...prev, ...updates } : prev))
      }
    },
    [sessions, activeSession?.id]
  )

  return {
    activeSession: activeSession || { id: '0', name: 'Loading...', icon: '⏳', description: '' },
    sessions,
    switchSession,
    addSession,
    removeSession,
    updateSession,
    isReady,
    refreshSessions,
  }
}
