import { useCallback, useSyncExternalStore } from 'react'
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
  // Bumped each time the pane's root moves while the view is open
  rootChanges: number
}

const INITIAL: FilesState = {
  isRepo: false,
  dirs: {},
  expanded: {},
  openPath: null,
  rootChanges: 0,
}

export const joinPath = (dir: string, name: string) =>
  dir ? `${dir}/${name}` : name

// A directory, or a symlink inside the root that leads to one
export const isDir = (e: FileEntry) => e.type === 'dir' || e.target === 'dir'

interface Store {
  get: () => FilesState
  subscribe: (fn: () => void) => () => void
  // Reads the root once there is a reader
  load: () => void
  toggle: (path: string) => void
  refresh: () => void
  open: (path: string | null) => void
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
    open(openPath) {
      set({ openPath })
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
    rootChanged: useCallback((r: string) => store.rootChanged(r), [store]),
  }
}

// For tests: forget every store.
export function resetFilesStores() {
  stores.clear()
}
