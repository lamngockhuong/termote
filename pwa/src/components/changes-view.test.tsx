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
import { ThemeProvider } from '../contexts/theme-context'
import { resetFilesStores, useFiles } from '../hooks/use-files'
import { resetGitChangesStores } from '../hooks/use-git-changes'
import {
  type ChangeEntry,
  type GitChanges,
  RequestError,
} from '../hooks/use-mux-api'
import { FILES_VIEW_ID } from '../view-ids'
import { CHANGES_FILTER_MIN, ChangesView } from './changes-view'

const mockChanges = vi.fn()
const mockDiff = vi.fn()
const mockContent = vi.fn()
const mockTree = vi.fn()
const mockSave = vi.fn()
const mockImage = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  saveFileContent: (...a: unknown[]) => mockSave(...a),
  fetchFileImage: (...a: unknown[]) => mockImage(...a),
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
  // The editor's file view highlights through the theme
  const view = render(
    <ThemeProvider>
      <ChangesView {...p} />
    </ThemeProvider>,
  )
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
  mockContent.mockReset()
  mockSave.mockReset()
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
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
    expect(files.result.current.active?.path).toBe('notes/a.md')
  })
})

// A diff with one line: text the server read
const textDiff = (path: string) => ({
  root: '/r',
  path,
  truncated: false,
  hunks: [{ header: '@@', lines: [{ kind: 'add', new: 1, text: 'x' }] }],
})

// Opens the row of path in the group named
async function openDiff(groupName: string, path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  fireEvent.click(
    within(group(groupName)).getByRole('button', {
      name: new RegExp(name.replace('.', '\\.')),
    }),
  )
  await act(async () => {})
}

describe('ChangesView editing', () => {
  const EDIT = [
    c('mod.ts', '', 'M'),
    c('new.md', '', '?'),
    c('both.go', '', '', { conflict: true }),
    c('to.ts', 'R', '', { orig: 'from.ts' }),
    c('del.ts', '', 'D'),
    c('rm.ts', 'D', ''),
    c('back.ts', 'D', '?'),
    c('ln', 'T', ''),
    c('pic.png', '', 'M'),
    c('bin.dat', '', 'M'),
    c('big.log', '', 'M'),
  ]
  beforeEach(() => {
    mockChanges.mockResolvedValue(changes({ entries: EDIT }))
    mockDiff.mockImplementation(async (_p: string, e: { path: string }) =>
      e.path === 'bin.dat'
        ? { ...textDiff(e.path), binary: true, hunks: null }
        : e.path === 'big.log'
          ? { ...textDiff(e.path), reason: 'too-large', hunks: null }
          : textDiff(e.path),
    )
    mockImage.mockReturnValue(new Promise(() => {}))
  })

  it.each([
    ['Changes', 'mod.ts', 'Edit'],
    ['Untracked', 'new.md', 'Edit'],
    ['Conflicts', 'both.go', 'Edit'],
    ['Staged', 'to.ts', 'Edit working copy'],
    ['Staged', 'back.ts', 'Edit working copy'],
  ])('%s %s offers %s', async (g, path, label) => {
    await show()
    await openDiff(g, path)
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
  })

  it.each([
    ['Changes', 'del.ts'],
    ['Staged', 'rm.ts'],
    ['Staged', 'ln'],
    ['Changes', 'pic.png'],
    ['Changes', 'bin.dat'],
    ['Changes', 'big.log'],
  ])('%s %s offers no Edit', async (g, path) => {
    await show()
    await openDiff(g, path)
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
  })

  it('a view-only client gets no Edit', async () => {
    await show({ readOnly: true })
    await openDiff('Changes', 'mod.ts')
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('edits the working copy, then shows the unstaged diff read again', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'to.ts',
      size: 1,
      text: 'a',
      hash: 'h',
      editable: true,
    })
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'to.ts',
      size: 1,
      hash: 'h2',
    })
    const p = await show()
    await openDiff('Staged', 'to.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Edit working copy' }))
    const box = await screen.findByRole('textbox', { name: 'Text of to.ts' })
    expect(mockContent).toHaveBeenCalledWith('%1', 'to.ts', {
      root: '/r',
      reveal: false,
    })
    // A poll that changes the entry meanwhile leaves the editor open
    mockChanges.mockResolvedValue(
      changes({
        entries: EDIT.map((e) =>
          e.path === 'to.ts' ? { ...e, unstaged: 'M' } : e,
        ),
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(screen.getByRole('textbox')).toBe(box)
    fireEvent.change(box, { target: { value: 'b' } })
    const diffs = mockDiff.mock.calls.length
    const polls = mockChanges.mock.calls.length
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save' })),
    )
    await settle()
    expect(p.notify).toHaveBeenCalledWith('Saved')
    expect(screen.getByText('Not staged')).toBeInTheDocument()
    expect(mockChanges.mock.calls.length).toBeGreaterThan(polls)
    expect(mockDiff.mock.calls.length).toBeGreaterThan(diffs)
    expect(mockDiff).toHaveBeenLastCalledWith(
      '%1',
      { path: 'to.ts', orig: 'from.ts' },
      expect.objectContaining({ staged: false }),
    )
  })

  it('a save that leaves nothing changed goes back to the list', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'mod.ts',
      size: 1,
      text: 'a',
      hash: 'h',
      editable: true,
    })
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'mod.ts',
      size: 1,
      hash: 'h2',
    })
    const p = await show()
    await openDiff('Changes', 'mod.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'b' },
    })
    mockChanges.mockResolvedValue(
      changes({ entries: EDIT.filter((e) => e.path !== 'mod.ts') }),
    )
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save' })),
    )
    await settle()
    expect(p.notify).toHaveBeenCalledWith('No changes left in mod.ts')
    expect(screen.getByRole('region', { name: 'Changes' })).toBeInTheDocument()
  })

  it('Back from the editor returns to the diff', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'mod.ts',
      size: 1,
      text: 'a',
      hash: 'h',
      editable: true,
    })
    await show()
    await openDiff('Changes', 'mod.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await screen.findByRole('textbox')
    fireEvent.click(screen.getByRole('button', { name: 'Back to the diff' }))
    expect(
      screen.getByRole('button', { name: 'Back to changes' }),
    ).toBeInTheDocument()
  })

  it('a sensitive file shown once is edited without asking again', async () => {
    mockChanges.mockResolvedValue(changes())
    mockDiff.mockImplementation(
      async (_p: string, _e: unknown, o: { reveal: boolean }) =>
        o.reveal
          ? textDiff('.env')
          : {
              root: '/r',
              path: '.env',
              truncated: false,
              sensitive: true,
              hunks: null,
            },
    )
    mockContent.mockResolvedValue({
      root: '/r',
      path: '.env',
      size: 3,
      text: 'A=1',
      hash: 'h',
      editable: true,
    })
    await show()
    fireEvent.click(screen.getByRole('button', { name: /\.env/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(
      await screen.findByRole('textbox', { name: 'Text of .env' }),
    ).toHaveValue('A=1')
    expect(mockContent).toHaveBeenCalledWith('%1', '.env', {
      root: '/r',
      reveal: true,
    })
    // Back to the diff: still shown
    fireEvent.click(screen.getByRole('button', { name: 'Back to the diff' }))
    expect(await screen.findByTestId('diff')).toBeInTheDocument()
  })

  it('a Show ends when the diff is left for the list', async () => {
    mockChanges.mockResolvedValue(changes())
    mockDiff.mockImplementation(
      async (_p: string, _e: unknown, o: { reveal: boolean }) =>
        o.reveal
          ? textDiff('.env')
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
    fireEvent.click(screen.getByRole('button', { name: 'Back to changes' }))
    fireEvent.click(screen.getByRole('button', { name: /\.env/ }))
    expect(
      await screen.findByText(
        'This file may contain secrets. Show its contents?',
      ),
    ).toBeInTheDocument()
  })
})

describe('ChangesView filter', () => {
  const many = [
    ...Array.from({ length: CHANGES_FILTER_MIN }, (_, i) =>
      c(`lib/f${i}.ts`, '', 'M'),
    ),
    c('docs/Guide.md', '', '?'),
    c('src/new.ts', 'R', '', { orig: 'old/legacy.ts' }),
  ]
  const box = () => screen.getByRole('searchbox', { name: 'Filter changes' })

  it('is offered only past the threshold', async () => {
    await show()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('filters by path or a rename source, hiding empty groups, counts after', async () => {
    mockChanges.mockResolvedValue(changes({ entries: many }))
    await show()
    fireEvent.change(box(), { target: { value: 'GUIDE' } })
    expect(names('Untracked')).toEqual(['?Untracked: Guide.mddocs/'])
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Staged' })).toBeNull()
    fireEvent.change(box(), { target: { value: 'legacy' } })
    expect(names('Staged')).toHaveLength(1)
    fireEvent.change(box(), { target: { value: 'f1' } })
    // f1, f10..f14
    expect(within(group('Changes')).getByRole('heading')).toHaveTextContent(
      'Changes 6',
    )
    fireEvent.change(box(), { target: { value: 'nothing here' } })
    expect(screen.getByRole('status')).toHaveTextContent('No changes match')
    // Escape clears it; once empty it does nothing more
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(box()).toHaveValue('')
    fireEvent.keyDown(box(), { key: 'Escape' })
    fireEvent.keyDown(box(), { key: 'a' })
    expect(names('Changes')).toHaveLength(CHANGES_FILTER_MIN)
  })

  it('drops its text once the list is short enough to lose the box', async () => {
    mockChanges.mockResolvedValue(changes({ entries: many }))
    await show()
    fireEvent.change(box(), { target: { value: 'guide' } })
    mockChanges.mockResolvedValue(changes())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(screen.queryByRole('searchbox')).toBeNull()
    mockChanges.mockResolvedValue(changes({ entries: many }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(box()).toHaveValue('')
  })

  it('starts empty again when the view is left or the root moves', async () => {
    mockChanges.mockResolvedValue(changes({ entries: many }))
    const v = await show()
    fireEvent.change(box(), { target: { value: 'guide' } })
    v.unmount()
    await show()
    expect(box()).toHaveValue('')
    fireEvent.change(box(), { target: { value: 'guide' } })
    mockChanges.mockResolvedValue(changes({ entries: many, root: '/n' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(box()).toHaveValue('')
  })
})
