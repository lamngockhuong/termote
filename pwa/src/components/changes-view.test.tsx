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
import {
  CHANGES_FILTER_MIN,
  ChangesView,
  LIST_DOUBLE_CLICK_MS,
} from './changes-view'

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

  it('an open diff whose file is no longer changed closes its tab', async () => {
    vi.useFakeTimers()
    try {
      const p = props()
      const v = render(<ChangesView {...p} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      fireEvent.click(within(group('Changes')).getAllByRole('button')[1])
      mockChanges.mockResolvedValue(
        changes({ entries: ENTRIES.filter((e) => e.path !== 'gone.txt') }),
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(p.notify).toHaveBeenCalledWith('No changes left in gone.txt')
      expect(screen.queryByRole('tab', { name: /gone\.txt/ })).toBeNull()
      expect(group('Staged')).toBeInTheDocument()
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
    // The tab of the old root closed: opened again, the file asks again
    expect(screen.queryByRole('tab', { name: /\.env/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /\.env/ }))
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

  it('a Show lasts while its tab is open', async () => {
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
    // Back to the list and in again: still shown
    fireEvent.click(screen.getByRole('button', { name: 'Back to changes' }))
    fireEvent.click(screen.getByRole('button', { name: /\.env/ }))
    expect(await screen.findByTestId('diff')).toBeInTheDocument()
    // Closed and opened again: asked again
    fireEvent.keyDown(screen.getByRole('tab', { name: /\.env/ }), {
      key: 'Delete',
    })
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

describe('ChangesView tabs', () => {
  const TABS = [
    c('a.ts', '', 'M'),
    c('b.ts', '', 'M'),
    c('src/both.ts', 'M', 'M'),
  ]
  beforeEach(() => {
    mockChanges.mockResolvedValue(changes({ entries: TABS }))
    mockDiff.mockImplementation(async (_p: string, e: { path: string }) =>
      textDiff(e.path),
    )
    mockContent.mockImplementation(async (_p: string, path: string) => ({
      root: '/r',
      path,
      size: 1,
      text: 'a',
      hash: 'h',
      editable: true,
    }))
  })

  const tabs = () => screen.getAllByRole('tab').map((t) => t.textContent)

  it('a single click replaces the preview tab, a double click pins it', async () => {
    await show()
    await openDiff('Changes', 'a.ts')
    expect(tabs()).toEqual(['Changes', 'a.ts (preview)'])
    expect(screen.getByRole('tab', { name: /a\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
    await openDiff('Changes', 'b.ts')
    expect(tabs()).toEqual(['Changes', 'b.ts (preview)'])
    // The second click of a double click lands on the diff
    fireEvent.doubleClick(screen.getByTestId('diff'))
    expect(tabs()).toEqual(['Changes', 'b.ts'])
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
    await openDiff('Changes', 'a.ts')
    expect(tabs()).toEqual(['Changes', 'b.ts', 'a.ts (preview)'])
    // Too late for a double click: stays a preview
    const now = Date.now()
    const later = vi
      .spyOn(Date, 'now')
      .mockReturnValue(now + LIST_DOUBLE_CLICK_MS)
    fireEvent.doubleClick(screen.getByTestId('diff'))
    later.mockRestore()
    expect(tabs()).toEqual(['Changes', 'b.ts', 'a.ts (preview)'])
    // Double click on the tab pins it
    fireEvent.doubleClick(screen.getByRole('tab', { name: /a\.ts/ }))
    expect(tabs()).toEqual(['Changes', 'b.ts', 'a.ts'])
  })

  it('both sides of a file are two tabs, the staged one named so', async () => {
    await show()
    await openDiff('Staged', 'both.ts')
    fireEvent.doubleClick(screen.getByRole('tab', { name: /both\.ts/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
    await openDiff('Changes', 'both.ts')
    expect(tabs()).toEqual(['Changes', 'both.ts (staged)', 'both.ts (preview)'])
    expect(screen.getByRole('tab', { name: /staged/ })).toHaveAttribute(
      'title',
      'src/both.ts (Staged)',
    )
    expect(screen.getByText('Not staged')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /staged/ }))
    await act(async () => {})
    expect(screen.getByText('Staged', { selector: 'span' })).toBeInTheDocument()
  })

  it('switching tabs keeps each editor and its draft', async () => {
    await show()
    await openDiff('Changes', 'a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(
      await screen.findByRole('textbox', { name: 'Text of a.ts' }),
      { target: { value: 'changed' } },
    )
    // Editing pinned the tab: the next diff opens beside it
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
    await openDiff('Changes', 'b.ts')
    expect(tabs()).toEqual([
      'Changes',
      'a.ts (unsaved changes)',
      'b.ts (preview)',
    ])
    expect(
      screen.getByRole('button', { name: 'Back to changes' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ }))
    expect(
      await screen.findByRole('textbox', { name: 'Text of a.ts' }),
    ).toHaveValue('changed')
  })

  it('closing a tab with unsaved changes asks first', async () => {
    await show()
    await openDiff('Changes', 'a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'changed' },
    })
    const tab = () => screen.queryByRole('tab', { name: /a\.ts/ })
    fireEvent.keyDown(tab() as HTMLElement, { key: 'Delete' })
    expect(screen.getByText('Your changes to a.ts will be lost.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(tab()).toBeInTheDocument()
    fireEvent.keyDown(tab() as HTMLElement, { key: 'Delete' })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(tab()).toBeNull()
    expect(group('Changes')).toBeInTheDocument()
    // A clean one closes without asking
    await openDiff('Changes', 'b.ts')
    fireEvent.keyDown(screen.getByRole('tab', { name: /b\.ts/ }), {
      key: 'Delete',
    })
    expect(screen.queryAllByRole('tab')).toEqual([])
  })

  it('closing one of two tabs editing a file asks nothing: the changes stay', async () => {
    await show()
    await openDiff('Staged', 'both.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Edit working copy' }))
    fireEvent.change(
      await screen.findByRole('textbox', { name: 'Text of src/both.ts' }),
      { target: { value: 'changed' } },
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
    await openDiff('Changes', 'both.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(
      await screen.findByRole('textbox', { name: 'Text of src/both.ts' }),
    ).toHaveValue('changed')
    fireEvent.keyDown(screen.getByRole('tab', { name: /staged/ }), {
      key: 'Delete',
    })
    expect(screen.queryByText(/will be lost/)).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('textbox')).toHaveValue('changed')
  })

  it('not showing a sensitive file closes its tab', async () => {
    mockChanges.mockResolvedValue(changes())
    mockDiff.mockResolvedValue({
      root: '/r',
      path: '.env',
      truncated: false,
      sensitive: true,
      hunks: null,
    })
    await show()
    fireEvent.click(screen.getByRole('button', { name: /\.env/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryAllByRole('tab')).toEqual([])
  })

  it('several tabs closing at once are told in one notice', async () => {
    vi.useFakeTimers()
    try {
      const p = props()
      const v = render(<ChangesView {...p} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      await openDiff('Changes', 'a.ts')
      fireEvent.doubleClick(screen.getByRole('tab', { name: /a\.ts/ }))
      fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
      await openDiff('Changes', 'b.ts')
      mockChanges.mockResolvedValue(changes({ entries: [TABS[2]] }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(p.notify).toHaveBeenCalledWith('No changes left in 2 files')
      expect(screen.queryAllByRole('tab')).toEqual([])
      v.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a moved root asks about editors with unsaved changes', async () => {
    await show()
    await openDiff('Changes', 'a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'changed' },
    })
    mockChanges
      .mockRejectedValueOnce(
        new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
      )
      .mockResolvedValue(changes({ root: '/n', entries: TABS }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(screen.getByText('Close a file with unsaved changes?')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Discard and close' }))
    expect(screen.queryAllByRole('tab')).toEqual([])
  })

  it('a phone lists the open diffs in a sheet instead of a tab bar', async () => {
    await show({ isMobile: true })
    await openDiff('Changes', 'a.ts')
    expect(screen.queryByRole('tablist')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to changes' }))
    // The list's header counts them too
    fireEvent.click(screen.getByRole('button', { name: 'Open files (1)' }))
    const sheet = screen.getByRole('dialog', { name: 'Open files' })
    fireEvent.click(within(sheet).getByRole('button', { name: /^a\.ts/ }))
    await act(async () => {})
    expect(
      screen.getByRole('button', { name: 'Back to changes' }),
    ).toBeInTheDocument()
    // From the diff's header: Keep open, then close
    fireEvent.click(screen.getByRole('button', { name: 'Open files (1)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep a.ts open' }))
    expect(screen.queryByRole('button', { name: 'Keep a.ts open' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))
    expect(group('Changes')).toBeInTheDocument()
  })

  it('a tab shown again starts its diff where it was scrolled to', async () => {
    await show()
    await openDiff('Changes', 'a.ts')
    fireEvent.doubleClick(screen.getByRole('tab', { name: /a\.ts/ }))
    const frame = await screen.findByTestId('diff')
    frame.scrollTop = 80
    fireEvent.scroll(frame)
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
    await openDiff('Changes', 'b.ts')
    fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ }))
    expect((await screen.findByTestId('diff')).scrollTop).toBe(80)
  })
})

describe('ChangesView tab editor', () => {
  beforeEach(() => {
    mockChanges.mockResolvedValue(
      changes({ entries: [c('a.ts', '', 'M'), c('b.ts', '', 'M')] }),
    )
    mockDiff.mockImplementation(async (_p: string, e: { path: string }) =>
      textDiff(e.path),
    )
  })

  it('a tab shown again starts its editor where it was scrolled to', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'a.ts',
      size: 1,
      text: 'a',
      hash: 'h',
      editable: true,
    })
    await show()
    await openDiff('Changes', 'a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const box = await screen.findByRole('textbox', { name: 'Text of a.ts' })
    box.scrollTop = 70
    fireEvent.scroll(box)
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
    await openDiff('Changes', 'b.ts')
    fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ }))
    expect(
      (await screen.findByRole('textbox', { name: 'Text of a.ts' })).scrollTop,
    ).toBe(70)
  })

  it('a file the server finds sensitive is shown in the editor once asked', async () => {
    mockContent.mockImplementation(
      async (_p: string, path: string, o: { reveal: boolean }) =>
        o.reveal
          ? { root: '/r', path, size: 1, text: 'a', hash: 'h', editable: true }
          : { root: '/r', path, size: 1, sensitive: true },
    )
    await show()
    await openDiff('Changes', 'a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    expect(
      await screen.findByRole('textbox', { name: 'Text of a.ts' }),
    ).toHaveValue('a')
    // Kept by the tab: Back to the diff and in again asks no more
    fireEvent.click(screen.getByRole('button', { name: 'Back to the diff' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(await screen.findByRole('textbox')).toHaveValue('a')
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull()
  })
})
