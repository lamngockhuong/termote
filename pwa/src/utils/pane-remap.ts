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

// The keys of the latest snapshot, with the server's instance id and each
// pane's group name: what is kept on the device for a pane (its open tabs,
// its drafts, its view) is stored under the instance and the pane's key,
// which outlive the id (a tmux window move) and the page.
let instance: string | null = null
let keyOf = new Map<string, string>()
let groupOf = new Map<string, string>()

// Records snap's keys (from paneKeys) for paneKeyOf and paneGroupOf.
// Returns the keys of the panes whose group was renamed since the last
// snapshot of the same server (the key stays, the group's name changes),
// each with the new name.
export function setPaneKeys(
  snap: MuxSnapshot,
  keys: Map<string, string>,
): Map<string, string | null> {
  const sameServer = instance !== null && instance === (snap.instanceId || null)
  const prevKey = keyOf
  const prevGroup = groupOf
  instance = snap.instanceId || null
  keyOf = keys
  groupOf = new Map()
  for (const g of snap.groups ?? []) {
    for (const t of g.tabs) {
      groupOf.set(t.id, g.name)
      for (const p of t.panes) groupOf.set(p.id, g.name)
    }
  }
  const renamed = new Map<string, string | null>()
  if (!sameServer) return renamed
  for (const [id, key] of keys) {
    const was = prevGroup.get(id)
    const now = groupOf.get(id)
    if (prevKey.get(id) === key && was !== undefined && was !== now)
      renamed.set(key, now ?? null)
  }
  return renamed
}

// The server's instance id, null before a snapshot (or from an older server)
export const paneInstance = () => instance

// paneId's key, null before a snapshot, from an older server, or for an id
// the snapshot does not list (the placeholder session '0')
export function paneKeyOf(paneId: string): string | null {
  return (instance && keyOf.get(paneId)) || null
}

// The name of the group paneId is in, null when the snapshot does not list it
export const paneGroupOf = (paneId: string) => groupOf.get(paneId) ?? null

// For tests: forget the snapshot's keys.
export function resetPaneKeys() {
  instance = null
  keyOf = new Map()
  groupOf = new Map()
}

// keys (from paneKeys) as if group from had been called to all along. A
// Zellij group's id is its session's name, and every tab id, pane id and tab
// key in it starts with the group id (`<gid>:`, `<gid>/`): comparing the
// result with the snapshot read after a rename moves each id to its new one.
export function renameGroupKeys(
  keys: Map<string, string>,
  from: string,
  to: string,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, key] of keys) out.set(id, renamedGroupId(key, from, to))
  return out
}

// id (a group, tab or pane id, or a key) with group from's prefix changed
// to to's, as the server's renamedGroupID does.
export function renamedGroupId(id: string, from: string, to: string): string {
  if (id === from) return to
  const sep = id[from.length]
  return id.startsWith(from) && (sep === ':' || sep === '/')
    ? to + id.slice(from.length)
    : id
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

// Each tmux tab whose panes no longer carry its id, with its active pane's
// id: before panes were listed, a tmux tab's one pane had the tab's id and
// key, so what this device kept under either belongs to that pane now.
// ids: tab id → pane id; keys: tab key → pane id (a pane's key is its id).
export function tabPaneMoves(snap: MuxSnapshot): {
  ids: Map<string, string>
  keys: Map<string, string>
} {
  const ids = new Map<string, string>()
  const keys = new Map<string, string>()
  if (snap.backend !== 'tmux' || snap.caps.clientSideSelect)
    return { ids, keys }
  for (const g of snap.groups ?? []) {
    for (const t of g.tabs) {
      if (!t.panes.length || t.panes.some((p) => p.id === t.id)) continue
      const pane = t.panes.find((p) => p.active) ?? t.panes[0]
      ids.set(t.id, pane.id)
      if (t.key) keys.set(t.key, pane.id)
    }
  }
  return { ids, keys }
}

// The key paneKeys gives a pane of a built session: its tab's key when the
// pane has the tab's id (tmux), else its own id.
export function sessionPaneKey(
  session: { id: string; key?: string },
  paneId: string,
): string {
  return paneId === session.id ? (session.key ?? session.id) : paneId
}
