import type { MuxSnapshot } from '../hooks/use-mux-api'

// A tmux tab's id is a window index, which a move (or renumber-windows)
// shifts: the id then names another window. The snapshot carries a key per
// tab that never changes, so state kept by id here can follow its window.
//
// moved: old id → the id its tab has now. stale: every id that names
// something else than before (moved from or to, or gone), whose
// server-derived caches must be read again.
export interface PaneShift {
  moved: Map<string, string>
  stale: Set<string>
}

// Every tab and pane id of snap with its key. A pane that has its tab's id
// (tmux) has the tab's key; any other pane id (Herdr) never shifts.
export function paneKeys(snap: MuxSnapshot): Map<string, string> {
  const keys = new Map<string, string>()
  for (const g of snap.groups ?? []) {
    for (const t of g.tabs) {
      keys.set(t.id, t.key ?? t.id)
      for (const p of t.panes) if (p.id !== t.id) keys.set(p.id, p.id)
    }
  }
  return keys
}

// What changed between two snapshots' keys.
export function shiftedIds(
  prev: Map<string, string>,
  next: Map<string, string>,
): PaneShift {
  const byKey = new Map<string, string>()
  for (const [id, key] of next) byKey.set(key, id)
  const moved = new Map<string, string>()
  const stale = new Set<string>()
  for (const [id, key] of prev) {
    if (next.get(id) === key) continue
    stale.add(id)
    const to = byKey.get(key)
    if (to !== undefined) {
      moved.set(id, to)
      stale.add(to)
    }
  }
  return { moved, stale }
}

// Where state kept under id goes: its new id, null when it is to be dropped
// (the id now names another tab, or its tab is gone), else the id itself.
export function destination(shift: PaneShift, id: string): string | null {
  const to = shift.moved.get(id)
  if (to !== undefined) return to
  return shift.stale.has(id) ? null : id
}

// Re-keys map's entries by destination, all at once: the ids of a shifted
// run form a chain (1 → 2, 2 → 3). idOf reads the pane id from an entry's
// key and withId puts another one in (for keys that hold more than the id).
export function remapEntries<T>(
  map: Map<string, T>,
  shift: PaneShift,
  idOf: (key: string) => string = (k) => k,
  withId: (key: string, id: string) => string = (_, id) => id,
) {
  const changes: [string, T][] = []
  for (const [k, v] of map) {
    const id = idOf(k)
    if (!shift.stale.has(id)) continue
    map.delete(k)
    const to = destination(shift, id)
    if (to !== null) changes.push([withId(k, to), v])
  }
  for (const [k, v] of changes) map.set(k, v)
}

type Handler = (shift: PaneShift) => void
const handlers = new Set<Handler>()

// Registers what a module does when ids shift; returns the unregister.
export function onPaneRemap(fn: Handler): () => void {
  handlers.add(fn)
  return () => {
    handlers.delete(fn)
  }
}

// Tells every module about a shift (nothing to tell when none).
export function remapPanes(shift: PaneShift) {
  if (shift.stale.size === 0) return
  for (const fn of handlers) fn(shift)
}
