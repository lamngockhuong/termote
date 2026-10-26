import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addReviewComment,
  loadReview,
  MAX_REVIEW_COMMENTS,
  resetReviewDrafts,
} from '../utils/review-draft'
import { useReviewComposer } from './use-review-composer'

afterEach(() => {
  sessionStorage.clear()
  resetReviewDrafts()
  vi.restoreAllMocks()
})

const range = { start: 3, end: 4, quote: 'x' }

describe('useReviewComposer', () => {
  it('opens on lines of a file under the root, then adds the comment', () => {
    const notify = vi.fn()
    const { result } = renderHook(() => useReviewComposer('%1', '/r', notify))
    act(() => result.current.open('a.ts', 'staged', range, 'old.ts'))
    expect(result.current.target).toEqual({
      root: '/r',
      path: 'a.ts',
      orig: 'old.ts',
      source: 'staged',
      ...range,
    })
    act(() => result.current.save('Why?'))
    expect(result.current.target).toBeNull()
    const [c] = loadReview('%1')
    expect(c).toMatchObject({ path: 'a.ts', text: 'Why?', start: 3 })
    expect(c.id).toMatch(/^\d+-/)
    expect(result.current.comments).toHaveLength(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it('opens nothing before the root is read, and closes', () => {
    const { result, rerender } = renderHook(
      ({ root }: { root?: string }) => useReviewComposer('%1', root, vi.fn()),
      { initialProps: {} },
    )
    act(() => result.current.open('a.ts', 'file', range))
    expect(result.current.target).toBeNull()
    rerender({ root: '/r' })
    act(() => result.current.open('a.ts', 'file', range))
    expect(result.current.target).not.toHaveProperty('orig')
    act(() => result.current.close())
    expect(result.current.target).toBeNull()
  })

  const fill = (n: number) => {
    for (let i = 0; i < n; i++)
      addReviewComment('%1', {
        id: `${i}`,
        root: '/r',
        path: 'a',
        source: 'file',
        start: 1,
        end: 1,
        text: 't',
        at: 1,
      })
  }

  it('says when the review is full, before writing', () => {
    fill(MAX_REVIEW_COMMENTS)
    const notify = vi.fn()
    const { result } = renderHook(() => useReviewComposer('%1', '/r', notify))
    act(() => result.current.open('a.ts', 'file', range))
    expect(result.current.target).toBeNull()
    expect(notify).toHaveBeenCalledWith('Review is full (50 comments)', {
      variant: 'warning',
    })
  })

  it('says when it filled up while writing', () => {
    fill(MAX_REVIEW_COMMENTS - 1)
    const notify = vi.fn()
    const { result } = renderHook(() => useReviewComposer('%1', '/r', notify))
    act(() => result.current.open('a.ts', 'file', range))
    act(() => fill(1))
    act(() => result.current.save('late'))
    expect(notify).toHaveBeenCalledWith('Review is full (50 comments)', {
      variant: 'warning',
    })
  })

  it('says once when the browser cannot store it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const notify = vi.fn()
    const { result } = renderHook(() => useReviewComposer('%1', '/r', notify))
    act(() => result.current.open('a.ts', 'file', range))
    act(() => result.current.save('one'))
    expect(notify).toHaveBeenCalledWith(
      'The browser cannot store the review: it is lost on reload',
      { variant: 'warning' },
    )
  })
})
