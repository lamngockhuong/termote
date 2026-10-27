import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import {
  type CommitInfo,
  type LastCommit,
  RequestError,
} from '../hooks/use-mux-api'
import { CommitView } from './commit-view'

const mockCommit = vi.fn()
const mockDiff = vi.fn()

vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchLastCommit: (...a: unknown[]) => mockCommit(...a),
  fetchCommitDiff: (...a: unknown[]) => mockDiff(...a),
}))

const HASH = 'a'.repeat(40)
const commit = (over: Partial<CommitInfo> = {}): LastCommit => ({
  root: '/r',
  isRepo: true,
  commit: {
    hash: HASH,
    parents: ['b'.repeat(40)],
    author: 'Ada',
    time: 1_700_000_000,
    message: 'fix: the thing\n\nWhy it broke.',
    files: [
      { path: 'src/a.ts', status: 'M', sensitive: false },
      { path: 'src/new.ts', orig: 'src/old.ts', status: 'R', sensitive: false },
      { path: '.env', status: 'A', sensitive: true },
      { path: 'odd', status: 'X', sensitive: false },
    ],
    truncated: false,
    ...over,
  },
})

const DIFF = {
  root: '/r',
  path: 'src/a.ts',
  truncated: false,
  hunks: [
    {
      header: '@@ -1 +1,2 @@',
      lines: [
        { kind: 'ctx', old: 1, new: 1, text: 'one' },
        { kind: 'add', new: 2, text: 'two' },
      ],
    },
  ],
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 5)))

async function show(over: { canReveal?: boolean; isMobile?: boolean } = {}) {
  const p = {
    onBack: vi.fn(),
    onRootChanged: vi.fn(),
  }
  render(
    <ThemeProvider>
      <CommitView
        paneId="%1"
        root="/r"
        isMobile={over.isMobile ?? false}
        canReveal={over.canReveal ?? true}
        {...p}
      />
    </ThemeProvider>,
  )
  await settle()
  return p
}

const open = async (name: RegExp) => {
  fireEvent.click(screen.getByRole('button', { name }))
  await settle()
}

beforeEach(() => {
  mockCommit.mockReset()
  mockDiff.mockReset()
  mockCommit.mockResolvedValue(commit())
  mockDiff.mockResolvedValue(DIFF)
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

describe('CommitView', () => {
  it('shows the message, author, hash and files of HEAD', async () => {
    const p = await show()
    expect(mockCommit).toHaveBeenCalledWith('%1', '/r')
    expect(screen.getByText('fix: the thing')).toBeInTheDocument()
    expect(screen.getByText('Why it broke.')).toBeInTheDocument()
    expect(screen.getByText('Ada')).toBeInTheDocument()
    expect(screen.getAllByText('aaaaaaa')).toHaveLength(2)
    const files = screen.getByRole('region', { name: 'Files' })
    expect(files).toHaveTextContent('Files 4')
    expect(
      screen.getByRole('button', { name: /Renamed:\s?new\.ts/ }),
    ).toHaveTextContent('src/old.ts → src/')
    expect(
      screen.getByRole('button', { name: /^X:\s?odd/ }),
    ).toBeInTheDocument()
    expect(screen.getByText('Sensitive')).toBeInTheDocument()
    expect(screen.queryByText(/Merge:/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to changes' }))
    expect(p.onBack).toHaveBeenCalled()
  })

  it('notes a merge, a cut list, an empty commit and no message', async () => {
    mockCommit.mockResolvedValue(
      commit({
        parents: ['b'.repeat(40), 'c'.repeat(40)],
        truncated: true,
        files: [],
        message: '',
      }),
    )
    await show()
    expect(
      screen.getByText('Merge: changes against the first parent'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Only the first 5000 files are shown'),
    ).toBeInTheDocument()
    expect(screen.getByText('No files changed')).toBeInTheDocument()
    expect(screen.getByText('(no message)')).toBeInTheDocument()
  })

  it('shows invisible characters of the message', async () => {
    mockCommit.mockResolvedValue(commit({ message: 'a‮b' }))
    await show()
    expect(screen.getByText(/U\+202E/)).toBeInTheDocument()
  })

  it.each([
    [{ root: '/r', isRepo: true }, 'No commits yet'],
    [new RequestError(500, '', 'x'), 'Could not load the commit'],
    [
      new RequestError(403, 'view_only', 'x'),
      'View only: files show in a git repository only',
    ],
  ])('says when there is no commit to show', async (res, text) => {
    if (res instanceof Error) mockCommit.mockRejectedValue(res)
    else mockCommit.mockResolvedValue(res)
    await show()
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('follows a root that moved', async () => {
    mockCommit.mockRejectedValue(
      new RequestError(409, '', 'moved', { root: '/elsewhere' }),
    )
    const p = await show()
    expect(p.onRootChanged).toHaveBeenCalledWith('/elsewhere')
  })

  it('opens a file diff and goes back to the commit', async () => {
    await show()
    await open(/Modified:\s?a\.ts/)
    expect(mockDiff).toHaveBeenCalledWith(
      '%1',
      HASH,
      expect.objectContaining({ path: 'src/a.ts' }),
      { root: '/r', reveal: false },
    )
    expect(screen.getByTestId('diff')).toHaveTextContent('two')
    expect(screen.getByText('Modified · aaaaaaa')).toBeInTheDocument()
    const wrap = screen.getByRole('button', { name: 'Wrap lines' })
    expect(wrap).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(wrap)
    expect(wrap).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Back to the commit' }))
    expect(screen.getByText('fix: the thing')).toBeInTheDocument()
    await open(/Renamed:\s?new\.ts/)
    expect(screen.getByText(/src\/old\.ts → src\/new\.ts/)).toBeInTheDocument()
  })

  it('says why a diff cannot be shown', async () => {
    mockDiff.mockRejectedValue(new RequestError(404, 'not_changed', 'x'))
    await show()
    await open(/^X:\s?odd/)
    expect(screen.getByText('Not in the last commit')).toBeInTheDocument()
    // A letter it has no name for is shown as it is
    expect(screen.getByText('X · aaaaaaa')).toBeInTheDocument()
  })

  it('reads HEAD again once it moved, and follows a moved root', async () => {
    mockDiff.mockRejectedValueOnce(new RequestError(409, 'head_moved', 'x'))
    const p = await show()
    await open(/Modified:\s?a\.ts/)
    expect(mockCommit).toHaveBeenCalledTimes(2)
    expect(screen.getByText('fix: the thing')).toBeInTheDocument()
    mockDiff.mockRejectedValueOnce(
      new RequestError(409, '', 'moved', { root: '/elsewhere' }),
    )
    await open(/Modified:\s?a\.ts/)
    expect(p.onRootChanged).toHaveBeenCalledWith('/elsewhere')
  })

  it('asks before showing a sensitive file', async () => {
    mockDiff.mockImplementation(
      async (_p: string, _h: string, _f: unknown, o: { reveal: boolean }) =>
        o.reveal
          ? { ...DIFF, path: '.env' }
          : { ...DIFF, sensitive: true, hunks: null },
    )
    await show()
    await open(/Added:\s?\.env/)
    expect(
      screen.getByText('This file may contain secrets'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    await settle()
    expect(mockDiff).toHaveBeenLastCalledWith(
      '%1',
      HASH,
      expect.objectContaining({ path: '.env' }),
      { root: '/r', reveal: true },
    )
    expect(screen.getByTestId('diff')).toHaveTextContent('two')
  })

  it('never shows a sensitive file on a view-only device', async () => {
    mockDiff.mockResolvedValue({ ...DIFF, sensitive: true, hunks: null })
    await show({ canReveal: false })
    await open(/Added:\s?\.env/)
    expect(
      screen.getByText('A view-only device cannot show it'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull()
  })

  it('goes back to the commit when a sensitive file is not shown', async () => {
    mockDiff.mockResolvedValue({ ...DIFF, sensitive: true, hunks: null })
    await show({ isMobile: true })
    await open(/Added:\s?\.env/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('fix: the thing')).toBeInTheDocument()
  })

  it('drops an answer that comes after it closed', async () => {
    let resolve: (v: unknown) => void = () => {}
    mockCommit.mockReturnValue(new Promise((r) => (resolve = r)))
    const { unmount } = render(
      <CommitView
        paneId="%1"
        isMobile={false}
        canReveal
        onBack={vi.fn()}
        onRootChanged={vi.fn()}
      />,
    )
    unmount()
    await act(async () => resolve(commit()))
    let reject: (e: unknown) => void = () => {}
    mockCommit.mockReturnValue(new Promise((_, r) => (reject = r)))
    render(
      <CommitView
        paneId="%1"
        isMobile={false}
        canReveal
        onBack={vi.fn()}
        onRootChanged={vi.fn()}
      />,
    ).unmount()
    await act(async () => reject(new Error('x')))
  })

  it('drops a diff answer that comes after it closed', async () => {
    await show()
    let resolve: (v: unknown) => void = () => {}
    let reject: (e: unknown) => void = () => {}
    mockDiff.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    await open(/Modified:\s?a\.ts/)
    fireEvent.click(screen.getByRole('button', { name: 'Back to the commit' }))
    await act(async () => resolve(DIFF))
    mockDiff.mockReturnValueOnce(new Promise((_, r) => (reject = r)))
    await open(/Modified:\s?a\.ts/)
    fireEvent.click(screen.getByRole('button', { name: 'Back to the commit' }))
    await act(async () => reject(new Error('x')))
    expect(screen.getByText('fix: the thing')).toBeInTheDocument()
  })
})
