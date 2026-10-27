import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { TableOp } from '../utils/csv-edits'
import type { Delimiter } from '../utils/csv-parse'
import { isFileEncoding } from '../utils/file-encoding'
import {
  closeTab,
  openTab,
  pinTab,
  retargetTabs,
  type TabBase,
} from '../utils/file-tabs'
import {
  clearDrafts,
  loadDrafts,
  loadRecent,
  loadTabs,
  onDraftChangedElsewhere,
  onSignedOutElsewhere,
  onSignedOutHere,
  persistKey,
  RECENT_LIMIT,
  type RecentFile,
  removeDraft,
  saveRecent,
  saveTabs,
  writeDraft,
} from '../utils/files-persist'
import type { LinkPath } from '../utils/markdown-links'
import { onPaneRemap, remapEntries } from '../utils/pane-remap'
import {
  persistedFilesState,
  restoredCounters,
  restoreFilesState,
} from '../utils/persisted-tabs'
import type { TableLayout } from '../utils/table-columns'
import {
  type FileEncoding,
  type FileEntry,
  type FilesTree,
  fetchFilesTree,
  RequestError,
} from './use-mux-api'

// The file tree under a pane's root, read one directory at a time as the user
// opens them. One store per pane serves the Files view in either place it
// shows (the mobile view, the desktop panel), so moving between them keeps
// what was open.

export type FilesError =
  // The backend cannot report the pane's directory
  | 'unsupported'
  | 'not-found'
  // A directory termote never serves, or one the server cannot read
  | 'not-allowed'
  // A view-only device reads files in a git repository only
  | 'view-only'
  // The request failed (network, server)
  | 'unavailable'

export function filesError(err: unknown): FilesError {
  if (!(err instanceof RequestError)) return 'unavailable'
  if (err.status === 501) return 'unsupported'
  if (err.status === 404) return 'not-found'
  if (err.status === 403) {
    return err.code === 'view_only' ? 'view-only' : 'not-allowed'
  }
  return 'unavailable'
}

export interface DirState {
  entries?: FileEntry[]
  truncated?: boolean
  loading: boolean
  error?: FilesError
}

// A file open in the Files view. Only the tab shown has a viewer; the
// others keep what it needs to show them again where they were left.
export interface FileTab extends TabBase {
  // The root the file was opened under
  root: string
  path: string
  // Where the file starts: a heading, or the offset it was left at
  anchor?: string
  scrollTop?: number
  // A search result's line (1-based) and column (UTF-16 units) the file
  // opens at, dropped like anchor; jump is bumped at each pick, so picking
  // the same line again moves there again
  line?: number
  col?: number
  jump?: number
  // A CSV/TSV table's column widths and wrapped columns, with the scroll
  // offset they were left at; another path starts over
  table?: TableLayout
  // Files of this tab left by following a link, the latest last: Back
  // returns to them. reveal: a sensitive file the user had chosen to show,
  // never kept on the device
  history: { path: string; scrollTop: number; reveal?: boolean }[]
  // A sensitive file the user chose to show; starts over with another path
  reveal: boolean
  // Opens straight into editing: a file this view just created. Dropped
  // once editing starts or the tab shows another path.
  intent?: boolean
}

export interface FilesState {
  root?: string
  isRepo: boolean
  // Directories read so far, by path ("" is the root)
  dirs: Record<string, DirState>
  expanded: Record<string, boolean>
  // The open files, in the order shown, one tab per path
  tabs: FileTab[]
  // The tab shown instead of the tree; null shows the tree
  activeId: string | null
  // Tabs with unsaved changes opened under a root the pane has left, while
  // the user chooses to close or keep them
  pendingRootClose?: string[]
  // Bumped each time the pane's root moves while the view is open
  rootChanges: number
  // Files the user opened lately, the latest first (kept on the device)
  recent: RecentFile[]
}

const INITIAL: FilesState = {
  isRepo: false,
  dirs: {},
  expanded: {},
  tabs: [],
  activeId: null,
  rootChanges: 0,
  recent: [],
}

// The tab shown, if any
export const activeTab = (s: FilesState) =>
  s.tabs.find((t) => t.id === s.activeId)

export interface FileOpenOptions {
  // A tab of its own, kept until closed (else the preview tab)
  pin?: boolean
  // Where the file starts: a heading
  anchor?: string
  // Where the file starts: a search result's line and column
  line?: number
  col?: number
}

export interface FollowOptions {
  // Ctrl/Cmd+click, middle click, long press: a new pinned tab
  newTab?: boolean
  // Followed from another view: opened like a file picked in the tree
  fresh?: boolean
}

export const joinPath = (dir: string, name: string) =>
  dir ? `${dir}/${name}` : name

// A directory, or a symlink inside the root that leads to one
export const isDir = (e: FileEntry) => e.type === 'dir' || e.target === 'dir'

// Neither a file nor a directory that can be opened: a device, a socket, a
// symlink that is broken or leaves the root
export const isOpenable = (e: FileEntry) =>
  isDir(e) || e.type === 'file' || e.target === 'file'

// What following a link did. 'stale': the root moved meanwhile, nothing done
export type FollowResult = 'opened' | 'missing' | 'failed' | 'stale'

// What to tell the user when a link went nowhere
export const FOLLOW_NOTICES: Partial<Record<FollowResult, string>> = {
  missing: 'Not found',
  failed: "This link can't be opened",
}

interface Store {
  get: () => FilesState
  subscribe: (fn: () => void) => () => void
  // Reads the root once there is a reader
  load: () => void
  toggle: (path: string) => void
  refresh: () => void
  // The pane's id changed (a tmux window move): reads go to the new one,
  // and the directories read are read again
  moveTo: (paneId: string) => void
  // Opens a file in its tab: the one it has, else the preview tab, else a
  // new one (pinned when asked)
  open: (path: string, opts?: FileOpenOptions) => void
  // Shows tab id, or the tree (null)
  activate: (id: string | null) => void
  pin: (id: string) => void
  // Closes tab id; its unsaved changes are dropped (asked before)
  close: (id: string) => void
  // Follows a link of the tab shown (left at scrollTop): a file opens in
  // that tab (or the one it has), a directory shows in the tree, opened
  follow: (
    target: LinkPath,
    scrollTop: number,
    opts?: FollowOptions,
  ) => Promise<FollowResult>
  // Back to the file of this tab a link was followed from, else to the
  // tree (the tab stays open)
  back: () => void
  // Where tab id is scrolled to: kept for when it shows again, without
  // telling readers (no render per scroll event)
  setScroll: (id: string, top: number) => void
  // Tab id's table layout: kept like its scroll offset
  setTableLayout: (id: string, layout: TableLayout) => void
  // The user chose to show tab id's sensitive file
  setReveal: (id: string) => void
  // The user chose for the tabs in pendingRootClose: close them (and drop
  // their changes) or keep them
  resolveRootClose: (close: boolean) => void
  // A file just created at path under root (or found there): the tree is
  // read again and opened down to it, then it opens into editing; a
  // directory found there shows in the tree, opened
  created: (path: string, root: string, reveal: boolean) => Promise<void>
  // Another request saw the root move to root
  rootChanged: (root: string) => void
  // A file found by a search of root (the command palette): the store
  // moves to that root first when it is not on it, then opens the file
  openFromFind: (root: string, path: string, opts?: FileOpenOptions) => void
  // A search result chosen: the tree opened down to it and, for a file, the
  // file opened (a new trail of links); a directory shows in the tree
  reveal: (path: string, kind?: 'file' | 'dir') => Promise<void>
  // The directory read again: what it holds now
  list: (path: string) => Promise<DirState>
  // path was deleted: its tab closed (every one under it, for a directory),
  // gone from the tree
  deleted: (path: string) => void
  // path was put back: the tree opened down to it, read again; what is
  // open stays open
  restored: (path: string) => Promise<void>
  // from was renamed to to: its tabs show to, the tree is read again
  renamed: (from: string, to: string, reveal: boolean) => void
}

function createStore(id: string): Store {
  let paneId = id
  // The tabs kept on the device for the pane, as it was left: the first
  // read sends their root, and a pane that moved meanwhile answers 409
  // (rootChanged)
  const fromDevice = restoreFilesState(loadTabs('files', paneId))
  const recent = loadRecent(paneId)
  let state: FilesState = fromDevice
    ? {
        ...INITIAL,
        root: fromDevice.root,
        tabs: fromDevice.tabs.map((t) => ({ ...t, reveal: false })),
        activeId: fromDevice.activeId,
        pendingRootClose: fromDevice.pendingRootClose,
        recent,
      }
    : { ...INITIAL, recent }
  const listeners = new Set<() => void>()
  // Bumped when the root moves: a read sent for the old one is dropped.
  let generation = 0
  // When each tab was last shown, and the ids of new ones
  let { clock, ids } = restoredCounters(state.tabs)
  const isDirty = (t: FileTab) => isDraftDirty(paneId, t.path)

  // Kept on the device after every change of the tabs (and of where they
  // are scrolled to, which renders nothing)
  const persist = () => saveTabs('files', paneId, persistedFilesState(state))
  // Written again once opened: tabs left as they are never expire
  if (fromDevice) persist()

  const set = (next: Partial<FilesState>) => {
    const prev = state
    state = { ...state, ...next }
    if (
      state.tabs !== prev.tabs ||
      state.activeId !== prev.activeId ||
      state.root !== prev.root ||
      state.pendingRootClose !== prev.pendingRootClose
    )
      persist()
    for (const fn of listeners) fn()
  }
  const setDir = (path: string, dir: DirState) =>
    set({ dirs: { ...state.dirs, [path]: dir } })

  async function read(path: string) {
    const gen = generation
    setDir(path, { ...state.dirs[path], loading: true })
    let tree: FilesTree
    try {
      tree = await fetchFilesTree(paneId, path, state.root)
    } catch (err) {
      if (gen !== generation) return
      if (err instanceof RequestError && err.status === 409 && err.root) {
        rootChanged(err.root)
        return
      }
      const { [path]: _, ...expanded } = state.expanded
      setDir(path, { loading: false, error: filesError(err) })
      if (path) set({ expanded })
      return
    }
    if (gen !== generation) return
    set({ root: tree.root, isRepo: tree.isRepo })
    setDir(path, {
      entries: tree.entries,
      truncated: tree.truncated,
      loading: false,
    })
  }

  // The files opened lately, changed and kept on the device
  function setRecent(files: RecentFile[]) {
    set({ recent: files })
    saveRecent(paneId, files)
  }

  // The user opened path under the root: first in the list
  function remember(path: string) {
    const root = state.root
    if (root === undefined) return
    setRecent(
      [
        { root, path },
        ...state.recent.filter((f) => f.root !== root || f.path !== path),
      ].slice(0, RECENT_LIMIT),
    )
  }

  // Out of the list: path under root, and what is under it
  function forget(root: string, path: string) {
    const files = state.recent.filter(
      (f) =>
        f.root !== root || (f.path !== path && !f.path.startsWith(`${path}/`)),
    )
    if (files.length !== state.recent.length) setRecent(files)
  }

  // Opened by the user (not restored or created): remembered, unless its
  // tab shows it as a sensitive file the user chose to show
  function openByUser(path: string, opts?: FileOpenOptions) {
    openFile(path, opts)
    if (!activeTab(state)?.reveal) remember(path)
  }

  function openFile(path: string, opts: FileOpenOptions = {}) {
    const now = ++clock
    const r = openTab(
      state.tabs,
      state.activeId,
      (t) => t.path,
      path,
      () => ({
        id: `t${++ids}`,
        pinned: false,
        lastUsed: 0,
        root: state.root ?? '',
        path,
        anchor: opts.anchor,
        history: [],
        reveal: false,
      }),
      opts,
      isDirty,
      now,
    )
    // Tabs closed to make room never had changes; an untouched draft of
    // theirs goes with them, so the file is read again when it reopens
    for (const t of r.closed) dropDraft(paneId, t.path)
    const gone = new Set(r.closed.map((t) => t.id))
    // A file already open goes to the heading or the line asked for
    const at: Partial<FileTab> | undefined = opts.line
      ? {
          line: opts.line,
          col: opts.col,
          jump: now,
          anchor: undefined,
          scrollTop: undefined,
        }
      : opts.anchor
        ? { anchor: opts.anchor, scrollTop: undefined }
        : undefined
    const tabs = at
      ? r.tabs.map((t) => (t.id === r.activeId ? { ...t, ...at } : t))
      : r.tabs
    set({
      tabs,
      activeId: r.activeId,
      pendingRootClose: pendingOf(
        state.pendingRootClose?.filter((id) => !gone.has(id)),
      ),
    })
  }

  // No list at all once nothing waits for the user
  const pendingOf = (ids?: string[]) => (ids?.length ? ids : undefined)

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

  // Replaces tab id with patch applied
  function patchTab(id: string, patch: Partial<FileTab>) {
    set({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })
  }

  function close(id: string) {
    const tab = state.tabs.find((t) => t.id === id)
    if (!tab) return
    dropDraft(paneId, tab.path)
    const r = closeTab(state.tabs, state.activeId, id)
    set({
      tabs: r.tabs,
      activeId: r.activeId,
      pendingRootClose: pendingOf(
        state.pendingRootClose?.filter((p) => p !== id),
      ),
    })
  }

  // Where the user is: a link or a create that finds them elsewhere when
  // it is done is dropped
  const place = () => `${state.activeId}\u0000${activeTab(state)?.path}`

  // state.expanded with path and every directory above it open
  function expandTo(path: string) {
    const expanded = { ...state.expanded }
    if (!path) return expanded
    const parts = path.split('/')
    for (let i = 1; i <= parts.length; i++)
      expanded[parts.slice(0, i).join('/')] = true
    return expanded
  }

  async function created(path: string, root: string, reveal: boolean) {
    const gen = generation
    const from = place()
    const parts = path.split('/')
    const name = parts[parts.length - 1]
    const dirs = parts
      .slice(0, -1)
      .map((_, i) => parts.slice(0, i + 1).join('/'))
    const parent = dirs[dirs.length - 1] ?? ''
    set({ expanded: expandTo(parent) })
    // The directories just made are in no listing read so far
    await Promise.all(['', ...dirs].map(read))
    // The root moved, or the user opened something else meanwhile
    if (gen !== generation || place() !== from) return
    const entry = state.dirs[parent]?.entries?.find((e) => e.name === name)
    if (entry && isDir(entry)) {
      set({ activeId: null, expanded: expandTo(path) })
      read(path)
      return
    }
    openFile(path, { pin: true })
    // The viewer mounts with the intent already there
    patchTab(state.activeId as string, { root, intent: true, reveal })
  }

  // A link of the tab shown (left at scrollTop) to target
  async function follow(
    target: LinkPath,
    scrollTop: number,
    opts: FollowOptions = {},
    retried = false,
  ): Promise<FollowResult> {
    const gen = generation
    const from = place()
    const at = target.path.lastIndexOf('/')
    const parent = at < 0 ? '' : target.path.slice(0, at)
    const name = target.path.slice(at + 1)
    // The root itself
    if (!name) {
      set({ activeId: null })
      return 'opened'
    }
    // Read again: the listing says what the path is now
    await read(parent)
    // The user moved on meanwhile (another link, Back): this one is dropped
    if (place() !== from) return 'stale'
    // The root moved under the read: once more, from the new root
    if (gen !== generation)
      return retried ? 'stale' : follow(target, scrollTop, opts, true)
    const dir = state.dirs[parent]
    if (!dir.entries) return dir.error === 'not-found' ? 'missing' : 'failed'
    const entry = dir.entries.find((e) => e.name === name)
    if (!entry) return 'missing'
    if (!isOpenable(entry)) return 'failed'
    if (isDir(entry)) {
      // The tree, with the directory and every one above it open
      const expanded = expandTo(target.path)
      set({ activeId: null, expanded })
      for (const path of Object.keys(expanded)) {
        const d = state.dirs[path]
        if (!d || d.error) read(path)
      }
      return 'opened'
    }
    const current = activeTab(state)
    const elsewhere = state.tabs.find(
      (t) => t.path === target.path && t !== current,
    )
    if (opts.newTab || opts.fresh || elsewhere || !current) {
      openByUser(target.path, { pin: opts.newTab, anchor: target.anchor })
      return 'opened'
    }
    // On in the same tab, which remembers where it was
    patchTab(current.id, {
      path: target.path,
      anchor: target.anchor,
      scrollTop: undefined,
      line: undefined,
      col: undefined,
      table: undefined,
      reveal: false,
      intent: undefined,
      history:
        current.path === target.path
          ? current.history
          : [
              ...current.history,
              {
                path: current.path,
                scrollTop,
                ...(current.reveal && { reveal: true }),
              },
            ],
    })
    remember(target.path)
    return 'opened'
  }

  // Every directory from the root down to dir, read again: the path may
  // be newer than their listings (a search result, a restored file)
  function readDown(dir: string) {
    const parts = dir ? dir.split('/') : []
    const chain = ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))]
    return Promise.all(chain.map(read))
  }

  async function reveal(path: string, kind: 'file' | 'dir' = 'file') {
    const gen = generation
    const at = path.lastIndexOf('/')
    const parent = at < 0 ? '' : path.slice(0, at)
    const target = kind === 'dir' ? path : parent
    set({ expanded: expandTo(target) })
    await readDown(target)
    if (gen !== generation) return
    if (kind === 'dir') {
      set({ activeId: null })
      return
    }
    openByUser(path)
  }

  async function list(path: string) {
    await read(path)
    return state.dirs[path]
  }

  async function restored(path: string) {
    const at = path.lastIndexOf('/')
    const parent = at < 0 ? '' : path.slice(0, at)
    set({ expanded: expandTo(parent) })
    await readDown(parent)
  }

  // The file from was renamed to to (reveal: shown as sensitive): its tabs
  // show to, keeping their place and pinned state (a tab already on to
  // closes), Back goes to to, and the tree reads both directories again.
  // Tabs kept from another root (pendingRootClose) are another file.
  function renamed(from: string, to: string, reveal: boolean) {
    const mine = (t: FileTab) => t.root === state.root
    const follow = (t: FileTab) =>
      mine(t) && t.history.some((e) => e.path === from)
        ? t.history.map((e) =>
            e.path === from
              ? { ...e, path: to, ...(reveal && { reveal: true }) }
              : e,
          )
        : t.history
    const r = retargetTabs(
      state.tabs,
      from,
      to,
      (t) => ({ reveal: t.reveal || reveal }),
      mine,
    )
    const gone = new Set(r.dropped.map((t) => t.id))
    set({
      tabs: r.tabs.map((t) => {
        const history = follow(t)
        return history === t.history ? t : { ...t, history }
      }),
      // A tab dropped for being on to: the moved one shows in its place
      activeId:
        state.activeId && gone.has(state.activeId)
          ? r.tabs.find((t) => t.path === to && mine(t))!.id
          : state.activeId,
    })
    const parentOf = (p: string) => {
      const at = p.lastIndexOf('/')
      return at < 0 ? '' : p.slice(0, at)
    }
    set({ expanded: expandTo(parentOf(to)) })
    // The list follows it; one shown as sensitive is not kept
    const root = state.root as string
    if (reveal) forget(root, from)
    else if (state.recent.some((f) => f.root === root && f.path === from))
      setRecent(
        state.recent.map((f) =>
          f.root === root && f.path === from ? { root, path: to } : f,
        ),
      )
    read(parentOf(from))
    if (parentOf(to) !== parentOf(from)) readDown(parentOf(to))
  }

  function deleted(path: string) {
    const at = path.lastIndexOf('/')
    const parent = at < 0 ? '' : path.slice(0, at)
    // Its tab closes, and for a directory every tab under it
    for (const t of state.tabs)
      if (t.path === path || t.path.startsWith(`${path}/`)) close(t.id)
    // A deleted directory is closed, and so is everything under it
    const expanded = Object.fromEntries(
      Object.entries(state.expanded).filter(
        ([p]) => p !== path && !p.startsWith(`${path}/`),
      ),
    )
    const { [path]: _, ...dirs } = state.dirs
    set({ expanded, dirs })
    if (state.root !== undefined) forget(state.root, path)
    read(parent)
  }

  // The tree starts again from the new root. Tabs opened under another
  // root close, except those with unsaved changes: the user is asked about
  // them (pendingRootClose), and kept ones show the old root's text.
  function rootChanged(root: string) {
    if (root === state.root) return
    generation++
    const moved = state.tabs.filter((t) => t.root !== root)
    for (const t of moved) if (!isDirty(t)) close(t.id)
    // Every tab still of another root: one asked about before that is of
    // this root again (the pane came back) is no longer asked about
    const asked = state.tabs.filter((t) => t.root !== root).map((t) => t.id)
    set({
      root,
      dirs: {},
      expanded: {},
      rootChanges: state.rootChanges + 1,
      pendingRootClose: pendingOf(asked),
    })
    read('')
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    load() {
      if (!state.dirs['']) read('')
    },
    toggle(path) {
      if (state.expanded[path]) {
        const { [path]: _, ...expanded } = state.expanded
        set({ expanded })
        return
      }
      set({ expanded: { ...state.expanded, [path]: true } })
      const dir = state.dirs[path]
      if (!dir || dir.error) read(path)
    },
    refresh() {
      for (const path of ['', ...Object.keys(state.expanded)]) read(path)
    },
    moveTo(id) {
      paneId = id
      generation++
      for (const path of Object.keys(state.dirs)) read(path)
    },
    open: openByUser,
    activate,
    pin(id) {
      // Pinned once editing starts: the intent is used up then too
      set({
        tabs: pinTab(state.tabs, id).map((t) =>
          t.id === id && t.intent ? { ...t, intent: undefined } : t,
        ),
      })
    },
    close,
    follow,
    back() {
      const tab = activeTab(state)
      if (!tab) return
      const prev = tab.history[tab.history.length - 1]
      if (!prev) {
        set({ activeId: null })
        return
      }
      // The file went back to has a tab of its own meanwhile: shown there,
      // this tab stays as it is, one step less to go back
      const other = state.tabs.find((t) => t.path === prev.path)
      if (other) {
        patchTab(tab.id, { history: tab.history.slice(0, -1) })
        activate(other.id)
        return
      }
      patchTab(tab.id, {
        path: prev.path,
        anchor: undefined,
        scrollTop: prev.scrollTop,
        line: undefined,
        col: undefined,
        table: undefined,
        reveal: false,
        intent: undefined,
        history: tab.history.slice(0, -1),
      })
    },
    setScroll(id, top) {
      const tab = state.tabs.find((t) => t.id === id)
      if (!tab) return
      tab.scrollTop = top
      // Scrolled away from the heading or line it opened at: shown again
      // here
      tab.anchor = undefined
      tab.line = undefined
      tab.col = undefined
      persist()
    },
    setTableLayout(id, layout) {
      const tab = state.tabs.find((t) => t.id === id)
      if (!tab) return
      tab.table = layout
      persist()
    },
    // A file the user chose to show as sensitive is not kept in the list
    setReveal(id) {
      patchTab(id, { reveal: true })
      const tab = state.tabs.find((t) => t.id === id)
      if (tab) forget(tab.root, tab.path)
    },
    openFromFind(root, path, opts) {
      if (state.root !== root) rootChanged(root)
      openByUser(path, opts)
    },
    resolveRootClose(closing) {
      const ids = state.pendingRootClose ?? []
      set({ pendingRootClose: undefined })
      if (closing) for (const id of ids) close(id)
    },
    rootChanged,
    created,
    reveal,
    list,
    deleted,
    restored,
    renamed,
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

// paneId's files state as it is, without making a store for it (null when
// nothing read it yet): a template's {{file}}
export const peekFilesState = (paneId: string): FilesState | null =>
  stores.get(paneId)?.get() ?? null

// The file tree of paneId's root
export function useFiles(paneId: string) {
  const store = storeFor(paneId)
  const state = useSyncExternalStore(store.subscribe, store.get)
  return {
    ...state,
    active: activeTab(state),
    load: useCallback(() => store.load(), [store]),
    toggle: useCallback((p: string) => store.toggle(p), [store]),
    refresh: useCallback(() => store.refresh(), [store]),
    open: useCallback(
      (p: string, opts?: FileOpenOptions) => store.open(p, opts),
      [store],
    ),
    activate: useCallback((id: string | null) => store.activate(id), [store]),
    pin: useCallback((id: string) => store.pin(id), [store]),
    close: useCallback((id: string) => store.close(id), [store]),
    follow: useCallback(
      (t: LinkPath, scrollTop: number, opts?: FollowOptions) =>
        store.follow(t, scrollTop, opts),
      [store],
    ),
    back: useCallback(() => store.back(), [store]),
    setScroll: useCallback(
      (id: string, top: number) => store.setScroll(id, top),
      [store],
    ),
    setTableLayout: useCallback(
      (id: string, layout: TableLayout) => store.setTableLayout(id, layout),
      [store],
    ),
    setReveal: useCallback((id: string) => store.setReveal(id), [store]),
    resolveRootClose: useCallback(
      (close: boolean) => store.resolveRootClose(close),
      [store],
    ),
    created: useCallback(
      (p: string, root: string, reveal: boolean) =>
        store.created(p, root, reveal),
      [store],
    ),
    rootChanged: useCallback((r: string) => store.rootChanged(r), [store]),
    openFromFind: useCallback(
      (r: string, p: string, opts?: FileOpenOptions) =>
        store.openFromFind(r, p, opts),
      [store],
    ),
    reveal: useCallback(
      (p: string, kind?: 'file' | 'dir') => store.reveal(p, kind),
      [store],
    ),
    list: useCallback((p: string) => store.list(p), [store]),
    deleted: useCallback((p: string) => store.deleted(p), [store]),
    restored: useCallback((p: string) => store.restored(p), [store]),
  }
}

// The file from under root was renamed to to: the tabs and drafts of every
// pane showing root follow it (reveal: the user chose to show it as
// sensitive). Run once the server moved it, with the paths it answered.
export function fileRenamed(
  root: string,
  from: string,
  to: string,
  reveal: boolean,
) {
  if (from === to) return
  moveDrafts(root, from, to, reveal)
  for (const s of stores.values())
    if (s.get().root === root) s.renamed(from, to, reveal)
}

// Where focus goes in paneId's Files view, asked for from outside it (the
// content search's shortcut, a file opened from the command palette): the
// view takes the request when it is shown, or at once when it already is.
// Once per request, never a counter, so a later mount does not focus.
export type FilesFocus = 'search' | 'file'
const focusRequests = new Map<string, FilesFocus>()
const focusListeners = new Set<() => void>()

export function requestFilesFocus(paneId: string, target: FilesFocus) {
  focusRequests.set(paneId, target)
  for (const fn of focusListeners) fn()
}

// Calls onRequest for each request for paneId's Files view
export function useFilesFocusRequest(
  paneId: string,
  onRequest: (target: FilesFocus) => void,
) {
  const ref = useRef(onRequest)
  ref.current = onRequest
  useEffect(() => {
    const take = () => {
      const target = focusRequests.get(paneId)
      if (!target) return
      focusRequests.delete(paneId)
      ref.current(target)
    }
    take()
    focusListeners.add(take)
    return () => {
      focusListeners.delete(take)
    }
  }, [paneId])
}

// Follows a link into the Files view of paneId from elsewhere (the Changes
// view's preview)
export function followInFiles(paneId: string, target: LinkPath) {
  return storeFor(paneId).follow(target, 0, { fresh: true })
}

// Opens path (under root, which the store moves to when it is elsewhere) in
// paneId's Files view, at line when given: a review comment's file
export function openInFiles(
  paneId: string,
  root: string,
  path: string,
  opts?: FileOpenOptions,
) {
  storeFor(paneId).openFromFind(root, path, opts)
}

// A file being edited in a pane. It is kept here, out of the viewer, so a
// remount (another view, the desktop panel, a move of the root) never loses
// it. One with unsaved changes is kept on the device too (files-persist.ts),
// to come back when the app opens again, except a sensitive file's (reveal):
// that one stays in memory only, and leaving the page asks first.
export interface FileDraft {
  // The root and the bytes (their sha256) the text was read from
  root: string
  path: string
  baseHash: string
  // The text read, with "\n" line breaks: what the draft is compared to
  base: string
  // The file uses "\r\n" throughout; the server writes them back
  crlf: boolean
  // What the file was read as, sent back with the save. Absent in a draft
  // kept from before encodings: its save sends none, which the server
  // takes for a UTF-8 file only.
  encoding?: FileEncoding
  text: string
  // A sensitive file the user chose to show
  reveal: boolean
  // Edited in the table view: the delimiter its edits are written with,
  // and the edits that turn base into text, in order (undone ones in redo)
  cells?: { delimiter: Delimiter; ops: TableOp[]; redo: TableOp[] }
}

type DraftUpdate =
  | FileDraft
  | undefined
  // From the draft as it is in the store now (an async caller's own copy
  // may be stale)
  | ((now: FileDraft | undefined) => FileDraft | undefined)

// By pane and path: one draft per file, shared by every view of the pane
// (the Files tab, the Changes editor)
const drafts = new Map<string, FileDraft>()
const draftListeners = new Set<() => void>()
// Bumped on every change, so readers of several drafts render again
let draftsVersion = 0

const draftKey = (paneId: string, path: string) => `${paneId}\u0000${path}`

// When each draft's text last changed: a draft kept on the device expires
// 14 days after it, however often it is written again (a move, a rename)
const editedAt = new WeakMap<FileDraft, number>()
// Drafts kept on the device as they are now
let kept = new WeakSet<FileDraft>()
// Drafts are kept on the device only for a client that may write: a
// snapshot naming a view-only one turns this off
let keepDrafts = true
// The panes (instance and key) whose kept drafts were read back
const hydrated = new Set<string>()

const isDirty = (d: FileDraft) => d.text !== d.base

// Leaving the page asks first while a file has unsaved changes the device
// does not keep (a sensitive file's, one too big, storage full), whether or
// not its editor is on screen
const askBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
function guardUnload() {
  const lost = [...drafts.values()].some((d) => isDirty(d) && !kept.has(d))
  if (lost) window.addEventListener('beforeunload', askBeforeUnload)
  else window.removeEventListener('beforeunload', askBeforeUnload)
}

// Keeps next, paneId's draft of path, on the device at once (prev: the draft
// it replaces), or removes what is kept: a draft without changes, a
// sensitive file's, none at all. Never delayed, so a save or a discard just
// before the app closes never brings the old text back.
function keepDraft(
  paneId: string,
  path: string,
  prev: FileDraft | undefined,
  next: FileDraft | undefined,
) {
  if (next) {
    const same = prev && prev.text === next.text && editedAt.get(prev)
    editedAt.set(next, same || Date.now())
  }
  if (!next || next.reveal || !isDirty(next) || !keepDrafts) {
    removeDraft(paneId, path)
    return
  }
  const { reveal: _, ...stored } = next
  if (writeDraft(paneId, stored, editedAt.get(next)!)) kept.add(next)
}

const isString = (v: unknown) => typeof v === 'string'
// A draft read back from the device, checked: the fields of FileDraft
// without reveal
function isStoredDraft(d: unknown): d is Omit<FileDraft, 'reveal'> {
  const o = d as Record<string, unknown>
  return (
    isString(o.root) &&
    isString(o.path) &&
    isString(o.baseHash) &&
    isString(o.base) &&
    isString(o.text) &&
    typeof o.crlf === 'boolean' &&
    (o.encoding === undefined || isFileEncoding(o.encoding)) &&
    (o.cells === undefined ||
      (typeof o.cells === 'object' &&
        o.cells !== null &&
        Array.isArray((o.cells as { ops?: unknown }).ops) &&
        Array.isArray((o.cells as { redo?: unknown }).redo)))
  )
}

// The drafts kept on the device for paneIds (a snapshot's panes) come back,
// once per pane, before any view of theirs reads its files: a store that
// finds its pane moved (409) then asks about the tabs with changes instead
// of closing them. A draft in memory is never replaced. A view-only client
// (role 'view') keeps none, and those kept are removed.
export function hydrateDrafts(paneIds: Iterable<string>, role?: string) {
  keepDrafts = role !== 'view'
  if (!keepDrafts) {
    clearDrafts()
    return
  }
  let changed = false
  for (const paneId of paneIds) {
    const pane = persistKey('drafts', paneId)
    if (!pane || hydrated.has(pane)) continue
    hydrated.add(pane)
    for (const { draft, editedAt: at } of loadDrafts<unknown>(paneId)) {
      if (!isStoredDraft(draft)) continue
      const key = draftKey(paneId, draft.path)
      if (drafts.has(key)) continue
      const d: FileDraft = { ...draft, reveal: false }
      drafts.set(key, d)
      editedAt.set(d, at)
      kept.add(d)
      changed = true
    }
  }
  if (changed) draftsChanged()
}

function draftsChanged() {
  draftsVersion++
  guardUnload()
  for (const fn of draftListeners) fn()
}

function subscribeDrafts(fn: () => void) {
  draftListeners.add(fn)
  return () => {
    draftListeners.delete(fn)
  }
}

function setDraftOf(paneId: string, path: string, update: DraftUpdate) {
  const key = draftKey(paneId, path)
  const prev = drafts.get(key)
  const next = typeof update === 'function' ? update(prev) : update
  if (next === prev) return
  if (next) drafts.set(key, next)
  else drafts.delete(key)
  keepDraft(paneId, path, prev, next)
  draftsChanged()
}

// The draft of path in paneId, and a setter that replaces it, or with
// undefined drops it.
export function useFileDraft(paneId: string, path: string) {
  const draft = useSyncExternalStore(subscribeDrafts, () =>
    drafts.get(draftKey(paneId, path)),
  )
  const setDraft = useCallback(
    (update: DraftUpdate) => setDraftOf(paneId, path, update),
    [paneId, path],
  )
  return [draft, setDraft] as const
}

// path in paneId has unsaved changes
export function isDraftDirty(paneId: string, path: string) {
  const d = drafts.get(draftKey(paneId, path))
  return !!d && d.text !== d.base
}

export function dropDraft(paneId: string, path: string) {
  setDraftOf(paneId, path, undefined)
}

// Whether any pane has unsaved changes of path under root: a rename onto it
// would lose them
export function hasDirtyDraftAt(root: string, path: string) {
  for (const d of drafts.values())
    if (d.root === root && d.path === path && d.text !== d.base) return true
  return false
}

// Every pane's draft of from under root becomes the draft of to (a clean
// one there is replaced: its file is gone), shown as sensitive when reveal
function moveDrafts(root: string, from: string, to: string, reveal: boolean) {
  let moved = false
  for (const [key, d] of [...drafts]) {
    if (d.root !== root || d.path !== from) continue
    drafts.delete(key)
    const paneId = key.slice(0, key.indexOf('\u0000'))
    removeDraft(paneId, from)
    const next = { ...d, path: to, reveal: d.reveal || reveal }
    const toKey = draftKey(paneId, to)
    drafts.set(toKey, next)
    keepDraft(paneId, to, d, next)
    moved = true
  }
  if (!moved) return
  draftsChanged()
}

// Whether a path of paneId has unsaved changes, read again whenever a
// draft changes
export function useDirtyCheck(paneId: string) {
  const version = useSyncExternalStore(subscribeDrafts, () => draftsVersion)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new check per change
  return useCallback(
    (path: string) => isDraftDirty(paneId, path),
    [paneId, version],
  )
}

// A store and each draft follow their pane to the id it has now, so its open
// tabs stay; a pane id that names another pane now starts again, and what
// was kept for a pane that is gone is dropped.
onPaneRemap((shift) => {
  remapEntries(stores, shift)
  for (const to of shift.moved.values()) stores.get(to)?.moveTo(to)
  // What is kept on the device is under the pane's key, which a shift
  // leaves as it is
  remapEntries(
    drafts,
    shift,
    (k) => k.slice(0, k.indexOf('\u0000')),
    (k, id) => id + k.slice(k.indexOf('\u0000')),
  )
  draftsChanged()
})

// Another tab of the app signed out: this one forgets the tabs and drafts
// it holds too
onSignedOutElsewhere(forgetAll)
// This tab signed out: what was kept is gone, so leaving asks about every
// draft with changes again
onSignedOutHere(unkeepAll)
// Another tab of the app wrote or removed a draft this one keeps (the same
// file of the same pane): this one's text may no longer be what is kept
onDraftChangedElsewhere(unkeepDraft)

function unkeepAll() {
  kept = new WeakSet()
  guardUnload()
}

function unkeepDraft(key: string) {
  for (const [k, d] of drafts) {
    const paneId = k.slice(0, k.indexOf('\u0000'))
    if (persistKey('drafts', paneId, d.path) === key) kept.delete(d)
  }
  guardUnload()
}

function forgetAll() {
  stores.clear()
  focusRequests.clear()
  drafts.clear()
  draftsChanged()
}

// For tests: forget every store and draft, and which panes' kept drafts
// were read back (what is kept stays: the app opening again).
export function resetFilesStores() {
  forgetAll()
  hydrated.clear()
  keepDrafts = true
  onSignedOutElsewhere(forgetAll)
  onSignedOutHere(unkeepAll)
  onDraftChangedElsewhere(unkeepDraft)
}
