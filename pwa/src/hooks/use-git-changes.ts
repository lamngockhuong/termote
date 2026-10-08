import { useCallback, useSyncExternalStore } from 'react'
import { closeTab, openTab, pinTab, type TabBase } from '../utils/file-tabs'
import {
  dropDraft,
  type FilesError,
  filesError,
  isDraftDirty,
} from './use-files'
import {
  type ChangeEntry,
  fetchGitChanges,
  type GitChanges,
  RequestError,
} from './use-mux-api'

// git status of a pane's root, polled while the Changes view shows and the
// page is visible. One store per pane, like the transcript's, so the mobile
// view and the desktop panel share one poll.

export const CHANGES_POLL = 5000
const MAX_BACKOFF = 60000

export type ChangesError =
  | FilesError
  // git took longer than the server allows (a huge repo)
  | 'timeout'

// One side of a changed file: what a diff is opened for
export interface ChangeSide {
  path: string
  // A rename's or copy's source
  orig?: string
  staged: boolean
}

// The side's key: one tab per side, so a file staged and not opens two
export const changeKey = (s: ChangeSide) => `${s.staged}:${s.orig}:${s.path}`

// The entry of the side, matched like the server does
export function findEntry(entries: ChangeEntry[], s: ChangeSide) {
  return entries.find(
    (e) =>
      e.path === s.path &&
      e.orig === s.orig &&
      (s.staged ? e.staged !== '' : e.unstaged !== '' || !!e.conflict),
  )
}

// A diff open in the Changes view. Only the tab shown has a viewer; the
// others keep what it needs to show them again where they were left.
export interface ChangeTab extends TabBase, ChangeSide {
  // The root the side was opened under
  root: string
  // The working tree's file is edited in place of the diff. A poll or a
  // move of the root never ends it: the draft is the file's.
  editing: boolean
  // A sensitive file the user chose to show, for as long as the tab is open
  revealed: boolean
  // Where the diff is scrolled to, kept while its file is edited, and the
  // editor (which starts at the top each time)
  scrollTop?: number
  editScrollTop?: number
}

export interface ChangesState {
  root?: string
  isRepo: boolean
  branch?: string
  entries: ChangeEntry[]
  truncated: boolean
  loaded: boolean
  error?: ChangesError
  // Bumped each time the pane's root moves while the view is open
  rootChanges: number
  // The open diffs, in the order shown, one tab per side
  tabs: ChangeTab[]
  // The tab shown instead of the list; null shows the list
  activeId: string | null
  // Tabs being edited with unsaved changes opened under a root the pane has
  // left, while the user chooses to close or keep them
  pendingRootClose?: string[]
  // The files of the tabs the last poll closed because git no longer lists
  // their side, and a count bumped each time some close
  gone: { count: number; names: string[] }
}

const INITIAL: ChangesState = {
  isRepo: false,
  entries: [],
  truncated: false,
  loaded: false,
  rootChanges: 0,
  tabs: [],
  activeId: null,
  gone: { count: 0, names: [] },
}

// The tab shown, if any
export const activeChangeTab = (s: ChangesState) =>
  s.tabs.find((t) => t.id === s.activeId)

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function changesError(err: unknown): ChangesError {
  return err instanceof RequestError && err.status === 503
    ? 'timeout'
    : filesError(err)
}

interface Store {
  get: () => ChangesState
  subscribe: (fn: () => void) => () => void
  refresh: () => void
  rootChanged: (root: string) => void
  // Opens a side in its tab: the one it has, else the preview tab, else a
  // new one (pinned when asked)
  open: (side: ChangeSide, opts?: { pin?: boolean }) => void
  // Shows tab id, or the list (null)
  activate: (id: string | null) => void
  pin: (id: string) => void
  // Closes tab id; the unsaved changes of its editor are dropped (asked
  // before)
  close: (id: string) => void
  // Edits the working tree's file of tab id (pinning it), or goes back to
  // its diff
  setEditing: (id: string, on: boolean) => void
  // The user chose to show tab id's sensitive file
  setReveal: (id: string) => void
  // Where tab id's diff, or its editor, is scrolled to: kept for when it
  // shows again, without telling readers (no render per scroll event)
  setScroll: (id: string, top: number) => void
  // Tab id's editor saved: back to the diff of what is not staged (the
  // tab that side already has, else this one)
  saved: (id: string) => void
  // The user chose for the tabs in pendingRootClose: close them (and drop
  // their changes) or keep them
  resolveRootClose: (close: boolean) => void
}

function createStore(paneId: string): Store {
  let state = INITIAL
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let again = false
  let failures = 0
  // Bumped when the root moves: an answer to a poll sent for the old one is
  // dropped, so the list never flips back to the previous repo.
  let generation = 0
  // When each tab was last shown, and the ids of new ones
  let clock = 0
  let ids = 0
  // Only an editor holds unsaved changes
  const isDirty = (t: ChangeTab) => t.editing && isDraftDirty(paneId, t.path)
  // No list at all once nothing waits for the user
  const pendingOf = (ids?: string[]) => (ids?.length ? ids : undefined)

  const set = (next: Partial<ChangesState>) => {
    state = { ...state, ...next }
    for (const fn of listeners) fn()
  }

  const apply = (c: GitChanges) => {
    const next = {
      root: c.root,
      isRepo: c.isRepo,
      branch: c.branch,
      entries: c.entries,
      truncated: c.truncated,
    }
    // Nothing changed: no re-render every 5s
    const same =
      state.loaded &&
      !state.error &&
      JSON.stringify(next) ===
        JSON.stringify({
          root: state.root,
          isRepo: state.isRepo,
          branch: state.branch,
          entries: state.entries,
          truncated: state.truncated,
        })
    if (!same) set({ ...next, loaded: true, error: undefined })
    prune()
  }

  // Tabs whose side git no longer lists (committed, staged, reverted)
  // close, unless being edited: the editor's draft is the user's
  function prune() {
    const names: string[] = []
    for (const t of state.tabs) {
      if (t.editing) continue
      if (t.root !== state.root) close(t.id)
      else if (!findEntry(state.entries, t)) {
        close(t.id)
        // Both sides of a file are one file to tell about
        const name = baseName(t.path)
        if (!names.includes(name)) names.push(name)
      }
    }
    if (names.length) set({ gone: { count: state.gone.count + 1, names } })
  }

  // Drops the draft of tab's editor, unless another tab edits the file too
  function dropDraftOf(tab: ChangeTab) {
    if (!tab.editing) return
    const other = state.tabs.some(
      (t) => t !== tab && t.editing && t.path === tab.path,
    )
    if (!other) dropDraft(paneId, tab.path)
  }

  function patchTab(id: string, patch: Partial<ChangeTab>) {
    set({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })
  }

  function open(side: ChangeSide, opts: { pin?: boolean } = {}) {
    const r = openTab(
      state.tabs,
      state.activeId,
      changeKey,
      changeKey(side),
      () => ({
        id: `c${++ids}`,
        pinned: false,
        lastUsed: 0,
        root: state.root ?? '',
        path: side.path,
        orig: side.orig,
        staged: side.staged,
        editing: false,
        revealed: false,
      }),
      opts,
      isDirty,
      ++clock,
    )
    // Tabs closed to make room never had changes; an untouched draft of
    // theirs goes with them
    for (const t of r.closed) dropDraftOf(t)
    const gone = new Set(r.closed.map((t) => t.id))
    set({
      tabs: r.tabs,
      activeId: r.activeId,
      pendingRootClose: pendingOf(
        state.pendingRootClose?.filter((id) => !gone.has(id)),
      ),
    })
  }

  function activate(id: string | null) {
    if (id === null) {
      set({ activeId: null })
      return
    }
    const now = ++clock
    set({
      activeId: id,
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, lastUsed: now } : t)),
    })
  }

  function close(id: string) {
    const tab = state.tabs.find((t) => t.id === id)
    if (!tab) return
    dropDraftOf(tab)
    const r = closeTab(state.tabs, state.activeId, id)
    set({
      tabs: r.tabs,
      activeId: r.activeId,
      pendingRootClose: pendingOf(
        state.pendingRootClose?.filter((p) => p !== id),
      ),
    })
  }

  function saved(id: string) {
    const tab = state.tabs.find((t) => t.id === id)
    if (!tab) return
    const side = { ...tab, staged: false }
    const other = state.tabs.find(
      (t) => t !== tab && changeKey(t) === changeKey(side),
    )
    if (other) {
      patchTab(id, {
        editing: false,
        scrollTop: undefined,
        editScrollTop: undefined,
      })
      activate(other.id)
      return
    }
    // Not pruned now: the status read next says whether that side is left
    patchTab(id, {
      staged: false,
      editing: false,
      scrollTop: undefined,
      editScrollTop: undefined,
    })
  }

  const visible = () => document.visibilityState === 'visible'

  const schedule = (delay: number) => {
    clearTimeout(timer)
    timer = undefined
    if (listeners.size > 0 && visible()) timer = setTimeout(poll, delay)
  }

  // The list starts again from the new root. Tabs opened under another
  // root close, except editors with unsaved changes: the user is asked
  // about them (pendingRootClose), and kept ones show the old root's text.
  function rootChanged(root: string) {
    if (root === state.root) return
    generation++
    for (const t of state.tabs) if (t.root !== root && !isDirty(t)) close(t.id)
    // Every tab still of another root: one asked about before that is of
    // this root again (the pane came back) is no longer asked about
    const asked = state.tabs.filter((t) => t.root !== root).map((t) => t.id)
    set({
      root,
      entries: [],
      loaded: false,
      rootChanges: state.rootChanges + 1,
      pendingRootClose: pendingOf(asked),
    })
    refresh()
  }

  function failed(err: unknown) {
    if (err instanceof RequestError && err.status === 409 && err.root) {
      rootChanged(err.root)
      return
    }
    failures++
    set({ loaded: true, error: changesError(err) })
  }

  async function poll() {
    // A page shown again, or a reader added, mid-poll: one more right after
    if (inFlight) {
      again = true
      return
    }
    inFlight = true
    const gen = generation
    try {
      const res = await fetchGitChanges(paneId, state.root)
      if (gen === generation) apply(res)
      failures = 0
    } catch (err) {
      // A failure for the old root is dropped too: the next poll reads the new
      if (gen === generation) failed(err)
    } finally {
      inFlight = false
    }
    const delay = again
      ? 0
      : Math.min(CHANGES_POLL * 2 ** Math.max(0, failures - 1), MAX_BACKOFF)
    again = false
    schedule(delay)
  }

  function refresh() {
    // Mid-poll, a timer set now would be replaced when the poll ends.
    if (inFlight) again = true
    else schedule(0)
  }

  // Hidden: the pending poll is dropped; visible again: poll now.
  const onVisibility = () => schedule(0)

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn)
      if (listeners.size === 1) {
        document.addEventListener('visibilitychange', onVisibility)
        schedule(0)
      }
      return () => {
        listeners.delete(fn)
        if (listeners.size === 0) {
          clearTimeout(timer)
          timer = undefined
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }
    },
    refresh,
    rootChanged,
    open,
    activate,
    pin: (id) => set({ tabs: pinTab(state.tabs, id) }),
    close,
    setEditing(id, on) {
      const tab = state.tabs.find((t) => t.id === id)
      if (!tab) return
      patchTab(id, {
        editing: on,
        // The editor starts at the top; the diff stays where it was
        editScrollTop: undefined,
        pinned: tab.pinned || on,
      })
      // Back to a diff git no longer lists: the tab goes
      if (!on && state.loaded) prune()
    },
    setReveal: (id) => patchTab(id, { revealed: true }),
    setScroll(id, top) {
      const tab = state.tabs.find((t) => t.id === id)
      if (!tab) return
      if (tab.editing) tab.editScrollTop = top
      else tab.scrollTop = top
    },
    saved,
    resolveRootClose(closing) {
      const ids = state.pendingRootClose ?? []
      set({ pendingRootClose: undefined })
      if (closing) for (const id of ids) close(id)
    },
  }
}

const stores = new Map<string, Store>()

function storeFor(paneId: string): Store {
  let s = stores.get(paneId)
  if (!s) {
    s = createStore(paneId)
    stores.set(paneId, s)
  }
  return s
}

// The changes of paneId's root, polled every CHANGES_POLL while a component
// shows them and the page is visible; failures back off up to a minute.
export function useGitChanges(paneId: string) {
  const store = storeFor(paneId)
  const state = useSyncExternalStore(store.subscribe, store.get)
  return {
    ...state,
    active: activeChangeTab(state),
    refresh: useCallback(() => store.refresh(), [store]),
    rootChanged: useCallback((r: string) => store.rootChanged(r), [store]),
    open: useCallback(
      (s: ChangeSide, opts?: { pin?: boolean }) => store.open(s, opts),
      [store],
    ),
    activate: useCallback((id: string | null) => store.activate(id), [store]),
    pin: useCallback((id: string) => store.pin(id), [store]),
    close: useCallback((id: string) => store.close(id), [store]),
    setEditing: useCallback(
      (id: string, on: boolean) => store.setEditing(id, on),
      [store],
    ),
    setReveal: useCallback((id: string) => store.setReveal(id), [store]),
    setScroll: useCallback(
      (id: string, top: number) => store.setScroll(id, top),
      [store],
    ),
    saved: useCallback((id: string) => store.saved(id), [store]),
    resolveRootClose: useCallback(
      (close: boolean) => store.resolveRootClose(close),
      [store],
    ),
  }
}

// For tests: forget every store.
export function resetGitChangesStores() {
  stores.clear()
}
