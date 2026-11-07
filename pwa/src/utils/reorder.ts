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

// Where an item dragged along a row lands: the index past every item whose
// middle its leading edge has crossed (at an end of the row, past the item
// there, whatever their widths). boxes are the items' boxes as the drag
// started, from the dragged one's index, x how far it has slid.
export function slidePlace(
  boxes: Pick<DOMRect, 'left' | 'right' | 'width'>[],
  from: number,
  x: number,
): number {
  const left = boxes[from].left + x
  const right = boxes[from].right + x
  return boxes.filter((b, i) => {
    const middle = b.left + b.width / 2
    return i < from ? middle < left : i > from && middle <= right
  }).length
}

// How far item i slides aside while the dragged one (at from) would land at
// to, room being the dragged one's width and the gap after it
export const slideShift = (
  i: number,
  from: number,
  to: number,
  room: number,
) => (i > from && i <= to ? -room : i < from && i >= to ? room : 0)
