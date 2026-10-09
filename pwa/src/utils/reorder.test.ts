import { describe, expect, it } from 'vitest'
import { dropIndex, movableGroups, targetIndex } from './reorder'

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
