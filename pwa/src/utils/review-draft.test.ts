import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFilesPersist, SIGNED_OUT_KEY, signedOut } from './files-persist'
import {
  addReviewComment,
  adoptReviewDrafts,
  clearReviewDrafts,
  clearReviewDraftsOnSignOut,
  commentedDiffLines,
  commentedFileLines,
  loadReview,
  MAX_REVIEW_COMMENTS,
  onReviewChange,
  type ReviewComment,
  remapReviewDrafts,
  removeReviewComments,
  resetReviewDrafts,
  updateReviewComment,
} from './review-draft'

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'c1',
  root: '/repo',
  path: 'src/a.ts',
  source: 'unstaged',
  start: 12,
  end: 18,
  quote: '+added',
  text: 'why?',
  at: 1,
  ...over,
})

afterEach(() => {
  sessionStorage.clear()
  resetReviewDrafts()
  vi.restoreAllMocks()
})

describe('review drafts', () => {
  it('are kept per pane in sessionStorage, the same array until changed', () => {
    expect(loadReview('%1')).toEqual([])
    expect(addReviewComment('%1', comment())).toBe('ok')
    const list = loadReview('%1')
    expect(list).toHaveLength(1)
    expect(loadReview('%1')).toBe(list)
    expect(loadReview('%2')).toEqual([])
    expect(
      JSON.parse(sessionStorage.getItem('termote-review:%1') as string),
    ).toEqual({ v: 1, comments: [comment()] })
    // Read back after a reload
    resetReviewDrafts()
    expect(loadReview('%1')).toEqual([comment()])
  })

  it('tell the listeners of each change', () => {
    const fn = vi.fn()
    const off = onReviewChange(fn)
    addReviewComment('%1', comment())
    updateReviewComment('%1', 'c1', 'edited')
    expect(loadReview('%1')[0].text).toBe('edited')
    expect(fn).toHaveBeenCalledTimes(2)
    // Unknown id, or no id removed: no change
    updateReviewComment('%1', 'nope', 'x')
    removeReviewComments('%1', ['nope'])
    expect(fn).toHaveBeenCalledTimes(2)
    off()
    removeReviewComments('%1', ['c1'])
    expect(fn).toHaveBeenCalledTimes(2)
    expect(loadReview('%1')).toEqual([])
    expect(sessionStorage.getItem('termote-review:%1')).toBeNull()
  })

  it('remove only the ids given', () => {
    addReviewComment('%1', comment())
    addReviewComment('%1', comment({ id: 'c2' }))
    addReviewComment('%1', comment({ id: 'c3' }))
    updateReviewComment('%1', 'c2', 'two')
    expect(loadReview('%1').map((c) => c.text)).toEqual(['why?', 'two', 'why?'])
    removeReviewComments('%1', ['c1', 'c3'])
    expect(loadReview('%1').map((c) => c.id)).toEqual(['c2'])
  })

  it('never keep the lines of a sensitive file', () => {
    addReviewComment('%1', comment({ sensitive: true, quote: 'SECRET=1' }))
    expect(loadReview('%1')[0].quote).toBeUndefined()
    expect(sessionStorage.getItem('termote-review:%1')).not.toContain('SECRET')
  })

  it(`hold ${MAX_REVIEW_COMMENTS} comments at most`, () => {
    for (let i = 0; i < MAX_REVIEW_COMMENTS; i++)
      expect(addReviewComment('%1', comment({ id: `c${i}` }))).toBe('ok')
    expect(addReviewComment('%1', comment({ id: 'over' }))).toBe('too_many')
    expect(loadReview('%1')).toHaveLength(MAX_REVIEW_COMMENTS)
  })

  it.each([
    ['not JSON', '{'],
    ['another version', JSON.stringify({ v: 2, comments: [] })],
    ['no list', JSON.stringify({ v: 1 })],
    ['null', 'null'],
    ['a bad item', JSON.stringify({ v: 1, comments: [{ id: 'x' }] })],
    ['a null item', JSON.stringify({ v: 1, comments: [null] })],
    [
      'a bad source',
      JSON.stringify({ v: 1, comments: [comment({ source: 'x' as 'file' })] }),
    ],
    [
      'a bad removed range',
      JSON.stringify({
        v: 1,
        comments: [{ ...comment(), removed: { start: 'a', end: 1 } }],
      }),
    ],
    [
      'a bad orig',
      JSON.stringify({ v: 1, comments: [{ ...comment(), orig: 1 }] }),
    ],
    [
      'a bad flag',
      JSON.stringify({ v: 1, comments: [{ ...comment(), unsaved: 1 }] }),
    ],
  ])('read as empty when storage holds %s', (_, raw) => {
    sessionStorage.setItem('termote-review:%1', raw)
    expect(loadReview('%1')).toEqual([])
    // Left as is until the review changes
    expect(sessionStorage.getItem('termote-review:%1')).toBe(raw)
  })

  it('read every optional field back', () => {
    const c = comment({
      source: 'staged',
      removed: { start: 3, end: 4 },
      removedOnly: true,
      unsaved: false,
    })
    sessionStorage.setItem(
      'termote-review:%1',
      JSON.stringify({
        v: 1,
        comments: [
          c,
          comment({
            id: 'f',
            source: 'file',
            sensitive: true,
            quote: undefined,
          }),
        ],
      }),
    )
    expect(loadReview('%1')).toHaveLength(2)
  })

  it('without storage are kept in memory, said once', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(addReviewComment('%1', comment())).toBe('memory')
    expect(addReviewComment('%1', comment({ id: 'c2' }))).toBe('ok')
    expect(loadReview('%1')).toHaveLength(2)
  })

  it('follow their pane when ids shift, all at once', () => {
    addReviewComment('1', comment({ id: 'a' }))
    addReviewComment('2', comment({ id: 'b' }))
    addReviewComment('3', comment({ id: 'c' }))
    addReviewComment('9', comment({ id: 'z' }))
    // 1 → 2, 2 → 1 (traded); 3 gone; 4 (no review) → 5
    remapReviewDrafts({
      moved: new Map([
        ['1', '2'],
        ['2', '1'],
        ['4', '5'],
      ]),
      stale: new Set(['1', '2', '3', '4', '5']),
    })
    const ids = (p: string) => loadReview(p).map((c) => c.id)
    expect([ids('1'), ids('2'), ids('3'), ids('5'), ids('9')]).toEqual([
      ['b'],
      ['a'],
      [],
      [],
      ['z'],
    ])
    resetReviewDrafts()
    expect(ids('2')).toEqual(['a'])
    expect(sessionStorage.getItem('termote-review:3')).toBeNull()
  })
})

describe('signing out', () => {
  beforeEach(() => clearReviewDraftsOnSignOut())
  afterEach(() => resetFilesPersist())

  it('clears every review of this tab', () => {
    addReviewComment('1', comment())
    sessionStorage.setItem('other', 'kept')
    const fn = vi.fn()
    const off = onReviewChange(fn)
    signedOut()
    off()
    expect(fn).toHaveBeenCalled()
    expect(loadReview('1')).toEqual([])
    expect(sessionStorage.getItem('termote-review:1')).toBeNull()
    expect(sessionStorage.getItem('other')).toBe('kept')
  })

  it('in another tab clears them too', () => {
    addReviewComment('1', comment())
    window.dispatchEvent(
      new StorageEvent('storage', { key: SIGNED_OUT_KEY, newValue: '1' }),
    )
    expect(loadReview('1')).toEqual([])
  })

  it('without storage clears what it holds', () => {
    addReviewComment('1', comment())
    vi.spyOn(Object, 'keys').mockImplementationOnce(() => {
      throw new Error('denied')
    })
    clearReviewDrafts()
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null)
    expect(loadReview('1')).toEqual([])
  })
})

describe('commented lines', () => {
  const list = [
    comment({ start: 2, end: 3, removed: { start: 7, end: 7 } }),
    comment({
      id: 'r',
      start: 9,
      end: 9,
      removed: { start: 4, end: 5 },
      removedOnly: true,
    }),
    comment({ id: 's', source: 'staged', start: 1, end: 1 }),
    comment({ id: 'o', path: 'other', start: 1, end: 1 }),
    comment({ id: 'x', root: '/x', start: 1, end: 1 }),
    comment({ id: 'f', source: 'file', start: 5, end: 6 }),
    comment({ id: 'p', start: 20, end: 20 }),
  ]

  it('of a diff, by side and number', () => {
    expect([
      ...commentedDiffLines(list, '/repo', 'src/a.ts', 'unstaged'),
    ]).toEqual(['n:2', 'n:3', 'o:7', 'o:4', 'o:5', 'n:20'])
  })

  it('of a file', () => {
    expect([...commentedFileLines(list, '/repo', 'src/a.ts')]).toEqual([5, 6])
    // A range read backwards is empty
    expect([
      ...commentedFileLines(
        [comment({ source: 'file', start: 3, end: 2 })],
        '/repo',
        'src/a.ts',
      ),
    ]).toEqual([])
  })
})

describe('adoptReviewDrafts', () => {
  it('moves a review to its new key unless one is kept there', () => {
    addReviewComment('0', comment())
    addReviewComment('1', comment({ id: 'c2' }))
    addReviewComment('%5', comment({ id: 'c3' }))
    adoptReviewDrafts(
      new Map([
        ['0', '%3'],
        ['1', '%5'],
        ['2', '%6'],
      ]),
    )
    expect(loadReview('%3').map((c) => c.id)).toEqual(['c1'])
    expect(loadReview('0')).toEqual([])
    expect(loadReview('%5').map((c) => c.id)).toEqual(['c3'])
    expect(loadReview('1')).toEqual([])
    expect(loadReview('%6')).toEqual([])
  })
})
