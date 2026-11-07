import { describe, expect, it } from 'vitest'
import {
  dropIndex,
  movableGroups,
  slidePlace,
  slideShift,
  targetIndex,
} from './reorder'

const ids = ['a', 'b', 'c', 'd']

describe('targetIndex', () => {
  it('moves up and down, never past an end', () => {
    expect(targetIndex(ids, 'b', -1)).toBe(0)
    expect(targetIndex(ids, 'b', 1)).toBe(2)
    expect(targetIndex(ids, 'a', -1)).toBeNull()
    expect(targetIndex(ids, 'd', 1)).toBeNull()
    expect(targetIndex(ids, 'x', 1)).toBeNull()
  })
})

describe('dropIndex', () => {
  it('lands before or after the row dropped on', () => {
    expect(dropIndex(ids, 'd', 'a', false)).toBe(0)
    expect(dropIndex(ids, 'd', 'a', true)).toBe(1)
    expect(dropIndex(ids, 'a', 'c', true)).toBe(2)
    expect(dropIndex(ids, 'a', 'c', false)).toBe(1)
    expect(dropIndex(ids, 'a', 'd', true)).toBe(3)
    expect(dropIndex(ids, 'b', 'a', false)).toBe(0)
  })

  it('sends nothing for a drop that changes nothing', () => {
    expect(dropIndex(ids, 'b', 'b', false)).toBeNull()
    expect(dropIndex(ids, 'b', 'a', true)).toBeNull()
    expect(dropIndex(ids, 'b', 'c', false)).toBeNull()
    expect(dropIndex(ids, 'x', 'a', false)).toBeNull()
  })
})

describe('movableGroups', () => {
  it('skips linked worktrees', () => {
    expect(
      movableGroups([
        { id: 'w1', name: 'a' },
        { id: 'w2', name: 'b', worktree: { linked: false } },
        { id: 'w3', name: 'c', worktree: { linked: true } },
      ]).map((g) => g.id),
    ).toEqual(['w1', 'w2'])
  })
})

describe('slidePlace and slideShift', () => {
  // Three items of 100 px from 0, a narrow one at the end
  const boxes = [
    { left: 0, right: 100, width: 100 },
    { left: 100, right: 200, width: 100 },
    { left: 200, right: 240, width: 40 },
  ]

  it('lands past each item whose middle the leading edge crossed', () => {
    expect(slidePlace(boxes, 0, 0)).toBe(0)
    expect(slidePlace(boxes, 0, 49)).toBe(0)
    expect(slidePlace(boxes, 0, 50)).toBe(1)
    // At the end of the row, past the narrow item whatever its width
    expect(slidePlace(boxes, 0, 140)).toBe(2)
    expect(slidePlace(boxes, 2, -49)).toBe(2)
    expect(slidePlace(boxes, 2, -50)).toBe(1)
    expect(slidePlace(boxes, 2, -150)).toBe(0)
  })

  it('slides aside the items between where it was and where it lands', () => {
    expect([0, 1, 2].map((i) => slideShift(i, 0, 2, 100))).toEqual([
      0, -100, -100,
    ])
    expect([0, 1, 2].map((i) => slideShift(i, 2, 1, 40))).toEqual([0, 40, 0])
    expect(slideShift(1, 1, 1, 100)).toBe(0)
  })
})
