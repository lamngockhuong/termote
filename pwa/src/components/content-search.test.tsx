import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RequestError,
  type SearchMatch,
  type SearchResponse,
} from '../hooks/use-mux-api'
import { FIND_EXCLUDES_DEFAULT } from '../hooks/use-settings'
import {
  CONTENT_SEARCH_INITIAL,
  ContentSearch,
  type ContentSearchState,
  Marked,
  matchStart,
  SEARCH_DEBOUNCE_MS,
  splitGlobs,
} from './content-search'

const mockSearch = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  searchFiles: (...a: unknown[]) => mockSearch(...a),
}))

const match = (line: number, text: string, ranges: [number, number][]) => ({
  line,
  text,
  col: 0,
  ranges,
})

const found = (over: Partial<SearchResponse> = {}): SearchResponse => ({
  root: '/r',
  isRepo: true,
  files: [
    {
      path: 'src/a.ts',
      matches: [
        match(3, 'const foo = 1', [[6, 9]]),
        match(9, 'foo(foo)', [
          [0, 3],
          [4, 7],
        ]),
      ],
      more: 0,
    },
    { path: 'b.md', matches: [match(1, '# foo', [[2, 5]])], more: 4 },
  ],
  truncated: false,
  incomplete: false,
  skipped: { sensitive: 0, hidden: 0, binary: 0, tooLarge: 0 },
  ...over,
})

interface HarnessProps {
  initial?: Partial<ContentSearchState>
  root?: string
  tick?: number
  focusTick?: number
  onPick?: (p: string, m: SearchMatch) => void
  onRootChanged?: (r: string) => void
  // The state the caller keeps, seen by the test
  seen?: { state?: ContentSearchState }
  // The search in place (a file shown instead when false)
  shown?: boolean
}

function Harness({
  initial,
  root = '/r',
  tick = 0,
  focusTick = 0,
  onPick = vi.fn(),
  onRootChanged = vi.fn(),
  seen,
  shown = true,
}: HarnessProps) {
  const [state, setState] = useState<ContentSearchState>({
    ...CONTENT_SEARCH_INITIAL,
    ...initial,
  })
  if (seen) seen.state = state
  if (!shown) return null
  return (
    <ContentSearch
      paneId="%1"
      root={root}
      state={state}
      onState={(p) => setState((s) => ({ ...s, ...p }))}
      refreshTick={tick}
      focusTick={focusTick}
      onPick={onPick}
      onRootChanged={onRootChanged}
    />
  )
}

const box = () =>
  screen.getByRole('searchbox', { name: 'Search file contents' })

async function type(value: string) {
  fireEvent.change(box(), { target: { value } })
  await act(async () => {
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
  })
}

const sent = (i = 0) => mockSearch.mock.calls[i][1]

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  mockSearch.mockReset()
  mockSearch.mockResolvedValue(found())
})
afterEach(() => vi.useRealTimers())

describe('splitGlobs', () => {
  it('splits on commas, trims and drops empty ones', () => {
    expect(splitGlobs(' *.ts, src/ ,,')).toEqual(['*.ts', 'src/'])
    expect(splitGlobs('')).toEqual([])
  })
})

describe('matchStart', () => {
  it('is where the match starts on its line, not the text sent', () => {
    expect(
      matchStart({ line: 1, text: 'foo', col: 40, ranges: [[3, 6]] }),
    ).toBe(43)
    expect(matchStart({ line: 1, text: '', col: 7, ranges: [] })).toBe(7)
  })
})

describe('Marked', () => {
  it('marks each range, and an ellipsis for a window inside the line', () => {
    const { container } = render(
      <Marked
        match={{
          line: 1,
          text: 'a foo b foo',
          col: 7,
          ranges: [
            [2, 5],
            [3, 4],
            [8, 11],
          ],
        }}
      />,
    )
    expect(container.textContent).toBe('…a foo b foo')
    expect(
      [...container.querySelectorAll('mark')].map((m) => m.textContent),
    ).toEqual(['foo', 'foo'])
  })
})

describe('ContentSearch', () => {
  it('sends nothing for an empty or one-character query', async () => {
    render(<Harness />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await type('f')
    expect(screen.getByText('Type at least 2 characters')).toBeInTheDocument()
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it('searches after a pause, the previous request aborted, untrimmed', async () => {
    render(<Harness />)
    fireEvent.change(box(), { target: { value: 'fo' } })
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1)
    })
    expect(mockSearch).not.toHaveBeenCalled()
    await type(' foo ')
    expect(mockSearch).toHaveBeenCalledTimes(1)
    expect(sent()).toEqual({
      q: ' foo ',
      root: '/r',
      matchCase: false,
      wholeWord: false,
      regex: false,
      files: [],
      skip: [],
      exclude: FIND_EXCLUDES_DEFAULT,
      fresh: false,
    })
    // A newer query aborts the one in flight
    let release!: (r: SearchResponse) => void
    mockSearch.mockReturnValueOnce(new Promise((r) => (release = r)))
    await type('bar')
    const signal = mockSearch.mock.calls[1][2] as AbortSignal
    await type('baz')
    expect(signal.aborted).toBe(true)
    await act(async () => release(found()))
    expect(mockSearch).toHaveBeenCalledTimes(3)
  })

  it('shows the results grouped by file with the matches marked', async () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    await type('foo')
    expect(screen.getByText('7 lines in 2 files')).toBeInTheDocument()
    const groups = screen.getAllByRole('button', { expanded: true })
    expect(groups.map((g) => g.textContent)).toEqual(['a.tssrc/2', 'b.md5'])
    expect(screen.getByText('4 more lines in this file')).toBeInTheDocument()
    const a = screen.getByRole('list', { name: 'src/a.ts' })
    const rows = within(a).getAllByRole('button')
    expect(rows[1]).toHaveTextContent('9foo(foo)')
    expect(rows[1].querySelectorAll('mark')).toHaveLength(2)
    fireEvent.click(rows[0])
    expect(onPick).toHaveBeenCalledWith('src/a.ts', found().files[0].matches[0])
    // A group closes and opens
    fireEvent.click(groups[1])
    expect(screen.queryByRole('list', { name: 'b.md' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /b\.md/ }))
    expect(screen.getByRole('list', { name: 'b.md' })).toBeInTheDocument()
  })

  it('each option and the globs change the request, the options kept on the device', async () => {
    render(<Harness />)
    await type('foo')
    for (const name of ['Match case', 'Whole word', 'Regular expression']) {
      const b = screen.getByRole('button', { name })
      expect(b).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(b)
      expect(b).toHaveAttribute('aria-pressed', 'true')
    }
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    })
    expect(mockSearch.mock.lastCall?.[1]).toMatchObject({
      matchCase: true,
      wholeWord: true,
      regex: true,
    })
    const saved = JSON.parse(localStorage.getItem('termote-settings')!)
    expect(saved).toMatchObject({
      searchCase: true,
      searchWord: true,
      searchRegex: true,
    })

    const more = screen.getByRole('button', {
      name: 'Files to include or exclude',
    })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Files to include' }),
      {
        target: { value: '*.ts, src/' },
      },
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Files to exclude' }),
      {
        target: { value: '*.test.ts' },
      },
    )
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    })
    expect(mockSearch.mock.lastCall?.[1]).toMatchObject({
      files: ['*.ts', 'src/'],
      skip: ['*.test.ts'],
    })
  })

  it('tells an invalid regex or glob under the box, keeping the last results', async () => {
    render(<Harness />)
    await type('foo')
    mockSearch.mockRejectedValueOnce(
      new RequestError(400, 'invalid_regex', 'x'),
    )
    await type('foo(')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Invalid regular expression',
    )
    expect(box()).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('7 lines in 2 files')).toBeInTheDocument()
    mockSearch.mockRejectedValueOnce(new RequestError(400, 'empty_match', 'x'))
    await type('foo*')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This pattern matches empty text',
    )
    mockSearch.mockRejectedValueOnce(new RequestError(400, 'invalid_glob', 'x'))
    await type('foo((')
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid file pattern')
    await type('foo')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a first query refused says nothing but the alert', async () => {
    mockSearch.mockRejectedValueOnce(
      new RequestError(400, 'invalid_regex', 'x'),
    )
    render(<Harness />)
    await type('a(')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Searching…')).not.toBeInTheDocument()
  })

  it('busy: tells so, and Retry sends the same search again', async () => {
    mockSearch.mockRejectedValueOnce(new RequestError(429, 'busy', 'x'))
    render(<Harness />)
    await type('foo')
    expect(screen.getByText(/Search busy, try again/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    })
    expect(mockSearch).toHaveBeenCalledTimes(2)
    expect(screen.getByText('7 lines in 2 files')).toBeInTheDocument()
  })

  it('says why the files cannot be searched', async () => {
    mockSearch.mockRejectedValueOnce(new RequestError(501, '', 'x'))
    render(<Harness />)
    await type('foo')
    expect(
      screen.getByText('Not supported by this backend'),
    ).toBeInTheDocument()
  })

  it('a moved root goes to the caller', async () => {
    const onRootChanged = vi.fn()
    mockSearch.mockRejectedValueOnce(
      new RequestError(409, '', 'x', undefined, undefined, '/new'),
    )
    render(<Harness onRootChanged={onRootChanged} />)
    await type('foo')
    expect(onRootChanged).toHaveBeenCalledWith('/new')
  })

  it('tells what was not searched', async () => {
    mockSearch.mockResolvedValue(
      found({
        truncated: true,
        incomplete: true,
        skipped: { sensitive: 1, hidden: 3, binary: 2, tooLarge: 1 },
      }),
    )
    render(<Harness />)
    await type('foo')
    for (const t of [
      'Showing the first 3 lines',
      'Stopped early: some files were not searched',
      '1 sensitive file not searched',
      '3 hidden files not searched in a home folder',
    ])
      expect(screen.getByText(t)).toBeInTheDocument()
  })

  it('no matches', async () => {
    mockSearch.mockResolvedValue(found({ files: [] }))
    render(<Harness />)
    await type('zzz')
    expect(screen.getByText('No matches')).toBeInTheDocument()
  })

  it('results of another root are dimmed and cannot be opened', async () => {
    const onPick = vi.fn()
    // An answer for this key, kept from before the root moved
    const { rerender } = render(<Harness onPick={onPick} />)
    await type('foo')
    mockSearch.mockReturnValue(new Promise(() => {}))
    rerender(<Harness onPick={onPick} root="/moved" />)
    expect(
      screen.getByText('The folder changed: search again'),
    ).toBeInTheDocument()
    const row = within(
      screen.getByRole('list', { name: 'src/a.ts' }),
    ).getAllByRole('button')[0]
    expect(row).toBeDisabled()
    fireEvent.click(row)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('moves through the results with the keyboard', async () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    await type('foo')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    const header = screen.getByRole('button', { name: /^a\.ts/ })
    expect(header).toHaveFocus()
    fireEvent.keyDown(header, { key: 'ArrowDown' })
    const first = within(
      screen.getByRole('list', { name: 'src/a.ts' }),
    ).getAllByRole('button')[0]
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(header).toHaveFocus()
    fireEvent.keyDown(header, { key: 'ArrowUp' })
    expect(box()).toHaveFocus()
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(header, { key: 'ArrowDown' })
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(box()).toHaveFocus()
    // Other keys are the row's own; a key on no row is left alone
    fireEvent.keyDown(first, { key: 'x' })
    fireEvent.keyDown(screen.getByText('7 lines in 2 files'), {
      key: 'ArrowDown',
    })
    expect(box()).toHaveFocus()
    // Escape in the box clears it
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(box()).toHaveValue('')
  })

  it('focuses and selects the box when asked', async () => {
    const { rerender } = render(<Harness initial={{ query: 'foo' }} />)
    expect(box()).not.toHaveFocus()
    rerender(<Harness initial={{ query: 'foo' }} focusTick={1} />)
    expect(box()).toHaveFocus()
  })

  it('remounted with the answer kept: no request, scrolled and focused as left', async () => {
    const seen: { state?: ContentSearchState } = {}
    const { rerender } = render(<Harness seen={seen} focusTick={1} />)
    expect(box()).toHaveFocus()
    await type('foo')
    const rows = within(
      screen.getByRole('list', { name: 'src/a.ts' }),
    ).getAllByRole('button')
    fireEvent.focus(rows[1])
    const list = screen.getByRole('list', { name: 'Search results' })
      .parentElement as HTMLElement
    list.scrollTop = 40
    fireEvent.scroll(list)
    // A scroll renders nothing: the offset goes to the caller when left
    expect(seen.state).toMatchObject({ selected: 2, scrollTop: 0 })
    rerender(<Harness seen={seen} focusTick={1} shown={false} />)
    expect(seen.state).toMatchObject({ selected: 2, scrollTop: 40 })
    mockSearch.mockClear()
    rerender(<Harness seen={seen} focusTick={1} />)
    // Shown again: the focus stays where it is
    expect(box()).not.toHaveFocus()
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    })
    expect(mockSearch).not.toHaveBeenCalled()
    const again = screen.getByRole('list', { name: 'Search results' })
      .parentElement as HTMLElement
    expect(again.scrollTop).toBe(40)
    const rowsAgain = within(
      screen.getByRole('list', { name: 'src/a.ts' }),
    ).getAllByRole('button')
    expect(rowsAgain[1]).toHaveAttribute('tabindex', '0')
  })

  it('a refresh sends the search again with fresh', async () => {
    const { rerender } = render(<Harness />)
    await type('foo')
    rerender(<Harness tick={1} />)
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    })
    expect(mockSearch).toHaveBeenCalledTimes(2)
    expect(sent(1).fresh).toBe(true)
  })

  it('a search aborted by a newer one says nothing of its failure', async () => {
    let fail!: (e: unknown) => void
    mockSearch.mockReturnValueOnce(new Promise((_, r) => (fail = r)))
    render(<Harness />)
    await type('foo')
    await type('food')
    await act(async () => fail(new RequestError(500, '', 'x')))
    expect(
      screen.queryByText('Could not search the files'),
    ).not.toBeInTheDocument()
    expect(screen.getByText('7 lines in 2 files')).toBeInTheDocument()
  })

  it('keys in an empty box with no results do nothing', () => {
    render(<Harness />)
    box().focus()
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'Escape' })
    fireEvent.keyDown(box(), { key: 'a' })
    expect(box()).toHaveFocus()
  })

  it('past 50 files the groups start closed', async () => {
    mockSearch.mockResolvedValue(
      found({
        files: Array.from({ length: 52 }, (_, i) => ({
          path: `f${String(i).padStart(2, '0')}.txt`,
          matches: [match(1, 'foo', [[0, 3]])],
          more: 0,
        })),
      }),
    )
    render(<Harness />)
    await type('foo')
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(50)
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(3)
  })
})
