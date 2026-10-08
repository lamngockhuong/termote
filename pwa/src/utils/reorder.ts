import type { SessionGroup } from '../types/session'

// Groups that can be moved, in order: a Herdr linked worktree moves only
// with its repository's workspace.
export function movableGroups(groups: SessionGroup[]): SessionGroup[] {
  return groups.filter((g) => !g.worktree?.linked)
}

// The index Move up (-1) or Move down (+1) sends for id in ids, or null at
// an end (or when id is not there).
export function targetIndex(
  ids: string[],
  id: string,
  delta: -1 | 1,
): number | null {
  const at = ids.indexOf(id)
  const to = at + delta
  return at < 0 || to < 0 || to >= ids.length ? null : to
}

// The final index of dragged dropped before (after: false) or after over,
// or null when the drop changes nothing.
export function dropIndex(
  ids: string[],
  dragged: string,
  over: string,
  after: boolean,
): number | null {
  const from = ids.indexOf(dragged)
  const rest = ids.filter((id) => id !== dragged)
  const at = rest.indexOf(over)
  if (from < 0 || at < 0) return null
  const to = after ? at + 1 : at
  return to === from ? null : to
}
