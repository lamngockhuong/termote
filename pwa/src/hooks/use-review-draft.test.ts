import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addReviewComment,
  removeReviewComments,
  resetReviewDrafts,
} from '../utils/review-draft'
import { useReviewDraft } from './use-review-draft'

afterEach(() => {
  sessionStorage.clear()
  resetReviewDrafts()
})

describe('useReviewDraft', () => {
  it("follows the pane's review", () => {
    const { result } = renderHook(() => useReviewDraft('%1'))
    expect(result.current).toEqual([])
    act(() => {
      addReviewComment('%1', {
        id: 'c1',
        root: '/r',
        path: 'a',
        source: 'file',
        start: 1,
        end: 1,
        text: 't',
        at: 1,
      })
    })
    expect(result.current.map((c) => c.id)).toEqual(['c1'])
    act(() => removeReviewComments('%1', ['c1']))
    expect(result.current).toEqual([])
  })

  it('is empty without a pane', () => {
    const { result } = renderHook(() => useReviewDraft(undefined))
    expect(result.current).toEqual([])
  })
})
