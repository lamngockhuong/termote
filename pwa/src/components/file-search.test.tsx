import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FindResponse, RequestError } from '../hooks/use-mux-api'
import { FIND_EXCLUDES_DEFAULT } from '../hooks/use-settings'
import { FIND_DEBOUNCE_MS, FileSearch } from './file-search'

const mockFind = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  findFiles: (...a: unknown[]) => mockFind(...a),
}))

const found = (over: Partial<FindResponse> = {}): FindResponse => ({
  root: '/r',
  isRepo: true,
  results: [
    { path: 'src/main.go', ignored: false, sensitive: false },
    { path: 'plans/p.md', ignored: true, sensitive: false },
    { path: '.env', ignored: false, sensitive: true },
  ],
  truncated: false,
  incomplete: false,
  ...over,
})

function Harness({
  isRepo = true,
  initial = '',
  tick = 0,
  onPick = vi.fn(),
  onRootChanged = vi.fn(),
}: {
  isRepo?: boolean
  initial?: string
  tick?: number
  onPick?: (p: string) => void
  onRootChanged?: (r: string) => void
}) {
  const [q, setQ] = useState(initial)
  return (
    <FileSearch
      paneId="%1"
      root="/r"
      isRepo={isRepo}
      query={q}
      onQuery={setQ}
      refreshTick={tick}
      onPick={onPick}
      onRootChanged={onRootChanged}
    >
      <p>the tree</p>
    </FileSearch>
  )
}

const box = () => screen.getByRole('searchbox', { name: 'Find a file' })

async function type(value: string) {
  fireEvent.change(box(), { target: { value } })
  await act(async () => {
    vi.advanceTimersByTime(FIND_DEBOUNCE_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  mockFind.mockReset()
  mockFind.mockResolvedValue(found())
})
afterEach(() => vi.useRealTimers())

describe('FileSearch', () => {
  it('shows the tree without a query, and the switch only in a repo', () => {
    const { unmount } = render(<Harness />)
    expect(screen.getByText('the tree')).toBeInTheDocument()
    expect(
      screen.getByRole('switch', { name: 'Include ignored' }),
    ).toHaveAttribute('aria-checked', 'false')
    unmount()
    render(<Harness isRepo={false} />)
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('searches once typing stops, then lists the matches in place of the tree', async () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    fireEvent.change(box(), { target: { value: 'ma' } })
    fireEvent.change(box(), { target: { value: ' main ' } })
    expect(mockFind).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS)
    })
    expect(mockFind).toHaveBeenCalledTimes(1)
    expect(mockFind).toHaveBeenCalledWith(
      '%1',
      {
        q: 'main',
        root: '/r',
        ignored: false,
        exclude: FIND_EXCLUDES_DEFAULT,
        fresh: false,
      },
      expect.any(AbortSignal),
    )
    expect(screen.queryByText('the tree')).toBeNull()
    const list = screen.getByRole('list', { name: 'Matching files' })
    const rows = within(list).getAllByRole('button')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('main.go')
    expect(rows[0]).toHaveTextContent('src')
    expect(rows[1]).toHaveTextContent('ignored')
    expect(rows[1]).toHaveClass('opacity-60')
    expect(rows[2]).toHaveTextContent('Sensitive')
    fireEvent.click(rows[0])
    expect(onPick).toHaveBeenCalledWith('src/main.go')
  })

  it('cancels a search the next key replaces', async () => {
    let first!: AbortSignal
    mockFind.mockImplementationOnce(
      (_p, _q, signal: AbortSignal) =>
        new Promise((_r, reject) => {
          first = signal
          signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    render(<Harness />)
    await type('a')
    expect(screen.getByRole('status')).toHaveTextContent('Searching…')
    await type('ab')
    expect(first.aborted).toBe(true)
    expect(screen.getAllByRole('button', { name: /main\.go/ })).toHaveLength(1)
  })

  it('says why a list is short, or empty', async () => {
    mockFind.mockResolvedValueOnce(found({ truncated: true, incomplete: true }))
    const { unmount } = render(<Harness />)
    await type('x')
    expect(
      screen.getByText('More than 200 matches — type more to narrow'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Search stopped early in a large tree'),
    ).toBeInTheDocument()
    unmount()
    mockFind.mockResolvedValueOnce(found({ results: [] }))
    mockFind.mockResolvedValueOnce(found({ results: [], incomplete: true }))
    render(<Harness />)
    await type('none')
    expect(screen.getByRole('status')).toHaveTextContent('No files match')
    await type('nonee')
    expect(screen.getByRole('status')).toHaveTextContent(
      'No files match. The search stopped early in a large tree.',
    )
  })

  it('says why a search failed, and follows a moved root', async () => {
    const onRootChanged = vi.fn()
    mockFind.mockRejectedValueOnce(new RequestError(403, '', 'x'))
    mockFind.mockRejectedValueOnce(
      new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
    )
    render(<Harness onRootChanged={onRootChanged} />)
    await type('a')
    expect(screen.getByRole('status')).toHaveTextContent(
      "This directory can't be searched",
    )
    await type('b')
    expect(onRootChanged).toHaveBeenCalledWith('/n')
  })

  it('searches ignored files once the switch is on, remembered', async () => {
    render(<Harness />)
    await type('p')
    fireEvent.click(screen.getByRole('switch', { name: 'Include ignored' }))
    await act(async () => {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS)
    })
    expect(mockFind).toHaveBeenLastCalledWith(
      '%1',
      expect.objectContaining({ ignored: true }),
      expect.any(AbortSignal),
    )
    expect(
      JSON.parse(localStorage.getItem('termote-settings')!).findIncludeIgnored,
    ).toBe(true)
  })

  it('reads the files again after a refresh', async () => {
    const { rerender } = render(<Harness initial="m" />)
    await act(async () => {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS)
    })
    expect(mockFind.mock.calls[0][1].fresh).toBe(false)
    rerender(<Harness initial="m" tick={1} />)
    await act(async () => {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS)
    })
    expect(mockFind.mock.calls[1][1].fresh).toBe(true)
  })

  it('moves between the box and the results with the arrow keys; Escape clears', async () => {
    render(<Harness />)
    await type('m')
    const rows = screen.getAllByRole('button')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(rows[0]).toHaveFocus()
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' })
    expect(rows[1]).toHaveFocus()
    fireEvent.keyDown(rows[1], { key: 'ArrowUp' })
    expect(rows[0]).toHaveFocus()
    fireEvent.keyDown(rows[0], { key: 'x' })
    expect(rows[0]).toHaveFocus()
    fireEvent.keyDown(rows[0], { key: 'ArrowUp' })
    expect(box()).toHaveFocus()
    fireEvent.keyDown(box(), { key: 'x' })
    fireEvent.keyDown(rows[2], { key: 'Escape' })
    expect(box()).toHaveValue('')
    expect(box()).toHaveFocus()
    expect(screen.getByText('the tree')).toBeInTheDocument()
    // Escape in the box: cleared, and nothing more once empty
    await type('m')
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(box()).toHaveValue('')
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(box()).toHaveValue('')
  })
})
