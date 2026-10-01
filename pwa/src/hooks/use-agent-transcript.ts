import { useCallback, useSyncExternalStore } from 'react'
import {
  AgentRequestError,
  fetchTranscript,
  type TranscriptEntry,
  type TranscriptPage,
} from './use-mux-api'

// The conversation of a pane's agent, polled from its transcript. One store
// per pane is shared by every component that shows it (the chat view and its
// composer), so a pane is polled once however many read it.

export const POLL_INTERVAL = 1500
const MAX_BACKOFF = 12000

export type TranscriptError =
  // No agent session in the pane, or its transcript is not on disk
  | 'no-session'
  // The request failed (network, server)
  | 'unavailable'

export interface TranscriptState {
  entries: TranscriptEntry[]
  sessionId?: string
  status?: string
  // Position of the next forward read; sent with a message so the server can
  // refuse one meant for another session
  cursor?: string
  // Reads older entries; undefined once the start is reached
  before?: string
  loaded: boolean
  loadingOlder: boolean
  error?: TranscriptError
}

const INITIAL: TranscriptState = {
  entries: [],
  loaded: false,
  loadingOlder: false,
}

// Moves each orphan tool result onto the call with its toolId earlier in the
// list, dropping entries left empty. The input is left as is, and an entry
// nothing changed in is returned as the same object, so a poll that brings
// nothing new does not re-render (and re-parse) every message.
export function foldToolResults(entries: TranscriptEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  const calls = new Map<string, [number, number]>()
  for (const e of entries) {
    const kept: TranscriptEntry['parts'] = []
    let changed = false
    for (const p of e.parts) {
      if (p.kind !== 'tool' || !p.toolId) {
        kept.push(p)
        continue
      }
      if (!p.orphan) {
        calls.set(p.toolId, [out.length, kept.length])
        kept.push(p)
        continue
      }
      const at = calls.get(p.toolId)
      if (!at) {
        kept.push(p)
        continue
      }
      calls.delete(p.toolId)
      changed = true
      let parts = kept // the call is in this same entry
      if (at[0] < out.length) {
        out[at[0]] = { ...out[at[0]], parts: [...out[at[0]].parts] }
        parts = out[at[0]].parts
      }
      const call = parts[at[1]]
      parts[at[1]] = {
        ...call,
        result: p.result,
        isError: p.isError,
        clipped: call.clipped || p.clipped,
      }
    }
    if (kept.length > 0) out.push(changed ? { ...e, parts: kept } : e)
  }
  return out
}

interface Store {
  get: () => TranscriptState
  subscribe: (fn: () => void) => () => void
  refresh: () => void
  loadOlder: () => void
}

function createStore(paneId: string): Store {
  let state = INITIAL
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let failures = 0

  const set = (next: Partial<TranscriptState>) => {
    state = { ...state, ...next }
    for (const fn of listeners) fn()
  }

  // Bumped by every reset: a read started before it belongs to the old list
  // and is dropped.
  let generation = 0

  const apply = (page: TranscriptPage) => {
    if (page.reset) generation++
    if (!page.reset && page.entries.length === 0) {
      // Nothing new: notify only if something visible changed.
      if (
        state.loaded &&
        !state.error &&
        state.cursor === page.cursor &&
        state.status === page.status
      ) {
        return
      }
      set({
        cursor: page.cursor,
        status: page.status,
        loaded: true,
        error: undefined,
      })
      return
    }
    const entries = page.reset
      ? page.entries
      : [...state.entries, ...page.entries]
    set({
      entries: foldToolResults(entries),
      sessionId: page.sessionId,
      status: page.status,
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
    if (listeners.size > 0 && visible()) timer = setTimeout(poll, delay)
  }

  // A refresh asked for while a poll is in flight runs right after it.
  let again = false

  async function poll() {
    if (inFlight) {
      again = true
      return
    }
    inFlight = true
    const gen = generation
    try {
      const page = await fetchTranscript(paneId, { cursor: state.cursor })
      // A forward page read against a list replaced meanwhile would add
      // entries twice; the next poll reads from the new cursor.
      if (page.reset || gen === generation) apply(page)
      failures = 0
    } catch (err) {
      failures++
      const noSession = err instanceof AgentRequestError && err.status === 404
      set({ loaded: true, error: noSession ? 'no-session' : 'unavailable' })
    } finally {
      inFlight = false
    }
    const delay = again
      ? 0
      : Math.min(POLL_INTERVAL * 2 ** Math.max(0, failures - 1), MAX_BACKOFF)
    again = false
    schedule(delay)
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
    refresh() {
      // Mid-poll, a timer set now would be replaced when the poll ends.
      if (inFlight) again = true
      else schedule(0)
    },
    async loadOlder() {
      if (!state.before || state.loadingOlder) return
      set({ loadingOlder: true })
      const gen = generation
      try {
        const page = await fetchTranscript(paneId, { before: state.before })
        if (page.reset) {
          apply(page)
        } else if (gen === generation) {
          set({
            entries: foldToolResults([...page.entries, ...state.entries]),
            before: page.before,
          })
        }
      } catch {
        // The next poll reports the error; older entries can be asked again.
      } finally {
        set({ loadingOlder: false })
      }
    },
  }
}

const stores = new Map<string, Store>()

// Stores are kept once made (one per pane seen), so a reader that comes back
// starts from what was already read.
function storeFor(paneId: string): Store {
  let s = stores.get(paneId)
  if (!s) {
    s = createStore(paneId)
    stores.set(paneId, s)
  }
  return s
}

const EMPTY_STORE: Store = {
  get: () => INITIAL,
  subscribe: () => () => {},
  refresh: () => {},
  loadOlder: () => {},
}

// The transcript of paneId's agent, polled every POLL_INTERVAL while a
// component shows it and the page is visible; failures back off up to 12s.
export function useAgentTranscript(paneId: string | undefined) {
  const store = paneId ? storeFor(paneId) : EMPTY_STORE
  const state = useSyncExternalStore(store.subscribe, store.get)
  const refresh = useCallback(() => store.refresh(), [store])
  const loadOlder = useCallback(() => store.loadOlder(), [store])
  return { ...state, refresh, loadOlder }
}

// For tests: forget every store.
export function resetAgentTranscriptStores() {
  stores.clear()
}
