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
  isTimeoutError,
  reportLargePacketLoss,
} from '../utils/large-packet-loss'
import { uniqueNames } from '../utils/running-commands'
import {
  closeGroup as apiCloseGroup,
  createGroup as apiCreateGroup,
  createWorktree as apiCreateWorktree,
  openWorktree as apiOpenWorktree,
  removeWorktree as apiRemoveWorktree,
  renameGroup as apiRenameGroup,
  closePane,
  closeTab,
  createTab,
  fetchHealth,
  fetchSnapshot,
  type MuxSnapshot,
  RequestError,
  renameTab,
  selectTab,
} from './use-mux-api'

export type MuxInfo = Pick<MuxSnapshot, 'backend' | 'caps'>

const DEFAULT_MUX: MuxInfo = {
  backend: 'tmux',
  caps: { clientSideSelect: false, copyMode: true },
}

// The snapshot's backend and caps, compared field by field: a cap the bundle
// learns about later (agentChat) must reach the state too.
function sameMux(a: MuxInfo, b: MuxInfo): boolean {
  if (a.backend !== b.backend) return false
  const keys = new Set([...Object.keys(a.caps), ...Object.keys(b.caps)])
  return [...keys].every(
    (k) =>
      a.caps[k as keyof MuxInfo['caps']] === b.caps[k as keyof MuxInfo['caps']],
  )
}

// Store metadata (icon, description) in localStorage since the mux only stores tab names
interface SessionMeta {
  icon: string
  description: string
}

const DEFAULT_META: SessionMeta = { icon: '📺', description: '' }

// tmux keys metadata by window name, as 0.x did, so it survives window
// renumbering; other backends have stable tab ids. A window of a session
// other than the default one (group id "$N", which a rename keeps) is keyed
// by that id too, so two "shell" windows in two sessions keep their own; the
// default session (whose group id never starts with '$') keeps the 0.x key.
const TMUX_META_PREFIX = 'tmux:name:'
const HERDR_META_PREFIX = 'herdr:'

function metaKey(
  backend: string,
  tabId: string,
  tabName: string,
  groupId?: string,
): string {
  if (backend !== 'tmux') return `${backend}:${tabId}`
  return groupId?.startsWith('$')
    ? `${TMUX_META_PREFIX}${groupId}\u0000${tabName}`
    : `${TMUX_META_PREFIX}${tabName}`
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

// Tab and pane picked on this device, kept per backend. herdr keeps all of
// it; tmux keeps only the group (session), since the window shown is the
// session's current one, shared by every client attached to it.
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
  return {
    ...session,
    paneId,
    hasAgent: !!pane?.hasAgent,
    agentName: pane?.agentName,
  }
}

interface Built {
  sessions: Session[]
  groups: SessionGroup[]
  // Tab the server reports as current (first one for herdr, which has one
  // per workspace).
  serverActive: Session | null
  // Current tab of each group (its first tab when none is), by group id.
  activeByGroup: Map<string, Session>
}

// Flatten the snapshot into tabs (each tagged with its group) and groups.
export function buildSessions(
  snap: MuxSnapshot,
  meta: Record<string, SessionMeta>,
): Built {
  const sessions: Session[] = []
  const groups: SessionGroup[] = []
  let serverActive: Session | null = null
  const activeByGroup = new Map<string, Session>()
  for (const g of snap.groups || []) {
    const groupTabs: Session[] = []
    for (const tab of g.tabs) {
      const m =
        meta[metaKey(snap.backend, tab.id, tab.name, g.id)] || DEFAULT_META
      const panes: SessionPane[] = tab.panes.map((p, i) => ({
        id: p.id,
        label: p.agent?.name || p.title || `Pane ${i + 1}`,
        hasAgent: !!p.agent,
        agentName: p.agent?.name,
        agentStatus: toAgentStatus(p.agent?.status),
        command: p.process?.name,
      }))
      const pane = tab.panes.find((p) => p.active) ?? tab.panes[0]
      const commands = uniqueNames(
        (tab.processes ?? tab.panes.map((p) => p.process)).map((p) => p?.name),
      )
      const session: Session = {
        id: tab.id,
        name: tab.name,
        icon: m.icon,
        description: m.description,
        groupId: g.id,
        paneId: pane?.id,
        hasAgent: !!pane?.agent,
        agentName: pane?.agent?.name,
        panes,
        agentStatus: worstAgentStatus(panes.map((p) => p.agentStatus)),
        commands: commands.length ? commands : undefined,
      }
      groupTabs.push(session)
      if (tab.active && !serverActive) serverActive = session
      if (tab.active && !activeByGroup.has(g.id))
        activeByGroup.set(g.id, session)
    }
    if (groupTabs[0] && !activeByGroup.has(g.id))
      activeByGroup.set(g.id, groupTabs[0])
    sessions.push(...groupTabs)
    groups.push({
      id: g.id,
      name: g.name,
      agentStatus: worstAgentStatus(groupTabs.map((t) => t.agentStatus)),
      ...(g.worktree && { worktree: g.worktree }),
    })
  }
  return { sessions, groups, serverActive, activeByGroup }
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
  // A group just created and the snapshots left that may still lack it
  // (Herdr reports a new workspace a little later): until then the pick of
  // its tab is kept rather than replaced.
  const pendingGroupRef = useRef<{ id: string; left: number } | null>(null)
  // Reads still waiting on the network; a timer tick skips while any is,
  // instead of piling another request onto a stalled connection.
  const inFlightRef = useRef(0)

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

  // Apply a snapshot to session state. tmux keeps this device's session and
  // follows that session's current window (every client of it shares it);
  // herdr keeps this device's own pick.
  const applySnapshot = useCallback(
    (snap: MuxSnapshot, version: number) => {
      const built = buildSessions(snap, metaRef.current)
      setSessions(built.sessions)
      setGroups(built.groups)
      const fallback = built.serverActive ?? built.sessions[0] ?? null
      if (version !== selectionVersionRef.current) return
      const pending = pendingGroupRef.current
      if (pending) {
        if (
          built.groups.some((g) => g.id === pending.id) ||
          --pending.left <= 0
        ) {
          pendingGroupRef.current = null
        } else return
      }
      selectionRef.current ??= loadSelection(snap.backend)
      const sel = selectionRef.current
      if (!snap.caps.clientSideSelect) {
        // A session that is gone gives way to the first one, the default.
        const picked =
          (sel?.groupId && built.activeByGroup.get(sel.groupId)) ||
          (built.groups[0] && built.activeByGroup.get(built.groups[0].id)) ||
          fallback
        if (picked && picked.groupId !== sel?.groupId) {
          storeSelection({ tabId: picked.id, groupId: picked.groupId })
        }
        setActiveSession(picked)
        return
      }
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
    inFlightRef.current++
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
      setMux((prev) => (sameMux(prev, next) ? prev : next))
      applySnapshot(snap, version)
      setIsReady(true)
      isReadyRef.current = true
      setIsServerReachable(true)
    } catch (err) {
      console.warn('[mux] API not available:', err)
      setIsServerReachable(false)
      // The snapshot timed out: a health reply (a few hundred bytes) that
      // still arrives means only the large reply was lost on the way.
      if (isTimeoutError(err)) {
        fetchHealth().then(reportLargePacketLoss, () => {})
      }
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
    } finally {
      inFlightRef.current--
    }
  }, [applySnapshot])

  // Initial fetch and periodic refresh
  useEffect(() => {
    refreshSessions()
    const ms = Math.max(pollInterval, 1) * 1000
    const interval = setInterval(() => {
      if (inFlightRef.current === 0) refreshSessions()
    }, ms)
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
      // Show the tab right away: a snapshot requested before the pick, or
      // while the server switches window, must not undo it.
      selectionVersionRef.current++
      storeSelection({ tabId: session.id, groupId: session.groupId })
      setActiveSession(session)
      /* v8 ignore next */
      await selectTab(sessionId).catch(() => {})
      selectionVersionRef.current++
    },
    [
      sessions,
      activeSession?.id,
      activeSession?.paneId,
      select,
      storeSelection,
    ],
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
        metaRef.current[metaKey(backend, '', name, activeSession?.groupId)] = {
          icon,
          description,
        }
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
        metaKey(
          muxRef.current.backend,
          session.id,
          session.name,
          session.groupId,
        )
      ]
      saveMeta(metaRef.current)

      // Refresh to update list
      await refreshSessions()
    },
    [sessions, refreshSessions],
  )

  // Close a pane of the current tab, never its last one (that is closing the
  // tab). A closed pane on screen gives way to the tab's own on refresh.
  const removePane = useCallback(
    async (paneId: string) => {
      const panes = activeSession?.panes ?? []
      if (panes.length < 2 || !panes.some((p) => p.id === paneId)) return
      /* v8 ignore next */
      await closePane(paneId).catch(() => {})
      await refreshSessions()
    },
    [activeSession?.panes, refreshSessions],
  )

  const updateSession = useCallback(
    async (sessionId: string, updates: Partial<Omit<Session, 'id'>>) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return

      const { backend } = muxRef.current
      const oldKey = metaKey(backend, sessionId, session.name, session.groupId)
      const newKey = metaKey(
        backend,
        sessionId,
        updates.name ?? session.name,
        session.groupId,
      )
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

  // Show a group once a snapshot has it, unless show says no by then (the
  // dialog was closed meanwhile).
  const showNewGroup = useCallback(
    async (id: string, show: () => boolean) => {
      if (!id || !show()) {
        await refreshSessions()
        return
      }
      selectionVersionRef.current++
      pendingGroupRef.current = { id, left: 3 }
      storeSelection({ tabId: '', groupId: id })
      await refreshSessions()
    },
    [refreshSessions, storeSelection],
  )

  // Open a group and show its first tab once a snapshot has it, unless show
  // says no by then (the dialog was cancelled meanwhile). Refusals
  // (RequestError with the server's code) reach the caller.
  const createGroup = useCallback(
    async (name: string, cwd = '', show: () => boolean = () => true) => {
      const id = await apiCreateGroup(name, cwd)
      await showNewGroup(id, show)
    },
    [showNewGroup],
  )

  const renameGroup = useCallback(
    async (id: string, name: string) => {
      await apiRenameGroup(id, name)
      await refreshSessions()
    },
    [refreshSessions],
  )

  // A worktree change Herdr may still be making (unknown) is followed by a
  // snapshot anyway, so the list shows what happened.
  const refreshOnUnknown = useCallback(
    async (err: unknown) => {
      if (err instanceof RequestError && err.code === 'unknown') {
        await refreshSessions()
      }
      throw err
    },
    [refreshSessions],
  )

  // Create a worktree workspace from groupId's repository and show it.
  const createWorktree = useCallback(
    async (
      w: { groupId: string; branch: string; base: string; label: string },
      show: () => boolean = () => true,
    ) => {
      const id = await apiCreateWorktree(w).catch(refreshOnUnknown)
      await showNewGroup(id, show)
    },
    [refreshOnUnknown, showNewGroup],
  )

  // Open an existing worktree of groupId's repository and show it.
  const openWorktree = useCallback(
    async (
      groupId: string,
      branch: string,
      show: () => boolean = () => true,
    ) => {
      const id = await apiOpenWorktree(groupId, branch).catch(refreshOnUnknown)
      await showNewGroup(id, show)
    },
    [refreshOnUnknown, showNewGroup],
  )

  // Show a group that is already open.
  const showGroup = useCallback(
    (id: string) => showNewGroup(id, () => true),
    [showNewGroup],
  )

  const forgetGroup = useCallback(
    (id: string) => {
      const { backend } = muxRef.current
      for (const s of sessions) {
        if (s.groupId === id) {
          delete metaRef.current[metaKey(backend, s.id, s.name, s.groupId)]
        }
      }
      saveMeta(metaRef.current)
    },
    [sessions],
  )

  // Close a group with everything in it. When it is the one on screen, the
  // next snapshot shows the first group left.
  const closeGroup = useCallback(
    async (id: string) => {
      await apiCloseGroup(id)
      forgetGroup(id)
      await refreshSessions()
    },
    [forgetGroup, refreshSessions],
  )

  // Remove a worktree workspace: its checkout is deleted and the workspace
  // closed, like closeGroup.
  const removeWorktree = useCallback(
    async (id: string, w: { force: boolean; path: string; branch: string }) => {
      await apiRemoveWorktree(id, w).catch(refreshOnUnknown)
      forgetGroup(id)
      await refreshSessions()
    },
    [forgetGroup, refreshOnUnknown, refreshSessions],
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
    removePane,
    updateSession,
    createGroup,
    renameGroup,
    closeGroup,
    createWorktree,
    openWorktree,
    showGroup,
    removeWorktree,
    isReady,
    isServerReachable,
    refreshSessions,
    mux,
  }
}
