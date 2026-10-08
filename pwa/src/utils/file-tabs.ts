// Open files as tabs: which tab a file opens in, which one shows after a
// close, and which ones go once there are too many. Pure, so the Files and
// Changes views keep their own tabs with the same rules.

// Past this many tabs the least recently used clean one closes
export const MAX_TABS = 10

export interface TabBase {
  id: string
  // A preview tab (not pinned) is replaced by the next file opened with a
  // single click; at most one exists
  pinned: boolean
  // When the tab was last shown, from a counter of the caller's (higher is
  // more recent)
  lastUsed: number
}

export interface OpenOptions {
  // Opened as a tab of its own, kept until closed
  pin?: boolean
}

// Opens the tab whose key is key, made by make when there is none, and
// shows it. A file already open shows its tab (pinned if asked); one opened
// unpinned replaces the clean preview tab in place (a preview tab with
// unsaved changes is pinned instead: it is kept); else a new tab follows
// the one shown. Then tabs past max close (see enforceCap).
export function openTab<T extends TabBase>(
  tabs: T[],
  activeId: string | null,
  keyOf: (t: T) => string,
  key: string,
  make: () => T,
  opts: OpenOptions,
  isDirty: (t: T) => boolean,
  now: number,
  max = MAX_TABS,
): { tabs: T[]; activeId: string; closed: T[] } {
  const pin = !!opts.pin
  const found = tabs.find((t) => keyOf(t) === key)
  if (found) {
    const tab = { ...found, lastUsed: now, pinned: found.pinned || pin }
    return {
      tabs: tabs.map((t) => (t === found ? tab : t)),
      activeId: tab.id,
      closed: [],
    }
  }
  const tab = { ...make(), pinned: pin, lastUsed: now }
  const preview = pin ? undefined : tabs.find((t) => !t.pinned && !isDirty(t))
  let next: T[]
  if (preview) {
    next = tabs.map((t) => (t === preview ? tab : t))
  } else {
    next = pin
      ? [...tabs]
      : tabs.map((t) => (t.pinned ? t : { ...t, pinned: true }))
    const at = next.findIndex((t) => t.id === activeId)
    next.splice(at < 0 ? next.length : at + 1, 0, tab)
  }
  const capped = enforceCap(next, tab.id, isDirty, max)
  return {
    tabs: capped.tabs,
    activeId: tab.id,
    closed: preview ? [preview, ...capped.closed] : capped.closed,
  }
}

// Closes tab id. When it was the one shown, the tab to its right shows,
// else the one to its left, else none (activeId null).
export function closeTab<T extends TabBase>(
  tabs: T[],
  activeId: string | null,
  id: string,
): { tabs: T[]; activeId: string | null } {
  const at = tabs.findIndex((t) => t.id === id)
  if (at < 0) return { tabs, activeId }
  const next = tabs.filter((t) => t.id !== id)
  if (activeId !== id) return { tabs: next, activeId }
  return { tabs: next, activeId: (next[at] ?? next[at - 1])?.id ?? null }
}

export function pinTab<T extends TabBase>(tabs: T[], id: string): T[] {
  return tabs.map((t) =>
    t.id === id && !t.pinned ? { ...t, pinned: true } : t,
  )
}

// Closes the least recently used tabs past max, never the one shown nor
// one with unsaved changes: when every other tab has some, more than max
// stay open.
export function enforceCap<T extends TabBase>(
  tabs: T[],
  activeId: string | null,
  isDirty: (t: T) => boolean,
  max = MAX_TABS,
): { tabs: T[]; closed: T[] } {
  let next = tabs
  const closed: T[] = []
  while (next.length > max) {
    let oldest: T | undefined
    for (const t of next) {
      if (t.id === activeId || isDirty(t)) continue
      if (!oldest || t.lastUsed < oldest.lastUsed) oldest = t
    }
    if (!oldest) break
    const gone = oldest
    closed.push(gone)
    next = next.filter((t) => t !== gone)
  }
  return { tabs: next, closed }
}
