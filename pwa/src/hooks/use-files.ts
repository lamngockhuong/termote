import { useCallback, useSyncExternalStore } from 'react'
import type { LinkPath } from '../utils/markdown-links'
import {
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
  // The request failed (network, server)
  | 'unavailable'

export function filesError(err: unknown): FilesError {
  if (!(err instanceof RequestError)) return 'unavailable'
  if (err.status === 501) return 'unsupported'
  if (err.status === 404) return 'not-found'
  if (err.status === 403) return 'not-allowed'
  return 'unavailable'
}

export interface DirState {
  entries?: FileEntry[]
  truncated?: boolean
  loading: boolean
  error?: FilesError
}

export interface FilesState {
  root?: string
  isRepo: boolean
  // Directories read so far, by path ("" is the root)
  dirs: Record<string, DirState>
  expanded: Record<string, boolean>
  // The file shown instead of the tree
  openPath: string | null
  // Where the open file starts: a heading, or the offset it was left at
  openAnchor?: string
  openScroll?: number
  // Files left by following a link, the latest last: Back returns to them
  history: { path: string; scrollTop: number }[]
  // Bumped each time the pane's root moves while the view is open
  rootChanges: number
}

const INITIAL: FilesState = {
  isRepo: false,
  dirs: {},
  expanded: {},
  openPath: null,
  history: [],
  rootChanges: 0,
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
  // Opens a file from the tree (or closes it): a new trail of links
  open: (path: string | null) => void
  // Follows a link of the open file (left at scrollTop): a file opens, a
  // directory shows in the tree, opened
  follow: (
    target: LinkPath,
    scrollTop: number,
    fresh?: boolean,
  ) => Promise<FollowResult>
  // Back to the file a link was followed from, else to the tree
  back: () => void
  // Another request saw the root move to root
  rootChanged: (root: string) => void
}

function createStore(paneId: string): Store {
  let state = INITIAL
  const listeners = new Set<() => void>()
  // Bumped when the root moves: a read sent for the old one is dropped.
  let generation = 0

  const set = (next: Partial<FilesState>) => {
    state = { ...state, ...next }
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

  function open(openPath: string | null) {
    set({ openPath, openAnchor: undefined, openScroll: undefined, history: [] })
  }

  // A link of the open file (left at scrollTop) to target. fresh: followed
  // from another view, so the file open here is not a step to go back to.
  async function follow(
    target: LinkPath,
    scrollTop: number,
    fresh = false,
    retried = false,
  ): Promise<FollowResult> {
    const gen = generation
    const from = state.openPath
    const at = target.path.lastIndexOf('/')
    const parent = at < 0 ? '' : target.path.slice(0, at)
    const name = target.path.slice(at + 1)
    // The root itself
    if (!name) {
      open(null)
      return 'opened'
    }
    // Read again: the listing says what the path is now
    await read(parent)
    // The user moved on meanwhile (another link, Back): this one is dropped
    if (state.openPath !== from) return 'stale'
    // The root moved under the read: once more, from the new root
    if (gen !== generation)
      return retried ? 'stale' : follow(target, scrollTop, fresh, true)
    const dir = state.dirs[parent]
    if (!dir.entries) return dir.error === 'not-found' ? 'missing' : 'failed'
    const entry = dir.entries.find((e) => e.name === name)
    if (!entry) return 'missing'
    if (!isOpenable(entry)) return 'failed'
    if (isDir(entry)) {
      // The tree, with the directory and every one above it open
      const expanded = { ...state.expanded }
      const parts = target.path.split('/')
      for (let i = 1; i <= parts.length; i++)
        expanded[parts.slice(0, i).join('/')] = true
      open(null)
      set({ expanded })
      for (const path of Object.keys(expanded)) {
        const d = state.dirs[path]
        if (!d || d.error) read(path)
      }
      return 'opened'
    }
    set({
      openPath: target.path,
      openAnchor: target.anchor,
      openScroll: undefined,
      history: fresh
        ? []
        : from
          ? [...state.history, { path: from, scrollTop }]
          : state.history,
    })
    return 'opened'
  }

  // The tree starts again from the new root; an open file stays open, and
  // shows what the same path holds there.
  function rootChanged(root: string) {
    if (root === state.root) return
    generation++
    set({
      root,
      dirs: {},
      expanded: {},
      rootChanges: state.rootChanges + 1,
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
    open,
    follow,
    back() {
      const prev = state.history[state.history.length - 1]
      if (!prev) {
        open(null)
        return
      }
      set({
        openPath: prev.path,
        openAnchor: undefined,
        openScroll: prev.scrollTop,
        history: state.history.slice(0, -1),
      })
    },
    rootChanged,
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

// The file tree of paneId's root
export function useFiles(paneId: string) {
  const store = storeFor(paneId)
  const state = useSyncExternalStore(store.subscribe, store.get)
  return {
    ...state,
    load: useCallback(() => store.load(), [store]),
    toggle: useCallback((p: string) => store.toggle(p), [store]),
    refresh: useCallback(() => store.refresh(), [store]),
    open: useCallback((p: string | null) => store.open(p), [store]),
    follow: useCallback(
      (t: LinkPath, scrollTop: number) => store.follow(t, scrollTop),
      [store],
    ),
    back: useCallback(() => store.back(), [store]),
    rootChanged: useCallback((r: string) => store.rootChanged(r), [store]),
  }
}

// Follows a link into the Files view of paneId from elsewhere (the Changes
// view's preview)
export function followInFiles(paneId: string, target: LinkPath) {
  return storeFor(paneId).follow(target, 0, true)
}

// A file being edited in a pane. It is kept here, out of the viewer, so a
// remount (another view, the desktop panel, a move of the root) never loses
// it; only in memory, since the text may be a .env file's.
export interface FileDraft {
  // The root and the bytes (their sha256) the text was read from
  root: string
  path: string
  baseHash: string
  // The text read, with "\n" line breaks: what the draft is compared to
  base: string
  // The file uses "\r\n" throughout; the server writes them back
  crlf: boolean
  text: string
  // A sensitive file the user chose to show
  reveal: boolean
}

const drafts = new Map<string, FileDraft>()
const draftListeners = new Set<() => void>()

// Leaving the page asks first while any pane has unsaved changes, whether
// or not its editor is on screen
const askBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
function guardUnload() {
  const dirty = [...drafts.values()].some((d) => d.text !== d.base)
  if (dirty) window.addEventListener('beforeunload', askBeforeUnload)
  else window.removeEventListener('beforeunload', askBeforeUnload)
}

function subscribeDrafts(fn: () => void) {
  draftListeners.add(fn)
  return () => {
    draftListeners.delete(fn)
  }
}

// The draft of paneId (at most one file at a time), and a setter that
// replaces it, or with undefined drops it.
export function useFileDraft(paneId: string) {
  const draft = useSyncExternalStore(subscribeDrafts, () => drafts.get(paneId))
  const setDraft = useCallback(
    (next: FileDraft | undefined) => {
      if (next) drafts.set(paneId, next)
      else drafts.delete(paneId)
      guardUnload()
      for (const fn of draftListeners) fn()
    },
    [paneId],
  )
  return [draft, setDraft] as const
}

// For tests: forget every store and draft.
export function resetFilesStores() {
  stores.clear()
  drafts.clear()
  guardUnload()
}
