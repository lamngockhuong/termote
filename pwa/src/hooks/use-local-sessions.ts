import { useCallback, useEffect, useRef, useState } from 'react'
import { SESSIONS_STORAGE_KEY, type Session } from '../types/session'
import {
  closeTab,
  createTab,
  fetchTabs,
  type MuxTab,
  renameTab,
  selectTab,
} from './use-mux-api'

// Store metadata (icon, description) in localStorage since the mux only stores tab names
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

// Convert mux tab to Session
function tabToSession(tab: MuxTab, meta: Record<string, SessionMeta>): Session {
  const m = meta[tab.name] || { icon: '📺', description: '' }
  return {
    id: tab.id,
    name: tab.name,
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

  // Apply mux tabs to session state
  const applyTabs = useCallback((tabs: MuxTab[]) => {
    const mapped = tabs.map((t) => tabToSession(t, metaRef.current))
    setSessions(mapped)
    const active = tabs.find((t) => t.active)
    setActiveSession(
      active ? tabToSession(active, metaRef.current) : (mapped[0] ?? null),
    )
  }, [])

  // Fetch sessions from mux API
  const refreshSessions = useCallback(async () => {
    try {
      let tabs = await fetchTabs()
      if (tabs.length === 0) {
        await createTab('shell')
        tabs = await fetchTabs()
      }
      applyTabs(tabs)
      setIsReady(true)
      isReadyRef.current = true
      setIsServerReachable(true)
    } catch (err) {
      console.warn('[mux] API not available:', err)
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
  }, [applyTabs])

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
        /* v8 ignore next */
        await selectTab(sessionId).catch(() => {})
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

      // Create mux tab
      /* v8 ignore next */
      await createTab(name).catch(() => {})

      // Refresh to get new tab
      await refreshSessions()
    },
    [refreshSessions],
  )

  const removeSession = useCallback(
    async (sessionId: string) => {
      if (sessions.length <= 1) return

      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return

      // Close mux tab
      /* v8 ignore next */
      await closeTab(sessionId).catch(() => {})

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

      // If name changed, rename mux tab and re-key metadata. A rejected
      // rename (e.g. invalid name) leaves the session and its metadata as is.
      if (updates.name && updates.name !== oldName) {
        const renamed = await renameTab(sessionId, updates.name).catch(
          () => false,
        )
        if (!renamed) return
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
        /* v8 ignore next */
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
