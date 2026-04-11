import { useCallback, useEffect, useRef, useState } from 'react'
import { SESSIONS_STORAGE_KEY, type Session } from '../types/session'
import {
  createWindow,
  fetchWindows,
  killWindow,
  renameWindow,
  selectWindow,
  type TmuxWindow,
} from './use-tmux-api'

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
function windowToSession(
  win: TmuxWindow,
  meta: Record<string, SessionMeta>,
): Session {
  const m = meta[win.name] || { icon: '📺', description: '' }
  return {
    id: String(win.id),
    name: win.name,
    icon: m.icon,
    description: m.description,
  }
}

export function useLocalSessions(pollInterval = 5) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSession] = useState<Session | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [isServerReachable, setIsServerReachable] = useState(true)
  const metaRef = useRef<Record<string, SessionMeta>>(loadMeta())
  const isReadyRef = useRef(false)

  // Apply tmux windows to session state
  const applyWindows = useCallback((windows: TmuxWindow[]) => {
    const mapped = windows.map((w) => windowToSession(w, metaRef.current))
    setSessions(mapped)
    const active = windows.find((w) => w.active)
    setActiveSession(
      active ? windowToSession(active, metaRef.current) : (mapped[0] ?? null),
    )
  }, [])

  // Fetch sessions from tmux API
  const refreshSessions = useCallback(async () => {
    try {
      let windows = await fetchWindows()
      if (windows.length === 0) {
        await createWindow('shell')
        windows = await fetchWindows()
      }
      applyWindows(windows)
      setIsReady(true)
      isReadyRef.current = true
      setIsServerReachable(true)
    } catch (err) {
      console.warn('[tmux] API not available:', err)
      setIsServerReachable(false)
      // Fallback: create a default session only on first load
      if (!isReadyRef.current) {
        const fallback: Session = {
          id: '0',
          name: 'shell',
          icon: '💻',
          description: 'Terminal',
        }
        setSessions([fallback])
        setActiveSession(fallback)
        setIsReady(true)
        isReadyRef.current = true
      }
    }
  }, [applyWindows])

  // Initial fetch and periodic refresh
  useEffect(() => {
    refreshSessions()
    const ms = Math.max(pollInterval, 1) * 1000
    const interval = setInterval(refreshSessions, ms)
    return () => clearInterval(interval)
  }, [refreshSessions, pollInterval])

  const switchSession = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (session && session.id !== activeSession?.id) {
        await selectWindow(sessionId).catch(() => {})
        setActiveSession(session)
      }
    },
    [sessions, activeSession?.id],
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
    [refreshSessions],
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
    [sessions, refreshSessions],
  )

  const updateSession = useCallback(
    async (sessionId: string, updates: Partial<Omit<Session, 'id'>>) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return

      const oldName = session.name
      const newName = updates.name ?? oldName
      const oldMeta = metaRef.current[oldName] || {
        icon: '📺',
        description: '',
      }

      // If name changed, rename tmux window and re-key metadata
      if (updates.name && updates.name !== oldName) {
        await renameWindow(sessionId, updates.name).catch(() => {})
        delete metaRef.current[oldName]
      }

      // Update metadata under new name
      metaRef.current[newName] = {
        icon: updates.icon ?? oldMeta.icon,
        description: updates.description ?? oldMeta.description,
      }
      saveMeta(metaRef.current)

      // Update local state
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, ...updates } : s)),
      )
      if (activeSession?.id === sessionId) {
        setActiveSession((prev) => (prev ? { ...prev, ...updates } : prev))
      }
    },
    [sessions, activeSession?.id],
  )

  return {
    activeSession: activeSession || {
      id: '0',
      name: 'Loading...',
      icon: '⏳',
      description: '',
    },
    sessions,
    switchSession,
    addSession,
    removeSession,
    updateSession,
    isReady,
    isServerReachable,
    refreshSessions,
  }
}
