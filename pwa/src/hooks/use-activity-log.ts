import { useSyncExternalStore } from 'react'
import { renamedGroupId } from '../utils/pane-remap'
import { type ActivityEvent, fetchActivity } from './use-mux-api'

// The agents' status changes (/api/mux/activity), polled while the overview
// is shown and the page is visible: each read asks only for the events
// after the last one held, and a reset (events dropped, a restart) replaces
// them all. At most ACTIVITY_MAX are kept, as many as the server keeps.

export const ACTIVITY_POLL = 5000
export const ACTIVITY_MAX = 500

let period = ACTIVITY_POLL

export interface ActivityState {
  // Oldest first, in seq order
  events: readonly ActivityEvent[]
  loaded: boolean
  // The last read failed; the events are the last ones read
  error: boolean
}

const INITIAL: ActivityState = { events: [], loaded: false, error: false }

let state = INITIAL
let latest: number | undefined
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
    const page = await fetchActivity(latest)
    latest = page.latest
    // Nothing new keeps the same array, so the cards it feeds do not render.
    const events =
      page.reset || page.events.length
        ? (page.reset ? page.events : [...state.events, ...page.events]).slice(
            -ACTIVITY_MAX,
          )
        : state.events
    state = { events, loaded: true, error: false }
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

export function useActivityLog(interval = ACTIVITY_POLL): ActivityState {
  period = interval > 0 ? interval : ACTIVITY_POLL
  return useSyncExternalStore(subscribe, get)
}

// A Zellij group renamed from here: the server moved its events to the new
// ids and keys, and the events held move the same way.
export function renameActivityGroup(from: string, to: string) {
  if (!state.events.length) return
  state = {
    ...state,
    events: state.events.map((e) => ({
      ...e,
      key: renamedGroupId(e.key, from, to),
      groupId: renamedGroupId(e.groupId, from, to),
      tabId: renamedGroupId(e.tabId, from, to),
      paneId: renamedGroupId(e.paneId, from, to),
    })),
  }
  emit()
}

// Forgets what was read (tests).
export function resetActivityLog() {
  clearTimeout(timer)
  timer = undefined
  state = INITIAL
  latest = undefined
  reading = false
  period = ACTIVITY_POLL
}
