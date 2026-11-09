import { useCallback, useSyncExternalStore } from 'react'

export const FONT_SIZE_MIN = 6
export const FONT_SIZE_MAX = 24
// Also the size a server-fixed grid is measured at before zooming.
export const DEFAULT_SIZE = 14
export const FONT_SIZE_KEY = 'terminal-font-size'

// A saved terminal font size, kept when it is a whole number in range
// (storage holds it as text)
export function resolveFontSize(value: unknown): number {
  const n = typeof value === 'string' && value !== '' ? Number(value) : value
  return Number.isInteger(n) &&
    (n as number) >= FONT_SIZE_MIN &&
    (n as number) <= FONT_SIZE_MAX
    ? (n as number)
    : DEFAULT_SIZE
}

// Read from storage on every call, so a change made by another tab, or by
// an applied proposal, shows at once
const listeners = new Set<() => void>()

export function readStoredFontSize(): number {
  try {
    return resolveFontSize(localStorage.getItem(FONT_SIZE_KEY))
  } catch {
    return DEFAULT_SIZE
  }
}

function notify() {
  for (const fn of listeners) fn()
}

// Another tab of this browser changed the size
function onStorage(e: StorageEvent) {
  if (e.key === FONT_SIZE_KEY || e.key === null) notify()
}

function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}

// Save the terminal font size of this browser; every terminal shows it
export function setStoredFontSize(size: number) {
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(resolveFontSize(size)))
  } catch {
    // storage full or blocked: nothing to keep
  }
  notify()
}

export function useFontSize() {
  const fontSize = useSyncExternalStore(
    subscribe,
    readStoredFontSize,
    /* v8 ignore next */
    () => DEFAULT_SIZE,
  )

  const increase = useCallback(() => {
    setStoredFontSize(Math.min(readStoredFontSize() + 2, FONT_SIZE_MAX))
  }, [])

  const decrease = useCallback(() => {
    setStoredFontSize(Math.max(readStoredFontSize() - 2, FONT_SIZE_MIN))
  }, [])

  const reset = useCallback(() => {
    setStoredFontSize(DEFAULT_SIZE)
  }, [])

  return { fontSize, increase, decrease, reset }
}
