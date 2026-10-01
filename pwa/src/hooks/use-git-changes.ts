import { useCallback, useSyncExternalStore } from 'react'
import { type FilesError, filesError } from './use-files'
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
}

const INITIAL: ChangesState = {
  isRepo: false,
  entries: [],
  truncated: false,
  loaded: false,
  rootChanges: 0,
}

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
  }

  const visible = () => document.visibilityState === 'visible'

  const schedule = (delay: number) => {
    clearTimeout(timer)
    timer = undefined
    if (listeners.size > 0 && visible()) timer = setTimeout(poll, delay)
  }

  function rootChanged(root: string) {
    if (root === state.root) return
    generation++
    set({
      root,
      entries: [],
      loaded: false,
      rootChanges: state.rootChanges + 1,
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
    refresh: useCallback(() => store.refresh(), [store]),
    rootChanged: useCallback((r: string) => store.rootChanged(r), [store]),
  }
}

// For tests: forget every store.
export function resetGitChangesStores() {
  stores.clear()
}
