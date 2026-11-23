import { describe, expect, it } from 'vitest'
import { overviewOrder } from './overview-order'

describe('overviewOrder', () => {
  it('puts the heaviest status first, then the newest in it, those without a time last', () => {
    const cards = [
      { id: 'idle', status: 'idle' as const, since: '2026-10-13T09:00:00Z' },
      { id: 'new', status: 'working' as const, since: '2026-10-13T09:05:00Z' },
      { id: 'old', status: 'working' as const, since: '2026-10-13T09:01:00Z' },
      { id: 'none' },
      { id: 'blocked', status: 'blocked' as const },
      { id: 'done', status: 'done' as const, since: 'not a time' },
    ]
    expect(overviewOrder(cards).map((c) => c.id)).toEqual([
      'blocked',
      'new',
      'old',
      'done',
      'idle',
      'none',
    ])
  })
  it('puts the agent waiting on the user longest first', () => {
    const cards = [
      { id: 'none', status: 'blocked' as const },
      { id: 'new', status: 'blocked' as const, since: '2026-10-13T09:05:00Z' },
      { id: 'old', status: 'blocked' as const, since: '2026-10-13T09:01:00Z' },
    ]
    expect(overviewOrder(cards).map((c) => c.id)).toEqual([
      'old',
      'new',
      'none',
    ])
  })
  it('keeps the given order on a tie', () => {
    const cards = [
      { id: 'a', status: 'done' as const },
      { id: 'b', status: 'done' as const },
    ]
    expect(overviewOrder(cards).map((c) => c.id)).toEqual(['a', 'b'])
  })
})
