import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SESSIONS_STORAGE_KEY,
  type Session,
  type SessionGroup,
  type SessionPane,
  toAgentStatus,
  worstAgentStatus,
} from '../types/session'
import {
  closeTab,
  createTab,
  fetchSnapshot,
  type MuxSnapshot,
  renameTab,
  selectTab,
} from './use-mux-api'

export type MuxInfo = Pick<MuxSnapshot, 'backend' | 'caps'>

const DEFAULT_MUX: MuxInfo = {
  backend: 'tmux',
  caps: { clientSideSelect: false, copyMode: true },
}

// Store metadata (icon, description) in localStorage since the mux only stores tab names
interface SessionMeta {
  icon: string
  description: string
}

const DEFAULT_META: SessionMeta = { icon: '📺', description: '' }

// tmux keys metadata by window name, as 0.x did, so it survives window
// renumbering; other backends have stable tab ids.
const TMUX_META_PREFIX = 'tmux:name:'
const HERDR_META_PREFIX = 'herdr:'

function metaKey(backend: string, tabId: string, tabName: string): string {
  return backend === 'tmux'
    ? `${TMUX_META_PREFIX}${tabName}`
    : `${backend}:${tabId}`
}

// 0.x stored metadata under the bare window name; those keys become tmux
// keys. Only tmux existed in 0.x, so every unprefixed key is a window name.
function migrateMeta(meta: Record<string, SessionMeta>) {
  let changed = false
  const out: Record<string, SessionMeta> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (key.startsWith(TMUX_META_PREFIX) || key.startsWith(HERDR_META_PREFIX)) {
      out[key] = value
    } else {
      out[`${TMUX_META_PREFIX}${key}`] ??= value
      changed = true
    }
  }
  return { meta: out, changed }
}

function saveMeta(meta: Record<string, SessionMeta>) {
  localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(meta))
}

function loadMeta(): Record<string, SessionMeta> {
  try {
    const stored = localStorage.getItem(SESSIONS_STORAGE_KEY)
    if (stored) {
      const { meta, changed } = migrateMeta(JSON.parse(stored))
      if (changed) saveMeta(meta)
      return meta
    }
  } catch {
    // ignore
  }
  return {}
}

// Tab and pane picked on this device, for backends where selecting does not
// touch the server (herdr). Kept per backend.
interface Selection {
  tabId: string
  // Group of that tab, so a closed tab falls back within its workspace.
  groupId?: string
  paneId?: string
}

const selectionKey = (backend: string) => `termote-selection-${backend}`

function loadSelection(backend: string): Selection | null {
  try {
    const stored = localStorage.getItem(selectionKey(backend))
    if (stored) return JSON.parse(stored)
  } catch {
    // ignore
  }
  return null
}

function saveSelection(backend: string, sel: Selection) {
  localStorage.setItem(selectionKey(backend), JSON.stringify(sel))
}

const sameSelection = (a: Selection | null, b: Selection) =>
  a?.tabId === b.tabId && a.groupId === b.groupId && a.paneId === b.paneId

// Point a tab at one of its panes.
function withPane(session: Session, paneId: string | undefined): Session {
  const pane = session.panes?.find((p) => p.id === paneId)
  return { ...session, paneId, hasAgent: !!pane?.hasAgent }
}

interface Built {
  sessions: Session[]
  groups: SessionGroup[]
  // Tab the server reports as current (first one for herdr, which has one
  // per workspace).
  serverActive: Session | null
}

// Flatten the snapshot into tabs (each tagged with its group) and groups.
function buildSessions(
  snap: MuxSnapshot,
  meta: Record<string, SessionMeta>,
): Built {
  const sessions: Session[] = []
  const groups: SessionGroup[] = []
  let serverActive: Session | null = null
  for (const g of snap.groups || []) {
    const groupTabs: Session[] = []
    for (const tab of g.tabs) {
      const m = meta[metaKey(snap.backend, tab.id, tab.name)] || DEFAULT_META
      const panes: SessionPane[] = tab.panes.map((p, i) => ({
        id: p.id,
        label: p.agent?.name || p.title || `Pane ${i + 1}`,
        hasAgent: !!p.agent,
        agentStatus: toAgentStatus(p.agent?.status),
      }))
      const pane = tab.panes.find((p) => p.active) ?? tab.panes[0]
      const session: Session = {
        id: tab.id,
        name: tab.name,
        icon: m.icon,
        description: m.description,
        groupId: g.id,
        paneId: pane?.id,
        hasAgent: !!pane?.agent,
        panes,
        agentStatus: worstAgentStatus(panes.map((p) => p.agentStatus)),
      }
      groupTabs.push(session)
      if (tab.active && !serverActive) serverActive = session
    }
    sessions.push(...groupTabs)
    groups.push({
      id: g.id,
      name: g.name,
      agentStatus: worstAgentStatus(groupTabs.map((t) => t.agentStatus)),
    })
  }
  return { sessions, groups, serverActive }
}

export function useLocalSessions(pollInterval = 5) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [groups, setGroups] = useState<SessionGroup[]>([])
  const [activeSession, setActiveSession] = useState<Session | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [isServerReachable, setIsServerReachable] = useState(true)
  const [mux, setMux] = useState<MuxInfo>(DEFAULT_MUX)
  const metaRef = useRef<Record<string, SessionMeta>>(loadMeta())
  const muxRef = useRef<MuxInfo>(DEFAULT_MUX)
  const selectionRef = useRef<Selection | null>(null)
  // Bumped on every client-side pick; a snapshot requested before the
  // latest pick must not undo it.
  const selectionVersionRef = useRef(0)
  const isReadyRef = useRef(false)

  const storeSelection = useCallback((sel: Selection) => {
    selectionRef.current = sel
    saveSelection(muxRef.current.backend, sel)
  }, [])

  // Remember a client-side pick and show it.
  const select = useCallback(
    (session: Session, paneId?: string) => {
      selectionVersionRef.current++
      storeSelection({ tabId: session.id, groupId: session.groupId, paneId })
      setActiveSession(withPane(session, paneId))
    },
    [storeSelection],
  )

  // Apply a snapshot to session state. tmux follows the server's current
  // window (every client shares it); herdr keeps this device's own pick.
  const applySnapshot = useCallback(
    (snap: MuxSnapshot, version: number) => {
      const built = buildSessions(snap, metaRef.current)
      setSessions(built.sessions)
      setGroups(built.groups)
      const fallback = built.serverActive ?? built.sessions[0] ?? null
      if (!snap.caps.clientSideSelect) {
        setActiveSession(fallback)
        return
      }
      if (version !== selectionVersionRef.current) return
      selectionRef.current ??= loadSelection(snap.backend)
      const sel = selectionRef.current
      // A tab that is gone gives way to another of its group, then to the
      // server's pick. Whatever is shown is stored, so later polls do not
      // follow the desktop around.
      const picked =
        built.sessions.find((s) => s.id === sel?.tabId) ??
        built.sessions.find((s) => sel?.groupId && s.groupId === sel.groupId) ??
        fallback
      if (!picked) {
        setActiveSession(null)
        return
      }
      const paneId =
        picked.id === sel?.tabId &&
        picked.panes?.some((p) => p.id === sel.paneId)
          ? sel.paneId
          : picked.paneId
      const next = { tabId: picked.id, groupId: picked.groupId, paneId }
      if (!sameSelection(sel, next)) storeSelection(next)
      setActiveSession(withPane(picked, paneId))
    },
    [storeSelection],
  )

  // Fetch sessions from mux API
  const refreshSessions = useCallback(async () => {
    const version = selectionVersionRef.current
    try {
      let snap = await fetchSnapshot()
      const hasTabs = (s: MuxSnapshot) =>
        (s.groups || []).some((g) => g.tabs.length > 0)
      if (!hasTabs(snap)) {
        await createTab('shell')
        snap = await fetchSnapshot()
      }
      const next: MuxInfo = { backend: snap.backend, caps: snap.caps }
      muxRef.current = next
      setMux((prev) =>
        prev.backend === next.backend &&
        prev.caps.clientSideSelect === next.caps.clientSideSelect &&
        prev.caps.copyMode === next.caps.copyMode
          ? prev
          : next,
      )
      applySnapshot(snap, version)
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
  }, [applySnapshot])

  // Initial fetch and periodic refresh
  useEffect(() => {
    refreshSessions()
    const ms = Math.max(pollInterval, 1) * 1000
    const interval = setInterval(refreshSessions, ms)
    return () => clearInterval(interval)
  }, [refreshSessions, pollInterval])

  // paneId (client-side select only) picks a pane of that tab; an unknown one
  // falls back to the tab's own.
  const switchSession = useCallback(
    async (sessionId: string, paneId?: string) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return
      const isActive = session.id === activeSession?.id
      if (muxRef.current.caps.clientSideSelect) {
        const known = session.panes?.some((p) => p.id === paneId)
        // Picking the tab on screen again keeps the pane it shows.
        if (isActive && (!known || paneId === activeSession.paneId)) return
        select(session, known ? paneId : session.paneId)
        return
      }
      if (isActive) return
      /* v8 ignore next */
      await selectTab(sessionId).catch(() => {})
      setActiveSession(session)
    },
    [sessions, activeSession?.id, activeSession?.paneId, select],
  )

  // Stream another pane of the current tab (client-side select only).
  const selectPane = useCallback(
    (paneId: string) => {
      if (!activeSession || !muxRef.current.caps.clientSideSelect) return
      if (!activeSession.panes?.some((p) => p.id === paneId)) return
      select(activeSession, paneId)
    },
    [activeSession, select],
  )

  const addSession = useCallback(
    async (name: string, icon = '📺', description = '') => {
      const { backend, caps } = muxRef.current
      // tmux keys metadata by name, so it can be saved before the tab exists
      if (backend === 'tmux') {
        metaRef.current[metaKey(backend, '', name)] = { icon, description }
        saveMeta(metaRef.current)
      }

      // Create mux tab in the current group
      const id = await createTab(name, activeSession?.groupId).catch(() => null)
      if (id && backend !== 'tmux') {
        metaRef.current[metaKey(backend, id, name)] = { icon, description }
        saveMeta(metaRef.current)
      }
      // herdr creates tabs in the background; show the new one here
      if (id && caps.clientSideSelect) {
        selectionVersionRef.current++
        storeSelection({ tabId: id, groupId: activeSession?.groupId })
      }

      // Refresh to get new tab
      await refreshSessions()
    },
    [refreshSessions, activeSession?.groupId, storeSelection],
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
      delete metaRef.current[
        metaKey(muxRef.current.backend, session.id, session.name)
      ]
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

      const { backend } = muxRef.current
      const oldKey = metaKey(backend, sessionId, session.name)
      const newKey = metaKey(backend, sessionId, updates.name ?? session.name)
      const oldMeta = metaRef.current[oldKey] || DEFAULT_META

      // If name changed, rename mux tab. A rejected rename (e.g. invalid
      // name) leaves the session and its metadata as is.
      if (updates.name && updates.name !== session.name) {
        const renamed = await renameTab(sessionId, updates.name).catch(
          () => false,
        )
        if (!renamed) return
        if (oldKey !== newKey) delete metaRef.current[oldKey]
      }

      metaRef.current[newKey] = {
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
    groups,
    switchSession,
    selectPane,
    addSession,
    removeSession,
    updateSession,
    isReady,
    isServerReachable,
    refreshSessions,
    mux,
  }
}
