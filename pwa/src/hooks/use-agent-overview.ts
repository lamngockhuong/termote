import { useSyncExternalStore } from 'react'
import {
  fetchOverview,
  type OverviewAccount,
  type OverviewPane,
} from './use-mux-api'

// Every agent's summary (/api/mux/overview), polled while the overview is
// shown and the page is visible: one read for every card, shared by every
// reader of the store.

export const OVERVIEW_POLL = 5000

// The poll's period: the session list's (Settings), set by the readers.
let period = OVERVIEW_POLL

export interface OverviewState {
  // By pane id
  panes: ReadonlyMap<string, OverviewPane>
  // The rate limits of every Codex account a pane uses
  accounts: readonly OverviewAccount[]
  loaded: boolean
  // The last read failed; the panes are the last ones read
  error: boolean
}

const INITIAL: OverviewState = {
  panes: new Map(),
  accounts: [],
  loaded: false,
  error: false,
}

let state = INITIAL
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined
let reading = false

function emit() {
  for (const fn of listeners) fn()
}

function schedule() {
  clearTimeout(timer)
  timer = listeners.size ? setTimeout(read, period) : undefined
}

async function read() {
  // A hidden page reads nothing; it reads again once shown.
  if (reading || document.hidden) return
  reading = true
  try {
    const o = await fetchOverview()
    state = {
      panes: new Map(o.panes.map((p) => [p.paneId, p])),
      accounts: o.accounts ?? [],
      loaded: true,
      error: false,
    }
  } catch {
    state = { ...state, error: true }
  } finally {
    reading = false
  }
  emit()
  schedule()
}

function onVisibility() {
  if (!document.hidden) void read()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisibility)
    void read()
  }
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0) {
      clearTimeout(timer)
      timer = undefined
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

const get = () => state

export function useAgentOverview(interval = OVERVIEW_POLL): OverviewState {
  period = interval > 0 ? interval : OVERVIEW_POLL
  return useSyncExternalStore(subscribe, get)
}

// Forgets what was read (tests).
export function resetAgentOverview() {
  clearTimeout(timer)
  timer = undefined
  state = INITIAL
  reading = false
  period = OVERVIEW_POLL
}
