import type { Session, SessionGroup } from '../types/session'
import { parseDeepLink } from './deep-link'
import { LOCALE_CACHE } from './notify-locale'

// Workspaces the user hid on this browser, kept as keys: the machine's id
// ('' for this server) and the group's own name, trimmed. A name, not the
// group's id: a tmux session's id ($N) is numbered anew when tmux restarts.
// notify-sw.js (hiddenKeyOf) builds the same key from a push's machineId and
// the snapshot's group name; a test checks both on the same names.
export function hiddenKey(machineId: string, name: string): string {
  return `${machineId}\u0000${name.trim()}`
}

// The saved list as an array of keys; anything else (an old or corrupt
// value) as none.
export function resolveHiddenKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((k): k is string => typeof k === 'string'))]
}

// Ids of the groups whose key is in keys, and of the linked worktrees of a
// hidden repository checkout.
export function hiddenGroupIds(
  groups: readonly SessionGroup[],
  keys: readonly string[],
  machineId: string,
): Set<string> {
  const ids = new Set<string>()
  if (keys.length === 0) return ids
  const wanted = new Set(keys)
  for (const g of groups) {
    if (wanted.has(hiddenKey(machineId, g.name))) ids.add(g.id)
  }
  for (const g of groups) {
    const parent = g.worktree?.parent
    if (parent && ids.has(parent)) ids.add(g.id)
  }
  return ids
}

// The groups and tabs not hidden, in their order.
export function visibleGroups(
  groups: SessionGroup[],
  hidden: ReadonlySet<string>,
): SessionGroup[] {
  return hidden.size === 0 ? groups : groups.filter((g) => !hidden.has(g.id))
}

export function visibleSessions(
  sessions: Session[],
  hidden: ReadonlySet<string>,
): Session[] {
  return hidden.size === 0
    ? sessions
    : sessions.filter((s) => !s.groupId || !hidden.has(s.groupId))
}

// keys with oldName's key on machineId moved to newName's (same keys when
// oldName was not hidden).
export function renameHiddenKey(
  keys: readonly string[],
  machineId: string,
  oldName: string,
  newName: string,
): string[] {
  const from = hiddenKey(machineId, oldName)
  const to = hiddenKey(machineId, newName)
  if (from === to || !keys.includes(from)) return [...keys]
  return [...new Set(keys.map((k) => (k === from ? to : k)))]
}

// Where the page keeps the list for the worker, in LOCALE_CACHE: a push
// shown while no page is open leaves a hidden workspace's name out too.
// Equal to HIDDEN_URL in public/notify-sw.js.
export const HIDDEN_URL = '/__hidden'

// Keeps keys for the worker. Nothing happens where Cache Storage is missing
// or refused: the worker then hides nothing, as before this list existed.
export async function writeHiddenForWorker(
  keys: readonly string[],
): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const cache = await caches.open(LOCALE_CACHE)
    await cache.put(
      HIDDEN_URL,
      new Response(JSON.stringify(keys), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  } catch {
    // A private window may refuse storage
  }
}

// Closes the notifications on screen that lead to a pane of group groupId on
// machine ('' for this server), once that group is hidden: they name it. The
// page's own notifications carry no machine (it is the page's), so one
// without a machine closes too: closing one too many costs nothing.
export async function closeHiddenNotifications(
  groupId: string,
  machine: string,
): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    const shown = (await reg?.getNotifications()) ?? []
    for (const n of shown) {
      const data = n.data as { hash?: unknown; machine?: unknown } | null
      const hash = typeof data?.hash === 'string' ? data.hash : ''
      const on = typeof data?.machine === 'string' ? data.machine : ''
      if ((!on || on === machine) && parseDeepLink(hash)?.group === groupId) {
        n.close()
      }
    }
  } catch {
    // No worker, or no notifications to read
  }
}
