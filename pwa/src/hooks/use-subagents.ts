import { useCallback, useSyncExternalStore } from 'react'
import { fetchSubagents, type Subagents } from './use-mux-api'

// A pane's subagent tree, polled every SUBAGENTS_POLL while a card shows it
// open and the page is visible; nothing is read for a closed card. What
// was read stays after it closes, for the closed card's count.

export const SUBAGENTS_POLL = 3000

export interface SubagentsState {
  tree?: Subagents
  error: boolean
}

const EMPTY: SubagentsState = { error: false }

interface Entry {
  state: SubagentsState
  listeners: Set<() => void>
  timer?: ReturnType<typeof setTimeout>
  reading: boolean
}

const entries = new Map<string, Entry>()

function entry(paneId: string): Entry {
  let e = entries.get(paneId)
  if (!e) {
    e = { state: EMPTY, listeners: new Set(), reading: false }
    entries.set(paneId, e)
  }
  return e
}

function emit(e: Entry) {
  for (const fn of e.listeners) fn()
}

async function read(paneId: string) {
  const e = entry(paneId)
  if (e.reading || document.hidden || !e.listeners.size) return
  e.reading = true
  try {
    e.state = { tree: await fetchSubagents(paneId), error: false }
  } catch {
    e.state = { ...e.state, error: true }
  } finally {
    e.reading = false
  }
  emit(e)
  clearTimeout(e.timer)
  e.timer = e.listeners.size
    ? setTimeout(() => read(paneId), SUBAGENTS_POLL)
    : undefined
}

function onVisibility() {
  if (document.hidden) return
  for (const [paneId, e] of entries) if (e.listeners.size) void read(paneId)
}

let watching = 0

function subscribe(paneId: string, fn: () => void) {
  const e = entry(paneId)
  e.listeners.add(fn)
  if (e.listeners.size === 1) {
    if (watching++ === 0) {
      document.addEventListener('visibilitychange', onVisibility)
    }
    void read(paneId)
  }
  return () => {
    e.listeners.delete(fn)
    if (e.listeners.size === 0) {
      clearTimeout(e.timer)
      e.timer = undefined
      if (--watching === 0) {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
  }
}

const noop = () => () => {}

// The pane's tree; read and polled only while open.
export function useSubagents(paneId: string, open: boolean): SubagentsState {
  const sub = useCallback((fn: () => void) => subscribe(paneId, fn), [paneId])
  return useSyncExternalStore(
    open ? sub : noop,
    () => entries.get(paneId)?.state ?? EMPTY,
  )
}

// Forgets every tree (tests).
export function resetSubagents() {
  for (const e of entries.values()) clearTimeout(e.timer)
  entries.clear()
  watching = 0
}
