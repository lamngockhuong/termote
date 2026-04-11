import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'termote-command-history'
const MAX_COMMANDS = 100

export interface HistoryCommand {
  id: string
  text: string
  timestamp: number
}

// Listeners for useSyncExternalStore
const listeners = new Set<() => void>()
let cachedHistory: HistoryCommand[] = []
let initialized = false

function loadHistory(): HistoryCommand[] {
  try {
    const json = localStorage.getItem(STORAGE_KEY)
    return json ? JSON.parse(json) : []
  } catch {
    return []
  }
}

function saveHistory(history: HistoryCommand[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
  cachedHistory = history
  for (const fn of listeners) fn()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): HistoryCommand[] {
  if (!initialized) {
    cachedHistory = loadHistory()
    initialized = true
  }
  return cachedHistory
}

export function useCommandHistory() {
  const history = useSyncExternalStore(subscribe, getSnapshot, () => [])

  const addCommand = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return

    const current = getSnapshot()
    // Remove duplicate if exists
    const filtered = current.filter((c) => c.text !== trimmed)
    // Add new command at start
    const id =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const newHistory = [
      { id, text: trimmed, timestamp: Date.now() },
      ...filtered,
    ].slice(0, MAX_COMMANDS)

    saveHistory(newHistory)
  }, [])

  const removeCommand = useCallback((id: string) => {
    const current = getSnapshot()
    saveHistory(current.filter((c) => c.id !== id))
  }, [])

  const clearHistory = useCallback(() => {
    saveHistory([])
  }, [])

  return { history, addCommand, removeCommand, clearHistory }
}
