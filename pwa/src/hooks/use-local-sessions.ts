import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import {
  SESSIONS_STORAGE_KEY,
  type Session,
  type SessionGroup,
  type SessionPane,
  toAgentStatus,
  worstAgentStatus,
} from '../types/session'
import { adoptChatDrafts, remapChatDrafts } from '../utils/chat-draft'
import {
  adoptPersisted,
  regroupPersisted,
  renamePersistedGroup,
} from '../utils/files-persist'
import { isFocusWindow } from '../utils/focus-mode'
import {
  isTimeoutError,
  reportLargePacketLoss,
} from '../utils/large-packet-loss'
import {
  type PaneShift,
  paneKeys,
  remapPanes,
  renameGroupKeys,
  setPaneKeys,
  shiftedIds,
  tabPaneMoves,
} from '../utils/pane-remap'
import { setSelectionServer } from '../utils/pane-selection'
import { adoptReviewDrafts, remapReviewDrafts } from '../utils/review-draft'
import { uniqueNames } from '../utils/running-commands'
import { zellijGroupId } from '../utils/zellij-group'
import { renameActivityGroup } from './use-activity-log'
import { hydrateDrafts } from './use-files'
import {
  closeGroup as apiCloseGroup,
  createGroup as apiCreateGroup,
  createWorktree as apiCreateWorktree,
  moveGroup as apiMoveGroup,
  moveTab as apiMoveTab,
  openWorktree as apiOpenWorktree,
  removeWorktree as apiRemoveWorktree,
  renameGroup as apiRenameGroup,
  resizePane as apiResizePane,
  splitPane as apiSplitPane,
  swapPane as apiSwapPane,
  zoomPane as apiZoomPane,
  closePane,
  closeTab,
  createTab,
  fetchHealth,
  fetchSnapshot,
  type MuxSnapshot,
  RequestError,
  type ResizeDirection,
  renameTab,
  type SplitDirection,
  type SwapDirection,
  selectTab,
} from './use-mux-api'
import { setTemplatesServer } from './use-prompt-templates'
import { setUserTasksServer } from './use-user-tasks'

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
// Zellij gives a closed tab's id to the next tab, so its metadata is keyed by
// the tab's key, which is never reused.
const TMUX_META_PREFIX = 'tmux:name:'
const HERDR_META_PREFIX = 'herdr:'
const ZELLIJ_META_PREFIX = 'zellij:'

function metaKey(
  backend: string,
  tabId: string,
  tabName: string,
  groupId?: string,
  tabKey?: string,
): string {
  if (backend === 'zellij') return `${ZELLIJ_META_PREFIX}${tabKey ?? tabId}`
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
    if (
      key.startsWith(TMUX_META_PREFIX) ||
      key.startsWith(HERDR_META_PREFIX) ||
      key.startsWith(ZELLIJ_META_PREFIX)
    ) {
      out[key] = value
    } else {
      out[`${TMUX_META_PREFIX}${key}`] ??= value
      changed = true
    }
  }
  return { meta: out, changed }
}

// Moves the metadata of a renamed Zellij group's tabs to their new keys.
function renameGroupMeta(
  meta: Record<string, SessionMeta>,
  from: string,
  to: string,
) {
  const prefix = `${ZELLIJ_META_PREFIX}${from}/`
  let changed = false
  for (const [key, value] of Object.entries(meta)) {
    if (!key.startsWith(prefix)) continue
    delete meta[key]
    meta[`${ZELLIJ_META_PREFIX}${to}/${key.slice(prefix.length)}`] = value
    changed = true
  }
  if (changed) saveMeta(meta)
}

// A focus window keeps neither (focus-mode.ts)
function saveMeta(meta: Record<string, SessionMeta>) {
  if (isFocusWindow()) return
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
  if (isFocusWindow()) return
  localStorage.setItem(selectionKey(backend), JSON.stringify(sel))
}

const sameSelection = (a: Selection | null, b: Selection) =>
  a?.tabId === b.tabId && a.groupId === b.groupId && a.paneId === b.paneId

// The selection with its tab and pane following a shift of their ids.
function shiftSelection(sel: Selection, shift: PaneShift): Selection {
  const follow = (id?: string) => (id && shift.moved.get(id)) || id
  return { ...sel, tabId: follow(sel.tabId) ?? '', paneId: follow(sel.paneId) }
}

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
// t names a pane with neither an agent nor a title.
export function buildSessions(
  snap: MuxSnapshot,
  meta: Record<string, SessionMeta>,
  t: Translate<MessageKey>,
): Built {
  const sessions: Session[] = []
  const groups: SessionGroup[] = []
  let serverActive: Session | null = null
  const activeByGroup = new Map<string, Session>()
  for (const g of snap.groups || []) {
    const groupTabs: Session[] = []
    for (const tab of g.tabs) {
      const m =
        meta[metaKey(snap.backend, tab.id, tab.name, g.id, tab.key)] ||
        DEFAULT_META
      const panes: SessionPane[] = tab.panes.map((p, i) => ({
        id: p.id,
        label:
          p.agent?.name || p.title || t('dialogs.pane.fallback', { n: i + 1 }),
        hasAgent: !!p.agent,
        agentName: p.agent?.name,
        agentStatus: toAgentStatus(p.agent?.status),
        agentSince: p.agent?.since,
        agentSinceFirstSeen: p.agent?.sinceFirstSeen,
        command: p.process?.name,
      }))
      const pane = tab.panes.find((p) => p.active) ?? tab.panes[0]
      const commands = uniqueNames(
        (tab.processes ?? tab.panes.map((p) => p.process)).map((p) => p?.name),
      )
      const session: Session = {
        id: tab.id,
        key: tab.key ?? tab.id,
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
        ...(tab.layout && { layout: tab.layout }),
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

// The server clock's offset from this device's (ms), from a snapshot's
// serverNow read at now; a change under a second (the reply's way over the
// network) keeps prev, so the state does not change on every poll.
export function nextClockOffset(
  prev: number,
  serverNow: string | undefined,
  now: number,
): number {
  const server = serverNow ? Date.parse(serverNow) : Number.NaN
  if (!Number.isFinite(server)) return prev
  const offset = server - now
  return Math.abs(offset - prev) < 1000 ? prev : offset
}

export function useLocalSessions(pollInterval = 5) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [groups, setGroups] = useState<SessionGroup[]>([])
  const [activeSession, setActiveSession] = useState<Session | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [isServerReachable, setIsServerReachable] = useState(true)
  const [mux, setMux] = useState<MuxInfo>(DEFAULT_MUX)
  // Server time minus this device's (ms): add it to Date.now() to compare
  // with the server's times (an agent's since).
  const [clockOffset, setClockOffset] = useState(0)
  const metaRef = useRef<Record<string, SessionMeta>>(loadMeta())
  // Read at each snapshot, so the poll's callbacks stay as they are
  const { t } = useT()
  const tRef = useRef(t)
  tRef.current = t
  const muxRef = useRef<MuxInfo>(DEFAULT_MUX)
  const selectionRef = useRef<Selection | null>(null)
  // Bumped on every client-side pick; a snapshot requested before the
  // latest pick must not undo it.
  const selectionVersionRef = useRef(0)
  // Each group's current tab on the server, from the latest snapshot
  const currentTabsRef = useRef<Set<string>>(new Set())
  const isReadyRef = useRef(false)
  // A group just created and the snapshots left that may still lack it
  // (Herdr reports a new workspace a little later): until then the pick of
  // its tab is kept rather than replaced.
  const pendingGroupRef = useRef<{ id: string; left: number } | null>(null)
  // Reads still waiting on the network; a timer tick skips while any is,
  // instead of piling another request onto a stalled connection.
  const inFlightRef = useRef(0)
  // Each snapshot read takes the next number; a reply older than the one
  // last applied is dropped (a poll sent before a move, answered after the
  // refresh that followed it, would show the old order again).
  const readSeqRef = useRef(0)
  const appliedSeqRef = useRef(0)
  // Every id of the last snapshot applied, with its key (pane-remap).
  const keysRef = useRef(new Map<string, string>())
  // The servers whose tab-keyed records were adopted (tabPaneMoves)
  const adoptedRef = useRef(new Set<string>())
  // A move is running, until a snapshot read after it is applied; another
  // one meanwhile would be computed on the old order.
  const movingRef = useRef(false)
  const [moving, setMoving] = useState(false)
  // A Zellij group renamed here, until a snapshot without its old id is
  // applied: that one's ids are compared as if the old snapshot had them.
  const renamedGroupRef = useRef<{ from: string; to: string } | null>(null)

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
      // State kept by tab or pane id follows its tab when a move shifted
      // the ids (tmux), or a rename gave its group another id (Zellij),
      // before anything renders with the new ones.
      const keys = paneKeys(snap)
      let prevKeys = keysRef.current
      const renamed = renamedGroupRef.current
      // A snapshot read before the rename still has the old id: not yet.
      if (renamed && !snap.groups?.some((g) => g.id === renamed.from)) {
        renamedGroupRef.current = null
        prevKeys = renameGroupKeys(prevKeys, renamed.from, renamed.to)
        renameGroupMeta(metaRef.current, renamed.from, renamed.to)
        renameActivityGroup(renamed.from, renamed.to)
        renamePersistedGroup(
          renamed.from,
          renamed.to,
          snap.groups?.find((g) => g.id === renamed.to)?.name ?? null,
        )
      }
      const shift = shiftedIds(prevKeys, keys)
      keysRef.current = keys
      // Records kept on the device follow a group renamed elsewhere (tmux,
      // Herdr: the panes' keys stay)
      regroupPersisted(setPaneKeys(snap, keys))
      // Once per server and page: what was kept for a tmux tab's one pane
      // under the tab's id or key goes to its active pane (tabPaneMoves)
      const server = snap.instanceId ?? ''
      if (!adoptedRef.current.has(server)) {
        adoptedRef.current.add(server)
        const moves = tabPaneMoves(snap)
        adoptPersisted(moves.keys)
        adoptChatDrafts(moves.ids)
        adoptReviewDrafts(moves.ids)
      }
      // The templates read belong to one server
      setTemplatesServer(snap.instanceId ?? null, !!snap.caps.templates)
      setUserTasksServer(snap.instanceId ?? null, !!snap.caps.userTasks)
      setSelectionServer(snap.instanceId ?? null)
      if (shift.stale.size) {
        remapPanes(shift)
        remapChatDrafts(shift)
        remapReviewDrafts(shift)
        // Only a snapshot with tabs can shift ids, and applying one stores
        // a selection: this is a guard, never reached in practice.
        /* v8 ignore next */
        if (selectionRef.current) {
          storeSelection(shiftSelection(selectionRef.current, shift))
        }
      }
      // The drafts kept on the device come back before any view reads
      hydrateDrafts(keys.keys(), snap.caps.role)
      const built = buildSessions(snap, metaRef.current, tRef.current)
      currentTabsRef.current = new Set(
        [...built.activeByGroup.values()].map((s) => s.id),
      )
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
    const seq = ++readSeqRef.current
    try {
      let snap = await fetchSnapshot()
      const hasTabs = (s: MuxSnapshot) =>
        (s.groups || []).some((g) => g.tabs.length > 0)
      // A view-only device makes nothing: it waits for a tab to exist.
      if (!hasTabs(snap) && snap.caps.role !== 'view') {
        // A Zellij session no client is attached to gets no tab (no_client)
        await createTab('shell').catch((err) => {
          if (!(err instanceof RequestError)) throw err
        })
        snap = await fetchSnapshot()
      }
      if (seq < appliedSeqRef.current) return
      appliedSeqRef.current = seq
      const next: MuxInfo = { backend: snap.backend, caps: snap.caps }
      muxRef.current = next
      setMux((prev) => (sameMux(prev, next) ? prev : next))
      const now = Date.now()
      setClockOffset((prev) => nextClockOffset(prev, snap.serverNow, now))
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
          // i18n-ignore: a stored description, only searched, never shown
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
  // Resolves to 'view-only' when a view-only device asked for a tab the
  // server would refuse to switch to (tmux: only each session's current
  // window can be watched); nothing changes then.
  const switchSession = useCallback(
    async (
      sessionId: string,
      paneId?: string,
    ): Promise<'view-only' | undefined> => {
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
      // A pane of the tab other than the one shown (or focused) gets
      // tmux's focus too (selectTab takes its %N): the stream shows the
      // whole window.
      const shown = isActive ? activeSession.paneId : session.paneId
      const pane =
        paneId !== undefined &&
        paneId !== shown &&
        session.panes?.some((p) => p.id === paneId)
          ? paneId
          : undefined
      if (isActive && !pane) return
      if (muxRef.current.caps.role === 'view') {
        // Moving the focus is a write
        if (pane || !currentTabsRef.current.has(session.id)) return 'view-only'
        // Another session's current window: shown, nothing switched
        selectionVersionRef.current++
        storeSelection({ tabId: session.id, groupId: session.groupId })
        setActiveSession(session)
        return
      }
      // Show the tab right away: a snapshot requested before the pick, or
      // while the server switches window, must not undo it.
      selectionVersionRef.current++
      storeSelection({ tabId: session.id, groupId: session.groupId })
      setActiveSession(pane ? withPane(session, pane) : session)
      /* v8 ignore next */
      await selectTab(pane ?? sessionId).catch(() => {})
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

  // Show another pane of the current tab. tmux streams the whole window:
  // the pane gets the focus there, which every client shares (never from a
  // view-only device), and the next snapshots follow it.
  const selectPane = useCallback(
    (paneId: string) => {
      if (!activeSession?.panes?.some((p) => p.id === paneId)) return
      const { caps } = muxRef.current
      if (caps.clientSideSelect) {
        select(activeSession, paneId)
        return
      }
      if (caps.role === 'view' || paneId === activeSession.paneId) return
      // Show it right away: a snapshot read before the pick must not undo it
      selectionVersionRef.current++
      setActiveSession(withPane(activeSession, paneId))
      // A failure shows on the next snapshot
      selectTab(paneId)
        .catch(() => {})
        .finally(() => {
          selectionVersionRef.current++
        })
    },
    [activeSession, select],
  )

  // A refusal the user can act on (RequestError 'no_client': Zellij needs a
  // client attached to the session) reaches the caller, after the refresh;
  // other failures show on the next snapshot.
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
      let refusal: RequestError | null = null
      const id = await createTab(name, activeSession?.groupId).catch((err) => {
        if (err instanceof RequestError && err.code === 'no_client') {
          refusal = err
        }
        return null
      })
      if (id && backend !== 'tmux' && backend !== 'zellij') {
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
      if (refusal) throw refusal
      // A Zellij tab's key, which its metadata is kept by, comes with the
      // snapshot: saved now and shown at once.
      const key = id && backend === 'zellij' && keysRef.current.get(id)
      if (key) {
        metaRef.current[metaKey(backend, id, name, undefined, key)] = {
          icon,
          description,
        }
        saveMeta(metaRef.current)
        const withMeta = (s: Session) =>
          s.id === id ? { ...s, icon, description } : s
        setSessions((prev) => prev.map(withMeta))
        setActiveSession((prev) => prev && withMeta(prev))
      }
    },
    [refreshSessions, activeSession?.groupId, storeSelection],
  )

  const removeSession = useCallback(
    async (sessionId: string) => {
      if (sessions.length <= 1) return

      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return

      // Close mux tab, only while the id still names it: a tab whose id a
      // move shifted is refused (RequestError 'changed') for the caller to
      // tell. Other failures show on the next snapshot.
      try {
        await closeTab(sessionId, session.key)
      } catch (err) {
        if (err instanceof RequestError && err.code === 'changed') {
          await refreshSessions()
          throw err
        }
      }

      // Remove metadata
      delete metaRef.current[
        metaKey(
          muxRef.current.backend,
          session.id,
          session.name,
          session.groupId,
          session.key,
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

  // Pane layout, on the pane shown. A refusal (RequestError) reaches the
  // caller once the list was read again: a pane gone leaves it.
  const layoutPane = useCallback(
    async (act: (paneId: string) => Promise<unknown>) => {
      const paneId = activeSession?.paneId
      if (!paneId) return
      try {
        await act(paneId)
      } finally {
        await refreshSessions()
      }
    },
    [activeSession?.paneId, refreshSessions],
  )

  // Splits the pane shown. Where this device picks the pane it streams
  // (Herdr, Zellij) the new pane is shown once listed; tmux leaves the
  // focus, which every client shares, where it was.
  const splitPane = useCallback(
    async (direction: SplitDirection) => {
      const session = activeSession
      if (!session?.paneId) return
      let id = ''
      try {
        id = await apiSplitPane(session.paneId, direction)
      } finally {
        if (id && muxRef.current.caps.clientSideSelect) {
          selectionVersionRef.current++
          storeSelection({
            tabId: session.id,
            groupId: session.groupId,
            paneId: id,
          })
        }
        await refreshSessions()
      }
    },
    [activeSession, storeSelection, refreshSessions],
  )

  const zoomPane = useCallback(
    () => layoutPane((id) => apiZoomPane(id, 'toggle')),
    [layoutPane],
  )
  const swapPane = useCallback(
    (direction: SwapDirection) =>
      layoutPane((id) => apiSwapPane(id, direction)),
    [layoutPane],
  )
  const resizePane = useCallback(
    (direction: ResizeDirection, amount: number) =>
      layoutPane((id) => apiResizePane(id, direction, amount)),
    [layoutPane],
  )

  const updateSession = useCallback(
    async (sessionId: string, updates: Partial<Omit<Session, 'id'>>) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return

      const { backend } = muxRef.current
      const oldKey = metaKey(
        backend,
        sessionId,
        session.name,
        session.groupId,
        session.key,
      )
      const newKey = metaKey(
        backend,
        sessionId,
        updates.name ?? session.name,
        session.groupId,
        session.key,
      )
      const oldMeta = metaRef.current[oldKey] || DEFAULT_META

      // If name changed, rename mux tab. A rejected rename (e.g. invalid
      // name) leaves the session and its metadata as is.
      if (updates.name && updates.name !== session.name) {
        const renamed = await renameTab(
          sessionId,
          updates.name,
          session.key,
        ).catch(() => false)
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

  // A Zellij group's id is made from its name (zellijGroupId), so a rename
  // gives it, and every tab and pane id in it, another id: the state kept by
  // those ids follows them once the snapshot shows the new one. Noted before
  // the request, so a poll answered right after the rename follows it too.
  const renameGroup = useCallback(
    async (id: string, name: string) => {
      const to = zellijGroupId(name)
      const renamed =
        muxRef.current.backend === 'zellij' && to !== id
          ? { from: id, to }
          : null
      if (renamed) renamedGroupRef.current = renamed
      try {
        await apiRenameGroup(id, name)
      } catch (err) {
        if (renamedGroupRef.current === renamed) renamedGroupRef.current = null
        throw err
      }
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
          delete metaRef.current[
            metaKey(backend, s.id, s.name, s.groupId, s.key)
          ]
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

  // Runs one move, then reads a snapshot; another move asked for before
  // that snapshot is applied is ignored. Refusals (RequestError with the
  // server's code) reach the caller.
  const runMove = useCallback(
    async (move: () => Promise<unknown>) => {
      if (movingRef.current) return
      movingRef.current = true
      setMoving(true)
      try {
        await move()
      } finally {
        await refreshSessions()
        movingRef.current = false
        setMoving(false)
      }
    },
    [refreshSessions],
  )

  // Moves a tab to position index of its group.
  const moveTab = useCallback(
    (sessionId: string, index: number) =>
      runMove(() => apiMoveTab(sessionId, index)),
    [runMove],
  )

  // Moves a group to position index among the groups that can move.
  const moveGroup = useCallback(
    (groupId: string, index: number) =>
      runMove(() => apiMoveGroup(groupId, index)),
    [runMove],
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
    splitPane,
    zoomPane,
    swapPane,
    resizePane,
    updateSession,
    createGroup,
    renameGroup,
    closeGroup,
    createWorktree,
    openWorktree,
    showGroup,
    removeWorktree,
    moveTab,
    moveGroup,
    moving,
    isReady,
    isServerReachable,
    refreshSessions,
    mux,
    clockOffset,
  }
}
