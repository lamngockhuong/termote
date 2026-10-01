import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { AgentStatus } from '../types/session'
import { type AgentPrompt, fetchAgentPrompt } from './use-mux-api'

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

interface Store {
  get: () => PromptState
  subscribe: (fn: () => void) => () => void
  refresh: () => void
  // Shows a dialog the server returned with a refusal, until the next poll
  show: (prompt: AgentPrompt | null) => void
  setStatus: (status: AgentStatus | undefined) => void
}

function createStore(paneId: string): Store {
  let state = INITIAL
  const listeners = new Set<() => void>()
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

  const visible = () => document.visibilityState === 'visible'

  // When the pending poll runs
  let dueAt = 0

  const schedule = (delay: number) => {
    clearTimeout(timer)
    timer = undefined
    if (listeners.size > 0 && visible()) {
      timer = setTimeout(poll, delay)
      dueAt = Date.now() + delay
    }
  }

  async function poll() {
    inFlight = true
    try {
      set({ prompt: await fetchAgentPrompt(paneId), loaded: true })
    } catch {
      // No session, network: no card. The transcript view reports why.
      set({ prompt: null, loaded: true })
    } finally {
      inFlight = false
    }
    const delay = again ? 0 : promptPollInterval(status)
    again = false
    schedule(delay)
  }

  const onVisibility = () => (inFlight ? undefined : schedule(0))

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn)
      if (listeners.size === 1) {
        document.addEventListener('visibilitychange', onVisibility)
        // A poll still in flight from before runs the next one when done.
        if (inFlight) again = true
        else schedule(0)
      }
      return () => {
        listeners.delete(fn)
        if (listeners.size === 0) {
          clearTimeout(timer)
          timer = undefined
          document.removeEventListener('visibilitychange', onVisibility)
          // A dialog read long ago is not shown to the next reader.
          state = INITIAL
        }
      }
    },
    refresh() {
      if (inFlight) again = true
      else schedule(0)
    },
    show: (prompt) => set({ prompt, loaded: true }),
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

// For tests: forget every store.
export function resetAgentPromptStores() {
  stores.clear()
}
