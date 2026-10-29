import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { AgentStatus } from '../types/session'
import { onPaneRemap } from '../utils/pane-remap'
import {
  type AgentActivity,
  type AgentPrompt,
  fetchAgentPrompt,
} from './use-mux-api'

// The dialog a pane's Claude Code has open, polled from its screen. Like the
// transcript, one store per pane serves every reader, so the composer and
// the view never poll it twice.

// A dialog can open any moment while the agent works or waits; idle or done,
// it rarely does.
export const FAST_POLL = 1000
export const SLOW_POLL = 4000

export function promptPollInterval(status: AgentStatus | undefined): number {
  return status === 'blocked' || status === 'working' ? FAST_POLL : SLOW_POLL
}

export interface PromptState {
  prompt: AgentPrompt | null
  loaded: boolean
}

const INITIAL: PromptState = { prompt: null, loaded: false }

// The agent's working line, read with the dialog. Its own readers: the time
// in it changes every read while the agent works, and only the row that
// shows it should render again for that.
export interface ActivityState {
  activity: AgentActivity | null
  // A dialog is open, the agent waits on it rather than works
  dialog: boolean
}

const NO_ACTIVITY: ActivityState = { activity: null, dialog: false }

interface Store {
  get: () => PromptState
  subscribe: (fn: () => void) => () => void
  getActivity: () => ActivityState
  subscribeActivity: (fn: () => void) => () => void
  refresh: () => void
  // Shows a dialog the server returned with a refusal, until the next poll
  show: (prompt: AgentPrompt | null) => void
  setStatus: (status: AgentStatus | undefined) => void
}

function createStore(paneId: string): Store {
  let state = INITIAL
  let live = NO_ACTIVITY
  const listeners = new Set<() => void>()
  const liveListeners = new Set<() => void>()
  // Every reader of either part, which polls while there is one
  const readers = () => listeners.size + liveListeners.size
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let again = false
  let status: AgentStatus | undefined

  const set = (next: PromptState) => {
    // Same dialog, same id: nothing to re-render.
    if (
      next.loaded === state.loaded &&
      JSON.stringify(next.prompt) === JSON.stringify(state.prompt)
    ) {
      return
    }
    state = next
    for (const fn of listeners) fn()
  }

  const setLive = (activity: AgentActivity | null) => {
    const next = { activity, dialog: state.prompt !== null }
    if (JSON.stringify(next) === JSON.stringify(live)) return
    live = next
    for (const fn of liveListeners) fn()
  }

  const visible = () => document.visibilityState === 'visible'

  // When the pending poll runs
  let dueAt = 0

  const schedule = (delay: number) => {
    clearTimeout(timer)
    timer = undefined
    if (readers() > 0 && visible()) {
      timer = setTimeout(poll, delay)
      dueAt = Date.now() + delay
    }
  }

  async function poll() {
    inFlight = true
    try {
      const read = await fetchAgentPrompt(paneId)
      set({ prompt: read.prompt, loaded: true })
      setLive(read.activity)
    } catch {
      // No session, network: no card. The transcript view reports why.
      set({ prompt: null, loaded: true })
      setLive(null)
    } finally {
      inFlight = false
    }
    const delay = again ? 0 : promptPollInterval(status)
    again = false
    schedule(delay)
  }

  const onVisibility = () => (inFlight ? undefined : schedule(0))

  // Adds fn to set; the first reader starts polling, the last one stops it.
  const join = (set: Set<() => void>, fn: () => void) => {
    set.add(fn)
    if (readers() === 1) {
      document.addEventListener('visibilitychange', onVisibility)
      // A poll still in flight from before runs the next one when done.
      if (inFlight) again = true
      else schedule(0)
    }
    return () => {
      set.delete(fn)
      if (readers() === 0) {
        clearTimeout(timer)
        timer = undefined
        document.removeEventListener('visibilitychange', onVisibility)
        // A dialog read long ago is not shown to the next reader.
        state = INITIAL
        live = NO_ACTIVITY
      }
    }
  }

  return {
    get: () => state,
    subscribe: (fn) => join(listeners, fn),
    getActivity: () => live,
    subscribeActivity: (fn) => join(liveListeners, fn),
    refresh() {
      if (inFlight) again = true
      else schedule(0)
    },
    show(prompt) {
      set({ prompt, loaded: true })
      setLive(live.activity)
    },
    setStatus(next) {
      status = next
      // Working now: a poll due later than the new pace comes sooner.
      const interval = promptPollInterval(next)
      if (timer && dueAt > Date.now() + interval) schedule(interval)
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

const EMPTY_STORE: Store = {
  get: () => INITIAL,
  subscribe: () => () => {},
  getActivity: () => NO_ACTIVITY,
  subscribeActivity: () => () => {},
  refresh: () => {},
  show: () => {},
  setStatus: () => {},
}

// The open dialog of paneId's agent; status sets how often it is polled.
export function useAgentPrompt(
  paneId: string | undefined,
  status: AgentStatus | undefined,
) {
  const store = paneId ? storeFor(paneId) : EMPTY_STORE
  const state = useSyncExternalStore(store.subscribe, store.get)
  useEffect(() => store.setStatus(status), [store, status])
  const refresh = useCallback(() => store.refresh(), [store])
  const show = useCallback((p: AgentPrompt | null) => store.show(p), [store])
  return { ...state, refresh, show }
}

// The working line of paneId's agent, polled with its dialog (one read
// serves both); status sets how often.
export function useAgentActivity(
  paneId: string | undefined,
  status: AgentStatus | undefined,
): ActivityState {
  const store = paneId ? storeFor(paneId) : EMPTY_STORE
  const state = useSyncExternalStore(store.subscribeActivity, store.getActivity)
  useEffect(() => store.setStatus(status), [store, status])
  return state
}

// A pane id that names another pane now starts again from the server.
onPaneRemap((shift) => {
  for (const id of shift.stale) stores.delete(id)
})

// For tests: forget every store.
export function resetAgentPromptStores() {
  stores.clear()
}
