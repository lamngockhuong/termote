import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { resetFilesStores, useFiles } from '../hooks/use-files'
import { resetGitChangesStores } from '../hooks/use-git-changes'
import {
  type ChangeEntry,
  type GitChanges,
  RequestError,
} from '../hooks/use-mux-api'
import { FILES_VIEW_ID } from '../view-ids'
import { ChangesView } from './changes-view'

const mockChanges = vi.fn()
const mockDiff = vi.fn()
const mockContent = vi.fn()
const mockTree = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchGitChanges: (...a: unknown[]) => mockChanges(...a),
  fetchFileDiff: (...a: unknown[]) => mockDiff(...a),
  fetchFileContent: (...a: unknown[]) => mockContent(...a),
  fetchFilesTree: (...a: unknown[]) => mockTree(...a),
}))

const c = (
  path: string,
  staged: string,
  unstaged: string,
  over: Partial<ChangeEntry> = {},
): ChangeEntry => ({
  path,
  staged,
  unstaged,
  sensitive: false,
  ...over,
})
const ENTRIES = [
  c('src/both.ts', 'M', 'M'),
  c('src/new.ts', 'R', '', { orig: 'src/old.ts' }),
  c('gone.txt', '', 'D'),
  c('notes/todo.md', '', '?'),
  c('.env', '', 'M', { sensitive: true }),
  // Listed as a conflict whatever its two sides say
  c('merge.go', '', '', { conflict: true }),
  c('odd', 'X', ''),
]
const changes = (over: Partial<GitChanges> = {}): GitChanges => ({
  root: '/r',
  isRepo: true,
  branch: 'main',
  entries: ENTRIES,
  truncated: false,
  ...over,
})

function props(over: Partial<ViewProps> = {}): ViewProps {
  return {
    mux: {
      backend: 'tmux',
      caps: { clientSideSelect: false, copyMode: true, files: true },
    },
    session: {
      id: '1',
      name: 'Shell',
      icon: '💻',
      description: '',
      paneId: '%1',
    },
    readOnly: false,
    isMobile: false,
    notify: vi.fn(),
    showView: vi.fn(),
    ...over,
  }
}

// The first poll runs from a 0ms timer
const settle = () => act(() => new Promise((r) => setTimeout(r, 5)))

async function show(over: Partial<ViewProps> = {}) {
  const p = props(over)
  const view = render(<ChangesView {...p} />)
  await settle()
  return { ...p, ...view }
}

const group = (name: string) => screen.getByRole('region', { name })
const names = (name: string) =>
  within(group(name))
    .getAllByRole('button')
    .map((b) => b.textContent)

// The lazy Markdown renderer, loaded once up front: its first load can
// outlast a find under coverage
beforeAll(() => import('./markdown-preview'))

beforeEach(() => {
  resetGitChangesStores()
  resetFilesStores()
  mockChanges.mockReset()
  mockDiff.mockReset()
  mockChanges.mockResolvedValue(changes())
  mockDiff.mockResolvedValue({
    root: '/r',
    path: 'x',
    truncated: false,
    hunks: [],
  })
})

describe('ChangesView', () => {
  it('waits for a pane', async () => {
    await show({ session: { id: '1', name: 'x', icon: '', description: '' } })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(mockChanges).not.toHaveBeenCalled()
  })

  it('groups the changes, a file staged and not in both groups', async () => {
    await show()
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(names('Conflicts')).toEqual(['UConflict: merge.go'])
    expect(names('Staged')).toEqual([
      'MModified: both.tssrc/',
      'RRenamed: new.tssrc/old.ts → src/',
      'XX: odd',
    ])
    expect(names('Changes')).toEqual([
      'MModified: both.tssrc/',
      'DDeleted: gone.txt',
      'MModified: .envSensitive',
    ])
    expect(names('Untracked')).toEqual(['?Untracked: todo.mdnotes/'])
  })

  it('opens the diff of the side chosen, and goes back', async () => {
    await show()
    fireEvent.click(within(group('Staged')).getAllByRole('button')[1])
    await act(async () => {})
    expect(mockDiff).toHaveBeenCalledWith(
      '%1',
      { path: 'src/new.ts', orig: 'src/old.ts' },
      { staged: true, root: '/r', reveal: false },
    )
    expect(screen.getByText('No content changes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to changes' }))
    fireEvent.click(within(group('Changes')).getAllByRole('button')[0])
    await act(async () => {})
    expect(mockDiff).toHaveBeenLastCalledWith(
      '%1',
      { path: 'src/both.ts', orig: undefined },
      expect.objectContaining({ staged: false }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to changes' }))
    // A conflict opens its worktree side
    fireEvent.click(within(group('Conflicts')).getByRole('button'))
    await act(async () => {})
    expect(mockDiff).toHaveBeenLastCalledWith(
      '%1',
      { path: 'merge.go', orig: undefined },
      expect.objectContaining({ staged: false }),
    )
  })

  it('an open diff whose file is no longer changed says so', async () => {
    vi.useFakeTimers()
    try {
      const v = render(<ChangesView {...props()} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      fireEvent.click(within(group('Changes')).getAllByRole('button')[1])
      mockChanges.mockResolvedValue(changes({ entries: [] }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(screen.getByText('No longer changed')).toBeInTheDocument()
      v.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refresh reads the status and the open diff again', async () => {
    await show()
    fireEvent.click(within(group('Changes')).getAllByRole('button')[1])
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(mockChanges).toHaveBeenCalledTimes(2)
    expect(mockDiff).toHaveBeenCalledTimes(2)
  })

  it.each([
    [
      changes({
        isRepo: false,
        entries: [],
        branch: undefined,
        root: '/tmp/x',
      }),
      'Not a git repository: /tmp/x',
    ],
    [changes({ entries: [] }), 'No changes'],
  ])('says when there is nothing to list', async (res, text) => {
    mockChanges.mockResolvedValue(res)
    await show()
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('notes a list cut at the server limit', async () => {
    mockChanges.mockResolvedValue(changes({ truncated: true }))
    await show()
    expect(
      screen.getByText('Only the first 5000 changes are shown'),
    ).toBeInTheDocument()
  })

  it('says why the status failed, over the list it had', async () => {
    mockChanges.mockRejectedValueOnce(new RequestError(501, '', 'x'))
    const v = await show()
    expect(
      screen.getByText('Not supported by this backend'),
    ).toBeInTheDocument()
    v.unmount()
    resetGitChangesStores()
    mockChanges
      .mockResolvedValueOnce(changes())
      .mockRejectedValueOnce(new RequestError(503, '', 'x'))
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(
      screen.getByText('git took too long; trying again'),
    ).toBeInTheDocument()
    expect(group('Staged')).toBeInTheDocument()
  })

  it('a Show is not carried to the same entry under a new root', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    mockDiff.mockImplementation(
      async (_p: string, _e: unknown, o: { reveal: boolean }) =>
        o.reveal
          ? {
              root: '/r',
              path: '.env',
              truncated: false,
              hunks: [{ header: '@@', lines: [] }],
            }
          : {
              root: '/r',
              path: '.env',
              truncated: false,
              sensitive: true,
              hunks: null,
            },
    )
    await show()
    fireEvent.click(screen.getByRole('button', { name: /\.env/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    expect(await screen.findByTestId('diff')).toBeInTheDocument()
    mockChanges
      .mockRejectedValueOnce(
        new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
      )
      .mockResolvedValue(changes({ root: '/n' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    await settle()
    expect(mockDiff).toHaveBeenLastCalledWith(
      '%1',
      { path: '.env', orig: undefined },
      { staged: false, root: '/n', reveal: false },
    )
  })

  it('tells once when the pane directory moved', async () => {
    const v = await show()
    mockChanges.mockRejectedValueOnce(
      new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(v.notify).toHaveBeenCalledExactlyOnceWith(
      "The pane's directory changed",
    )
  })

  it('a link of a previewed Markdown file opens in the Files view', async () => {
    mockDiff.mockResolvedValue({
      root: '/r',
      path: 'notes/todo.md',
      truncated: false,
      hunks: [
        {
          header: '@@ -0,0 +1 @@',
          lines: [{ kind: 'add', new: 1, text: 'x' }],
        },
      ],
    })
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'notes/todo.md',
      size: 9,
      text: '[a](a.md) [gone](nope.md)',
    })
    mockTree.mockResolvedValue({
      root: '/r',
      isRepo: true,
      path: 'notes',
      entries: [{ name: 'a.md', type: 'file', size: 1, sensitive: false }],
      truncated: false,
    })
    const p = await show()
    fireEvent.click(screen.getByRole('button', { name: /todo\.md/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    fireEvent.click(await screen.findByRole('button', { name: 'gone' }))
    await settle()
    expect(p.notify).toHaveBeenCalledWith('Not found')
    expect(p.showView).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    await settle()
    expect(p.showView).toHaveBeenCalledWith(FILES_VIEW_ID)
    const files = renderHook(() => useFiles('%1'))
    expect(files.result.current.openPath).toBe('notes/a.md')
  })
})
