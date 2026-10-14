import { describe, expect, it } from 'vitest'
import {
  ANSWER_GRACE,
  advance,
  type Blocked,
  EMPTY_QUEUE,
  markAnswered,
  markSent,
  paneOf,
  unskip,
  updateQueue,
  waitKey,
} from './needs-me-queue'

const b = (paneId: string, min?: number): Blocked => ({
  paneId,
  since:
    min === undefined
      ? undefined
      : `2026-10-13T09:${String(min).padStart(2, '0')}:00Z`,
})
const pane = (key: string | null) => (key === null ? null : paneOf(key))

describe('needs-me queue', () => {
  it('names a wait by its pane and since', () => {
    expect(paneOf(waitKey(b('w1:p1', 3)))).toBe('w1:p1')
    expect(paneOf(waitKey(b('w1:p1')))).toBe('w1:p1')
  })

  it('starts with the one blocked longest, the rest in order', () => {
    const q = updateQueue(EMPTY_QUEUE, [b('new', 5), b('none'), b('old', 1)])
    expect(pane(q.current)).toBe('old')
    expect(q.waiting.map(paneOf)).toEqual(['new', 'none'])
  })

  it('pins the card on top: an older newcomer goes to the end', () => {
    let q = updateQueue(EMPTY_QUEUE, [b('a', 5), b('c', 6)])
    q = updateQueue(q, [b('a', 5), b('c', 6), b('older', 1)])
    expect(pane(q.current)).toBe('a')
    expect(q.waiting.map(paneOf)).toEqual(['c', 'older'])
  })

  it('an answer stays on top until Next; the wait stays out while it lasts', () => {
    let q = updateQueue(EMPTY_QUEUE, [b('a', 1), b('c', 2)])
    q = markAnswered(q)
    expect(q).toMatchObject({ answered: true })
    // The snapshot lags (still blocked), then the agent moves on
    q = updateQueue(q, [b('a', 1), b('c', 2)])
    q = updateQueue(q, [b('c', 2)])
    expect(pane(q.current)).toBe('a')
    expect(q.answered).toBe(true)
    q = advance(q, [b('c', 2)])
    expect(pane(q.current)).toBe('c')
    expect(q.skipped.size).toBe(0)
    expect(q.waiting).toEqual([])
  })

  it('the next wait of an answered pane comes in, even never seen idle', () => {
    let q = updateQueue(EMPTY_QUEUE, [b('a', 1), b('c', 2)])
    q = advance(markAnswered(q), [b('a', 1), b('c', 2)])
    // A second dialog right after the first: blocked again, a new since
    q = updateQueue(q, [b('a', 3), b('c', 2)])
    expect(q.waiting.map(paneOf)).toEqual(['a'])
  })

  it('an answered wait still blocked past the grace is a new dialog', () => {
    let q = updateQueue(EMPTY_QUEUE, [b('a', 1)], 0)
    q = advance(markAnswered(q, 0), [b('a', 1)], 0)
    expect(q.current).toBeNull()
    // Asked again within one snapshot poll: the since did not change
    expect(updateQueue(q, [b('a', 1)], ANSWER_GRACE - 1).current).toBeNull()
    expect(pane(updateQueue(q, [b('a', 1)], ANSWER_GRACE).current)).toBe('a')
  })

  it('leaving blocked after a choice sent from here is an answer', () => {
    let q = updateQueue(EMPTY_QUEUE, [b('a', 1), b('c', 2)])
    expect(markSent(EMPTY_QUEUE)).toBe(EMPTY_QUEUE)
    q = markSent(q)
    q = updateQueue(q, [b('c', 2)])
    expect(q).toMatchObject({ answered: true, sent: true })
    expect(pane(q.current)).toBe('a')
    q = advance(q, [b('c', 2)])
    expect(q).toMatchObject({ sent: false, answered: false })
    expect(pane(q.current)).toBe('c')
  })

  it('a card whose agent stopped waiting leaves the top', () => {
    let q = updateQueue(EMPTY_QUEUE, [b('a', 1), b('c', 2)])
    q = updateQueue(q, [b('c', 2)])
    expect(pane(q.current)).toBe('c')
  })

  it('skip keeps the wait out until shown again', () => {
    let q = updateQueue(EMPTY_QUEUE, [b('a', 1), b('c', 2)])
    q = advance(q, [b('a', 1), b('c', 2)])
    q = advance(q, [b('a', 1), b('c', 2)])
    expect(q.current).toBeNull()
    expect(q.skipped.size).toBe(2)
    expect(markAnswered(q)).toBe(q)
    expect(advance(q, [b('a', 1), b('c', 2)]).current).toBeNull()
    q = unskip(q, [b('a', 1), b('c', 2)])
    expect(pane(q.current)).toBe('a')
    // A skipped wait that ended is forgotten
    q = advance(q, [b('a', 1), b('c', 2)])
    expect(updateQueue(q, [b('c', 2)]).skipped.size).toBe(0)
  })
})
