import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { onPaneRemap } from '../utils/pane-remap'
import { foldToolResults, POLL_INTERVAL } from './use-agent-transcript'
import {
  AgentRequestError,
  fetchSubagentTranscript,
  type TranscriptEntry,
  type TranscriptPage,
} from './use-mux-api'

// The conversation of one subagent of a pane's Claude Code session, read
// only. It is polled while the subagent runs, read once more when it ends,
// then left as read. A store lives as long as something shows it: closing
// the view forgets it. The Chat view's own store is not this one.

const MAX_BACKOFF = 12000

// gone: the subagent's file is no longer there (what was read stays);
// unsupported: the server (a machine) is too old to read one; failed:
// anything else
export type SubagentTranscriptError = 'gone' | 'unsupported' | 'failed'

export interface SubagentTranscriptState {
  entries: TranscriptEntry[]
  cursor?: string
  // Reads older entries; undefined once the start is reached
  before?: string
  loaded: boolean
  loadingOlder: boolean
  error?: SubagentTranscriptError
}

const INITIAL: SubagentTranscriptState = {
  entries: [],
  loaded: false,
  loadingOlder: false,
}

interface Store {
  get: () => SubagentTranscriptState
  subscribe: (fn: () => void) => () => void
  // live: the subagent runs; listed: the tree still has it
  setLive: (live: boolean) => void
  setListed: (listed: boolean) => void
  loadOlder: () => void
  // Stops it for good (its pane id names another pane now)
  drop: () => void
}

const keyOf = (paneId: string, agentId: string) => `${paneId}\0${agentId}`

const stores = new Map<string, Store>()

function createStore(
  paneId: string,
  agentId: string,
  startLive: boolean,
): Store {
  let live = startLive
  const key = keyOf(paneId, agentId)
  let state = INITIAL
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  // A read asked for while one is in flight runs right after it
  let again = false
  let failures = 0
  // Nothing more is read: the file is gone, or the server refused
  let stopped = false
  let listed = true
  // Bumped by every reset: a read started before it belongs to the old list
  let generation = 0
  // Bumped when the store is let go: a read in flight then is dropped
  let epoch = 0

  const set = (next: Partial<SubagentTranscriptState>) => {
    state = { ...state, ...next }
    for (const fn of listeners) fn()
  }

  const apply = (page: TranscriptPage) => {
    if (page.reset) generation++
    if (!page.reset && page.entries.length === 0) {
      if (state.loaded && !state.error && state.cursor === page.cursor) return
      set({ cursor: page.cursor, loaded: true, error: undefined })
      return
    }
    const entries = page.reset
      ? page.entries
      : [...state.entries, ...page.entries]
    set({
      entries: foldToolResults(entries),
      cursor: page.cursor,
      before: page.reset ? page.before : state.before,
      loaded: true,
      error: undefined,
    })
  }

  const visible = () => document.visibilityState === 'visible'

  const schedule = (delay: number) => {
    clearTimeout(timer)
    timer = undefined
    if (!stopped && listeners.size > 0 && visible()) {
      timer = setTimeout(poll, delay)
    }
  }

  // An error read as the end of the reads, or not
  const fail = (err: unknown) => {
    failures++
    const e = err instanceof AgentRequestError ? err : undefined
    if (e?.status === 404 && e.code === 'session_not_found') {
      // A running subagent the tree lists whose file is not there yet: the
      // next poll looks again. Otherwise it is gone; what was read stays.
      if (listed && live) set({ loaded: true })
      else {
        stopped = true
        set({ loaded: true, error: 'gone' })
      }
    } else if (e?.status === 404) {
      stopped = true
      set({ loaded: true, error: 'unsupported' })
    } else {
      // Refused (403) is for good; a failed read is tried again while the
      // subagent runs. What was read stays.
      if (e?.status === 403) stopped = true
      set({ loaded: true, error: 'failed' })
    }
  }

  async function poll() {
    if (inFlight) {
      again = true
      return
    }
    inFlight = true
    const gen = generation
    const ep = epoch
    try {
      const page = await fetchSubagentTranscript(paneId, agentId, {
        cursor: state.cursor,
      })
      if (ep !== epoch) return
      if (page.reset || gen === generation) apply(page)
      failures = 0
    } catch (err) {
      if (ep !== epoch) return
      fail(err)
    } finally {
      inFlight = false
    }
    if (again) {
      again = false
      schedule(0)
    } else if (live) {
      schedule(
        Math.min(POLL_INTERVAL * 2 ** Math.max(0, failures - 1), MAX_BACKOFF),
      )
    }
  }

  // Hidden: the pending poll is dropped; visible again: read now, while it
  // runs (an ended one was read when it ended)
  const onVisibility = () => {
    if (live) schedule(0)
  }

  const forget = () => {
    epoch++
    clearTimeout(timer)
    timer = undefined
    inFlight = false
    again = false
    document.removeEventListener('visibilitychange', onVisibility)
    if (stores.get(key) === store) stores.delete(key)
  }

  const store: Store = {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn)
      if (listeners.size === 1) {
        // Back after being let go (a remount): this is the pane's store again
        if (!stores.has(key)) stores.set(key, store)
        document.addEventListener('visibilitychange', onVisibility)
        schedule(0)
      }
      return () => {
        listeners.delete(fn)
        if (listeners.size === 0) forget()
      }
    },
    setLive(next) {
      if (next === live) return
      live = next
      // Started or ended: read now (an end's last lines), or right after the
      // read in flight
      if (inFlight) again = true
      else schedule(0)
    },
    setListed(next) {
      listed = next
    },
    async loadOlder() {
      if (!state.before || state.loadingOlder) return
      set({ loadingOlder: true })
      const gen = generation
      const ep = epoch
      try {
        const page = await fetchSubagentTranscript(paneId, agentId, {
          before: state.before,
        })
        if (ep !== epoch) return
        if (page.reset) apply(page)
        else if (gen === generation) {
          set({
            entries: foldToolResults([...page.entries, ...state.entries]),
            before: page.before,
          })
        }
      } catch {
        // Older entries can be asked again
      } finally {
        if (ep === epoch) set({ loadingOlder: false })
      }
    },
    drop() {
      stopped = true
      forget()
    },
  }
  return store
}

function storeFor(paneId: string, agentId: string, live: boolean): Store {
  const key = keyOf(paneId, agentId)
  let s = stores.get(key)
  if (!s) {
    s = createStore(paneId, agentId, live)
    stores.set(key, s)
  }
  return s
}

const EMPTY_STORE: Store = {
  get: () => INITIAL,
  subscribe: () => () => {},
  setLive: () => {},
  setListed: () => {},
  loadOlder: () => {},
  drop: () => {},
}

// The conversation of paneId's subagent agentId while a component shows it.
// live: the subagent runs (polled every POLL_INTERVAL, failures backing off
// up to 12 s; read once more when it stops running); listed: the tree still
// lists it, so a file not found yet is waited for rather than gone.
export function useSubagentTranscript(
  paneId: string | undefined,
  agentId: string | undefined,
  live: boolean,
  listed: boolean,
) {
  const store =
    paneId && agentId ? storeFor(paneId, agentId, live) : EMPTY_STORE
  store.setListed(listed)
  useEffect(() => store.setLive(live), [store, live])
  const state = useSyncExternalStore(store.subscribe, store.get)
  const loadOlder = useCallback(() => store.loadOlder(), [store])
  return { ...state, hasOlder: !!state.before, loadOlder }
}

// A pane id that names another pane now: its subagents' stores stop.
onPaneRemap((shift) => {
  for (const id of shift.stale) {
    for (const [key, s] of stores) {
      if (key.startsWith(`${id}\0`)) s.drop()
    }
  }
})

// For tests: forget every store.
export function resetSubagentTranscriptStores() {
  for (const s of [...stores.values()]) s.drop()
  stores.clear()
}
