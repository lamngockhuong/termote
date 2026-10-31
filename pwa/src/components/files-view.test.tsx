import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { ViewProps } from '../app-views'
import { ThemeProvider } from '../contexts/theme-context'
import { resetFileUploads, startUploads } from '../hooks/use-file-uploads'
import {
  requestFilesFocus,
  resetFilesStores,
  useFileDraft,
} from '../hooks/use-files'
import { type FileEntry, RequestError } from '../hooks/use-mux-api'
import { resetAllShortcuts, setShortcut } from '../hooks/use-shortcuts'
import { tFor } from '../i18n/i18n-context'
import {
  addReviewComment,
  loadReview,
  type ReviewComment,
  resetReviewDrafts,
} from '../utils/review-draft'
import { CHANGES_VIEW_ID } from '../view-ids'
import { FilesView, TREE_DOUBLE_CLICK_MS } from './files-view'

const mockTree = vi.fn()
const mockContent = vi.fn()
const mockCreate = vi.fn()
const mockFind = vi.fn()
const mockHash = vi.fn()
const mockDelete = vi.fn()
const mockRestore = vi.fn()
const mockRename = vi.fn()
const mockSearch = vi.fn()
const mockTrash = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFilesTree: (...a: unknown[]) => mockTree(...a),
  fetchFileContent: (...a: unknown[]) => mockContent(...a),
  createFile: (...a: unknown[]) => mockCreate(...a),
  findFiles: (...a: unknown[]) => mockFind(...a),
  fetchFileHash: (...a: unknown[]) => mockHash(...a),
  deleteFile: (...a: unknown[]) => mockDelete(...a),
  restoreFile: (...a: unknown[]) => mockRestore(...a),
  renameFile: (...a: unknown[]) => mockRename(...a),
  searchFiles: (...a: unknown[]) => mockSearch(...a),
  fetchTrash: (...a: unknown[]) => mockTrash(...a),
}))
const mockCheckUpload = vi.fn()
const mockUploadFile = vi.fn()
vi.mock('../utils/upload-file', async (orig) => ({
  ...(await orig<typeof import('../utils/upload-file')>()),
  checkUpload: (...a: unknown[]) => mockCheckUpload(...a),
  uploadFile: (...a: unknown[]) => mockUploadFile(...a),
}))
const mockDownload = vi.fn()
vi.mock('../utils/download-file', () => ({
  downloadFile: (...a: unknown[]) => mockDownload(...a),
}))
vi.mock('../utils/highlight', async (orig) => ({
  ...(await orig<typeof import('../utils/highlight')>()),
  highlight: async () => null,
  highlightLang: async () => null,
}))

const e = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({
  name,
  type: 'file',
  size: 1,
  sensitive: false,
  ...over,
})
const DIRS: Record<string, FileEntry[]> = {
  '': [
    e('src', { type: 'dir' }),
    e('link', { type: 'symlink', target: 'dir' }),
    e('.env', { sensitive: true }),
    e('broken', { type: 'symlink' }),
    e('fifo', { type: 'other' }),
    e('README.md'),
  ],
  src: [e('lib', { type: 'dir' }), e('a.ts')],
  'src/lib': [],
  link: [e('x')],
}

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

async function show(over: Partial<ViewProps> = {}) {
  const p = props(over)
  const view = render(
    <ThemeProvider>
      <FilesView {...p} />
    </ThemeProvider>,
  )
  await act(async () => {})
  return { ...p, ...view }
}

const item = (name: string) =>
  screen.getByRole('treeitem', {
    name: new RegExp(`^${name.replace('.', '\\.')}`),
  })

// The lazy Markdown renderer, loaded once up front: its first load can
// outlast a find under coverage
beforeAll(() => import('./markdown-preview'))

beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  resetFilesStores()
  mockContent.mockReset()
  mockTree.mockReset()
  mockTree.mockImplementation(async (_p: string, path: string) => ({
    root: '/home/kim/app',
    isRepo: true,
    path,
    entries: DIRS[path],
    truncated: path === 'link',
  }))
})

describe('FilesView', () => {
  it('waits for a pane', async () => {
    await show({ session: { id: '1', name: 'x', icon: '', description: '' } })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(mockTree).not.toHaveBeenCalled()
  })

  it('lists the root, directories first, with sensitive and unopenable entries marked', async () => {
    await show()
    expect(screen.getByTestId('pane-root')).toHaveTextContent('~/app')
    const tree = screen.getByRole('tree', { name: 'Files' })
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(6)
    expect(item('src')).toHaveAttribute('aria-expanded', 'false')
    expect(item('link')).toHaveAttribute('aria-expanded', 'false')
    expect(item('README.md')).not.toHaveAttribute('aria-expanded')
    expect(item('.env')).toHaveTextContent('Sensitive')
    expect(item('fifo')).toHaveAttribute('aria-disabled', 'true')
    expect(item('broken')).toHaveAttribute('aria-disabled', 'true')
    expect(item('src')).toHaveAttribute('tabindex', '0')
    expect(item('README.md')).toHaveAttribute('tabindex', '-1')
  })

  it('opens a directory on click, showing its entries one level down', async () => {
    let finish!: () => void
    await show()
    const real = mockTree.getMockImplementation()!
    mockTree.mockImplementationOnce(
      (...a: [string, string]) =>
        new Promise((r) => (finish = () => r(real(...a)))),
    )
    fireEvent.click(item('src'))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await act(async () => finish())
    expect(item('src')).toHaveAttribute('aria-expanded', 'true')
    expect(item('a.ts')).toHaveAttribute('aria-level', '2')
    fireEvent.click(item('lib'))
    await act(async () => {})
    expect(screen.getByText('Empty')).toBeInTheDocument()
    // Through a symlink, and a listing cut at the server's limit
    fireEvent.click(item('link'))
    await act(async () => {})
    expect(
      screen.getByText('Only the first 5000 entries are shown'),
    ).toBeInTheDocument()
    fireEvent.click(item('src'))
    expect(screen.queryByRole('treeitem', { name: 'a.ts' })).toBeNull()
  })

  it('a directory that cannot be read says why', async () => {
    await show()
    mockTree.mockRejectedValueOnce(new RequestError(403, '', 'x'))
    fireEvent.click(item('src'))
    await act(async () => {})
    // The error shows only once the directory is open again; it closed
    expect(item('src')).toHaveAttribute('aria-expanded', 'false')
    let finish!: (v: unknown) => void
    mockTree.mockReturnValueOnce(new Promise((_, r) => (finish = r)))
    fireEvent.click(item('src'))
    await act(async () => finish(new RequestError(500, '', 'x')))
    expect(item('src')).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens a file in place of the tree and comes back', async () => {
    mockContent.mockResolvedValue({
      root: '/home/kim/app',
      path: 'README.md',
      size: 3,
      text: 'hi',
    })
    await show({ isMobile: true })
    fireEvent.click(item('README.md'))
    expect(await screen.findByTestId('markdown-preview')).toBeInTheDocument()
    expect(screen.queryByRole('tree')).toBeNull()
    // Mobile wraps at first; the setting is in the More actions menu there
    expect(screen.queryByRole('button', { name: 'Wrap lines' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Wrap lines' }),
    ).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    expect(screen.getByRole('tree')).toBeInTheDocument()
    // An entry that is neither file nor directory does not open
    fireEvent.click(item('fifo'))
    expect(screen.getByRole('tree')).toBeInTheDocument()
  })

  it.each([
    [false, true],
    [true, false],
  ])('readOnly %s: Edit offered %s', async (readOnly, offered) => {
    mockContent.mockResolvedValue({
      root: '/home/kim/app',
      path: 'README.md',
      size: 3,
      text: 'hi',
      hash: 'h',
      editable: true,
    })
    await show({ readOnly })
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    expect(!!screen.queryByRole('button', { name: 'Edit' })).toBe(offered)
  })

  it('offers a file in a new window where the App can open one', async () => {
    mockContent.mockResolvedValue({
      root: '/home/kim/app',
      path: 'README.md',
      size: 3,
      text: 'hi',
    })
    const openWindow = vi.fn()
    await show({ openWindow })
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    fireEvent.click(
      screen.getByRole('button', { name: 'Open in new window' }),
      { shiftKey: true },
    )
    expect(openWindow).toHaveBeenCalledWith(
      { view: 'files', file: 'README.md' },
      { shiftKey: true },
    )
  })

  it('fades in the rows of a folder opened after the first listing', async () => {
    await show()
    const enters = 'motion-safe:starting:opacity-0'
    expect(item('src')).not.toHaveClass(enters)
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowRight' })
    await act(async () => {})
    expect(item('lib')).toHaveClass(enters)
    expect(item('README.md')).not.toHaveClass(enters)
  })

  it('moves through the tree with the keyboard', async () => {
    mockContent.mockResolvedValue({
      root: '/home/kim/app',
      path: 'x',
      size: 1,
      text: 'x',
    })
    await show()
    const tree = screen.getByRole('tree')
    const key = (k: string) => fireEvent.keyDown(tree, { key: k })
    key('ArrowRight') // opens src
    await act(async () => {})
    expect(item('src')).toHaveAttribute('aria-expanded', 'true')
    key('ArrowRight') // into its first child
    expect(item('lib')).toHaveFocus()
    key('ArrowLeft') // to the parent
    expect(item('src')).toHaveFocus()
    key('ArrowDown')
    expect(item('lib')).toHaveFocus()
    key('ArrowUp')
    expect(item('src')).toHaveFocus()
    key('ArrowUp') // nothing above
    expect(item('src')).toHaveFocus()
    key('End')
    expect(item('README.md')).toHaveFocus()
    key('ArrowRight') // a file: nothing
    key('ArrowLeft') // top level: nothing
    expect(item('README.md')).toHaveFocus()
    key('Home')
    key('ArrowLeft') // closes src
    expect(item('src')).toHaveAttribute('aria-expanded', 'false')
    key('Enter') // opens it again
    expect(item('src')).toHaveAttribute('aria-expanded', 'true')
    key(' ') // and closes
    expect(item('src')).toHaveAttribute('aria-expanded', 'false')
    key('x') // ignored
    // An open directory with nothing in it: Right stays
    mockTree.mockResolvedValueOnce({
      root: '/home/kim/app',
      isRepo: true,
      path: 'link',
      entries: [],
      truncated: false,
    })
    fireEvent.click(item('link'))
    await act(async () => {})
    key('ArrowRight')
    expect(item('link')).toHaveAttribute('tabindex', '0')
    expect(item('link')).toHaveAttribute('aria-expanded', 'true')
    key('End')
    key('Enter')
    expect(await screen.findByTestId('markdown-preview')).toBeInTheDocument()
  })

  it('a Show is not carried to the same path under a new root', async () => {
    mockContent.mockImplementation(
      async (_p: string, path: string, o: { reveal: boolean }) =>
        o.reveal
          ? { root: '/home/kim/app', path, size: 3, text: 'A=1' }
          : { root: '/home/kim/app', path, sensitive: true },
    )
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    await show()
    fireEvent.click(item('.env'))
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    expect(await screen.findByTestId('code-block')).toBeInTheDocument()
    // The pane moved to another repo: the same .env there must ask again
    mockTree.mockRejectedValueOnce(
      new RequestError(409, '', 'root changed', { root: '/home/kim/other' }),
    )
    // The server answers with the root it has now
    mockTree.mockImplementation(async (_p: string, path: string) => ({
      root: '/home/kim/other',
      isRepo: true,
      path,
      entries: DIRS[path],
      truncated: false,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await act(async () => {})
    // Its tab closed with the old root: nothing unsaved in it
    expect(screen.queryByTestId('code-block')).toBeNull()
    expect(screen.queryByRole('tab', { name: '.env' })).toBeNull()
    fireEvent.click(item('.env'))
    await act(async () => {})
    expect(mockContent).toHaveBeenLastCalledWith({ paneId: '%1' }, '.env', {
      root: '/home/kim/other',
      reveal: false,
    })
    expect(screen.queryByTestId('code-block')).toBeNull()
  })

  it('says why the root cannot be listed', async () => {
    mockTree.mockRejectedValue(new RequestError(501, '', 'x'))
    await show()
    expect(
      screen.getByText('Not supported by this backend'),
    ).toBeInTheDocument()
  })

  it('says when the root is empty, and refreshes it', async () => {
    mockTree.mockResolvedValue({
      root: '/w',
      isRepo: false,
      path: '',
      entries: [],
      truncated: false,
    })
    await show()
    expect(screen.getByText('This directory is empty')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(mockTree).toHaveBeenCalledTimes(2)
  })

  it('tells once when the pane directory moved', async () => {
    const p = await show()
    mockTree.mockRejectedValueOnce(
      new RequestError(409, '', 'root changed', { root: '/n' }),
    )
    fireEvent.click(item('src'))
    await act(async () => {})
    expect(p.notify).toHaveBeenCalledExactlyOnceWith(
      "The pane's directory changed",
    )
    p.rerender(
      <ThemeProvider>
        <FilesView {...p} />
      </ThemeProvider>,
    )
    expect(p.notify).toHaveBeenCalledTimes(1)
  })

  it('follows the links of a Markdown file, and Back retraces them', async () => {
    mockContent.mockImplementation(async (_p: string, path: string) => ({
      root: '/home/kim/app',
      path,
      size: 3,
      text:
        path === 'README.md'
          ? '[code](src/a.ts) [lib](src/lib/) [gone](nope.md) [fifo](fifo)'
          : 'code',
    }))
    const p = await show()
    fireEvent.click(item('README.md'))
    fireEvent.click(await screen.findByRole('button', { name: 'code' }))
    expect(await screen.findByTestId('code-block')).toHaveTextContent('code')
    fireEvent.click(screen.getByRole('button', { name: 'Back to README.md' }))
    expect(await screen.findByTestId('markdown-preview')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'gone' }))
    await act(async () => {})
    expect(p.notify).toHaveBeenCalledWith('Not found')
    fireEvent.click(screen.getByRole('button', { name: 'fifo' }))
    await act(async () => {})
    expect(p.notify).toHaveBeenCalledWith("This link can't be opened")

    fireEvent.click(screen.getByRole('button', { name: 'lib' }))
    await act(async () => {})
    expect(item('src')).toHaveAttribute('aria-expanded', 'true')
    expect(item('lib')).toHaveAttribute('aria-expanded', 'true')
  })

  describe('New file', () => {
    const newFile = () => screen.queryByRole('button', { name: 'New file' })
    beforeEach(() => {
      mockCreate.mockReset()
      HTMLDialogElement.prototype.showModal = vi.fn(function (
        this: HTMLDialogElement,
      ) {
        this.setAttribute('open', '')
      })
      HTMLDialogElement.prototype.close = vi.fn()
    })

    it('is offered from the tree only, and not to a view-only client', async () => {
      mockContent.mockResolvedValue({
        root: '/home/kim/app',
        path: 'README.md',
        size: 3,
        text: 'hi',
      })
      const { unmount } = await show({ readOnly: true })
      expect(newFile()).toBeNull()
      unmount()
      await show()
      expect(newFile()).toBeInTheDocument()
      fireEvent.click(item('README.md'))
      expect(newFile()).toBeNull()
    })

    it('is offered under an empty root', async () => {
      mockTree.mockResolvedValue({
        root: '/home/kim/app',
        isRepo: false,
        path: '',
        entries: [],
        truncated: false,
      })
      await show()
      expect(screen.getByText('This directory is empty')).toBeInTheDocument()
      fireEvent.click(newFile()!)
      expect(screen.getByRole('textbox')).toHaveValue('')
    })

    it.each([
      [[], ''],
      [['src'], 'src/'],
      [['src', 'a.ts'], 'src/'],
      [['src', 'lib'], 'src/lib/'],
      [['README.md'], ''],
    ])('after a click on %j it starts in %j', async (clicks, start) => {
      mockContent.mockResolvedValue({
        root: '/home/kim/app',
        size: 1,
        text: 'x',
      })
      await show()
      for (const name of clicks) {
        fireEvent.click(item(name))
        await act(async () => {})
      }
      // A file opened: the tree, back, still knows where it was
      const back = screen.queryByRole('button', { name: 'Back to files' })
      if (back) fireEvent.click(back)
      fireEvent.click(newFile()!)
      expect(screen.getByRole('textbox')).toHaveValue(start)
      // Closed: the box starts again next time
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('textbox')).toBeNull()
    })

    it('opens the new file into editing, with the tree opened down to it', async () => {
      DIRS.src.push(e('new.md', { size: 0 }))
      mockCreate.mockResolvedValue({
        root: '/home/kim/app',
        path: 'src/new.md',
      })
      mockContent.mockImplementation(async (_p: string, path: string) => ({
        root: '/home/kim/app',
        path,
        size: 0,
        text: '',
        hash: 'h0',
        editable: true,
      }))
      try {
        await show()
        fireEvent.click(newFile()!)
        fireEvent.change(screen.getByRole('textbox'), {
          target: { value: 'src/new.md' },
        })
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        })
        expect(mockCreate).toHaveBeenCalledWith(
          { paneId: '%1' },
          {
            root: '/home/kim/app',
            path: 'src/new.md',
            reveal: false,
          },
        )
        expect(
          await screen.findByRole('textbox', { name: 'Text of src/new.md' }),
        ).toHaveValue('')
        expect(mockContent).toHaveBeenLastCalledWith(
          { paneId: '%1' },
          'src/new.md',
          {
            root: '/home/kim/app',
            reveal: false,
          },
        )
        fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
        fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
        expect(item('src')).toHaveAttribute('aria-expanded', 'true')
        expect(item('new.md')).toHaveAttribute('aria-level', '2')
      } finally {
        DIRS.src.pop()
      }
    })

    it('a name that holds secrets opens without asking to Show it', async () => {
      mockCreate
        .mockRejectedValueOnce(new RequestError(403, 'sensitive', 'x'))
        .mockResolvedValueOnce({ root: '/home/kim/app', path: '.env.local' })
      mockContent.mockImplementation(
        async (_p: string, path: string, o: { reveal: boolean }) =>
          o.reveal
            ? {
                root: '/home/kim/app',
                path,
                size: 0,
                text: '',
                hash: 'h0',
                editable: true,
              }
            : { root: '/home/kim/app', path, sensitive: true },
      )
      await show()
      fireEvent.click(newFile()!)
      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: '.env.local' },
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
      })
      await act(async () => {
        fireEvent.click(
          within(
            screen.getByRole('dialog', { name: 'Create this file?' }),
          ).getByRole('button', { name: 'Create' }),
        )
      })
      expect(
        await screen.findByRole('textbox', { name: 'Text of .env.local' }),
      ).toBeInTheDocument()
      expect(mockContent).toHaveBeenCalledTimes(1)
      expect(mockContent).toHaveBeenCalledWith({ paneId: '%1' }, '.env.local', {
        root: '/home/kim/app',
        reveal: true,
      })
      expect(
        screen.queryByRole('dialog', { name: 'Show this file?' }),
      ).toBeNull()
    })
  })
})

describe('FilesView search', () => {
  it('offers no ignored files to a view-only client', async () => {
    const { unmount } = await show({ readOnly: true })
    expect(screen.queryByRole('switch', { name: 'Include ignored' })).toBeNull()
    unmount()
    await show()
    expect(
      screen.getByRole('switch', { name: 'Include ignored' }),
    ).toBeInTheDocument()
  })

  it('finds a file anywhere, opens it, and Back returns to the results', async () => {
    mockFind.mockResolvedValue({
      root: '/home/kim/app',
      isRepo: true,
      results: [{ path: 'src/a.ts', ignored: false, sensitive: false }],
      truncated: false,
      incomplete: false,
    })
    mockContent.mockResolvedValue({
      root: '/home/kim/app',
      path: 'src/a.ts',
      size: 1,
      text: 'x',
      hash: 'h',
      editable: true,
    })
    await show()
    const box = screen.getByRole('searchbox', { name: 'Find a file' })
    fireEvent.change(box, { target: { value: 'a.ts' } })
    const hit = await screen.findByRole('button', { name: /a\.ts/ })
    expect(screen.queryByRole('tree')).toBeNull()
    fireEvent.click(hit)
    expect(
      await screen.findByRole('button', { name: 'Back to files' }),
    ).toBeInTheDocument()
    expect(mockContent).toHaveBeenCalledWith(
      { paneId: '%1' },
      'src/a.ts',
      expect.anything(),
    )
    // The tree was opened down to it meanwhile
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    expect(screen.getByRole('searchbox')).toHaveValue('a.ts')
    expect(
      await screen.findByRole('button', { name: /a\.ts/ }),
    ).toBeInTheDocument()
    // A refresh with a query reads the files again
    mockFind.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() =>
      expect(mockFind).toHaveBeenLastCalledWith(
        { paneId: '%1' },
        expect.objectContaining({ fresh: true }),
        expect.any(AbortSignal),
      ),
    )
    // Cleared: the tree as it was, src opened down to the file
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(item('src')).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('FilesView content search', () => {
  const answer = (root = '/home/kim/app') => ({
    root,
    isRepo: true,
    files: [
      {
        path: 'src/a.ts',
        matches: [{ line: 2, text: 'foo', col: 0, ranges: [[0, 3]] }],
        more: 0,
      },
    ],
    truncated: false,
    incomplete: false,
    skipped: { sensitive: 0, hidden: 0, binary: 0, tooLarge: 0 },
  })

  beforeEach(() => {
    mockSearch.mockReset()
    mockSearch.mockResolvedValue(answer())
    mockContent.mockResolvedValue({
      root: '/home/kim/app',
      path: 'src/a.ts',
      size: 9,
      text: 'x\nfoo\ny',
      hash: 'h',
      editable: true,
    })
  })

  const searchBox = () =>
    screen.getByRole('searchbox', { name: 'Search file contents' })

  it('a result opens its file at the line, and Back shows the same results without a request', async () => {
    await show()
    fireEvent.click(screen.getByRole('radio', { name: 'Search' }))
    expect(screen.queryByRole('tree')).toBeNull()
    fireEvent.change(searchBox(), { target: { value: 'foo' } })
    const hit = await screen.findByRole('button', { name: /^2foo/ })
    fireEvent.click(hit)
    const code = await screen.findByTestId('code-block')
    await waitFor(() =>
      expect(code.querySelector('[data-line="2"]')).toHaveClass('bg-accent/15'),
    )
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    expect(searchBox()).toHaveValue('foo')
    expect(screen.getByRole('button', { name: /^2foo/ })).toBeInTheDocument()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350))
    })
    expect(mockSearch).toHaveBeenCalledTimes(1)
    // The Files tab keeps the tree
    fireEvent.click(screen.getByRole('radio', { name: 'Files' }))
    expect(screen.getByRole('tree')).toBeInTheDocument()
  })

  it('Ctrl+Shift+F from inside Files shows and focuses the search, from a file too', async () => {
    await show()
    fireEvent.keyDown(item('src'), {
      key: 'F',
      code: 'KeyF',
      ctrlKey: true,
      shiftKey: true,
    })
    expect(searchBox()).toHaveFocus()
    fireEvent.click(screen.getByRole('radio', { name: 'Files' }))
    fireEvent.click(item('README.md'))
    await screen.findByRole('button', { name: 'Back to files' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back to files' }), {
      key: 'f',
      code: 'KeyF',
      metaKey: true,
      shiftKey: true,
    })
    expect(searchBox()).toHaveFocus()
  })

  it('other keys, and the shortcut from a dialog, are left alone', async () => {
    await show()
    const tree = screen.getByRole('tree')
    for (const k of [
      { key: 'F', code: 'KeyF', ctrlKey: true },
      { key: 'F', code: 'KeyF', shiftKey: true },
      { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true, altKey: true },
      { key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true },
    ])
      fireEvent.keyDown(tree, k)
    expect(
      screen.queryByRole('searchbox', { name: 'Search file contents' }),
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New file' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(within(dialog).getByRole('textbox'), {
      key: 'F',
      code: 'KeyF',
      ctrlKey: true,
      shiftKey: true,
    })
    expect(
      screen.queryByRole('searchbox', { name: 'Search file contents' }),
    ).toBeNull()
  })

  it('Ctrl+Shift+F works on a narrow layout too', async () => {
    await show({ isMobile: true })
    fireEvent.keyDown(screen.getByRole('tree'), {
      key: 'F',
      code: 'KeyF',
      ctrlKey: true,
      shiftKey: true,
    })
    expect(searchBox()).toHaveFocus()
  })

  it('follows the content search key the user set', async () => {
    try {
      setShortcut('files.searchContent', { key: 'Mod+Alt+F' })
      await show()
      const tree = screen.getByRole('tree')
      fireEvent.keyDown(tree, {
        key: 'F',
        code: 'KeyF',
        ctrlKey: true,
        shiftKey: true,
      })
      expect(
        screen.queryByRole('searchbox', { name: 'Search file contents' }),
      ).toBeNull()
      fireEvent.keyDown(tree, {
        key: 'f',
        code: 'KeyF',
        ctrlKey: true,
        altKey: true,
      })
      expect(searchBox()).toHaveFocus()
    } finally {
      resetAllShortcuts()
    }
  })

  it('has no content search key once the user removed it', async () => {
    try {
      setShortcut('files.searchContent', { key: null })
      await show()
      fireEvent.keyDown(screen.getByRole('tree'), {
        key: 'F',
        code: 'KeyF',
        ctrlKey: true,
        shiftKey: true,
      })
      expect(
        screen.queryByRole('searchbox', { name: 'Search file contents' }),
      ).toBeNull()
    } finally {
      resetAllShortcuts()
    }
  })

  it('focuses the file shown when asked from outside', async () => {
    await show()
    fireEvent.click(item('README.md'))
    await screen.findByRole('button', { name: 'Back to files' })
    act(() => requestFilesFocus('%1', 'file'))
    expect(document.activeElement).toHaveAttribute('tabindex', '-1')
    expect(document.activeElement).toContainElement(
      screen.getByRole('button', { name: 'Back to files' }),
    )
  })

  it('focuses the search once when asked from outside, shown or not yet', async () => {
    requestFilesFocus('%1', 'search')
    const { unmount } = await show()
    expect(searchBox()).toHaveFocus()
    unmount()
    await show()
    expect(
      screen.queryByRole('searchbox', { name: 'Search file contents' }),
    ).toBeNull()
    act(() => requestFilesFocus('%1', 'search'))
    expect(searchBox()).toHaveFocus()
    // Another pane's request is left for that pane
    act(() => requestFilesFocus('%2', 'search'))
    fireEvent.click(screen.getByRole('radio', { name: 'Files' }))
    act(() => requestFilesFocus('%9', 'search'))
    expect(screen.getByRole('tree')).toBeInTheDocument()
  })

  it('a refresh with a content query searches again with fresh', async () => {
    await show()
    fireEvent.click(screen.getByRole('radio', { name: 'Search' }))
    fireEvent.change(searchBox(), { target: { value: 'foo' } })
    await screen.findByRole('button', { name: /^2foo/ })
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() =>
      expect(mockSearch).toHaveBeenLastCalledWith(
        { paneId: '%1' },
        expect.objectContaining({ fresh: true }),
        expect.any(AbortSignal),
      ),
    )
  })
})

// The button of the last toast asked for
function lastAction(notify: ViewProps['notify']) {
  const calls = vi.mocked(notify).mock.calls
  return calls[calls.length - 1][1]!.action!
}

describe('FilesView delete', () => {
  const trashCaps = {
    backend: 'tmux',
    caps: { clientSideSelect: false, copyMode: true, files: true, trash: true },
  }
  const withTrash = (over: Partial<ViewProps> = {}) =>
    show({ mux: trashCaps, ...over })
  const actions = (name: string) =>
    within(item(name)).getByRole('button', { name: `Actions for ${name}` })
  const choose = async (name: string) => {
    fireEvent.click(actions(name))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /^Delete/ }))
    })
  }
  const confirm = async () => {
    const del = await within(await screen.findByRole('dialog')).findByRole(
      'button',
      { name: 'Delete' },
    )
    await waitFor(() => expect(del).toBeEnabled())
    await act(async () => fireEvent.click(del))
  }

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    mockHash.mockReset()
    mockDelete.mockReset()
    mockRestore.mockReset()
    mockTrash.mockReset()
    mockHash.mockResolvedValue({ root: '/r', path: 'x', size: 1, hash: 'hh' })
  })

  it('is offered only with a trash and to a client that may write', async () => {
    const { unmount } = await show()
    // Without a trash the row's menu holds Rename only
    fireEvent.click(actions('README.md'))
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Delete/ })).toBeNull()
    unmount()
    const second = await withTrash({ readOnly: true })
    expect(
      within(item('README.md')).queryByRole('button', { name: /Actions/ }),
    ).toBeNull()
    // The Delete key does nothing then
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' })
    expect(screen.queryByText('Delete file?')).toBeNull()
    second.unmount()
    await withTrash()
    expect(actions('README.md')).toHaveAttribute('tabindex', '-1')
  })

  it('deletes a file into the trash, and Undo puts it back', async () => {
    mockDelete.mockResolvedValue({
      root: '/home/kim/app',
      path: 'README.md',
      trashId: 't1',
    })
    mockRestore.mockResolvedValue({ root: '/home/kim/app', path: 'README.md' })
    const p = await withTrash()
    await choose('README.md')
    expect(screen.getByText('/home/kim/app/README.md')).toBeInTheDocument()
    await confirm()
    expect(mockDelete.mock.calls[0][1]).toMatchObject({
      root: '/home/kim/app',
      path: 'README.md',
      kind: 'file',
      baseHash: 'hh',
    })
    expect(p.notify).toHaveBeenLastCalledWith('Deleted README.md', {
      action: { label: 'Undo', onClick: expect.any(Function) },
    })
    const undo = lastAction(p.notify)
    await act(async () => undo.onClick())
    expect(mockRestore).toHaveBeenCalledWith(
      { paneId: '%1' },
      {
        root: '/home/kim/app',
        trashId: 't1',
        reveal: false,
      },
    )
    expect(p.notify).toHaveBeenLastCalledWith('Restored README.md', {
      variant: 'success',
    })
  })

  it('shows unsafe characters in the name a toast gives', async () => {
    mockDelete.mockResolvedValue({
      root: '/r',
      path: 'a\u202eb.md',
      trashId: 't',
    })
    const p = await withTrash()
    await choose('README.md')
    await confirm()
    expect(p.notify).toHaveBeenLastCalledWith('Deleted a⟨U+202E⟩b.md', {
      action: { label: 'Undo', onClick: expect.any(Function) },
    })
  })

  it('Undo says why it could not restore', async () => {
    mockDelete.mockResolvedValue({ root: '/r', path: '.env', trashId: 't' })
    mockRestore
      .mockRejectedValueOnce(
        new RequestError(409, 'exists', 'x', { path: 'n/.env' }),
      )
      .mockRejectedValueOnce(new RequestError(409, 'exists', 'x'))
      .mockRejectedValueOnce(
        new RequestError(409, '', 'root changed', { root: '/n' }),
      )
      .mockRejectedValueOnce(new Error('offline'))
    const p = await withTrash()
    await choose('.env')
    expect(screen.getByText('This is a sensitive file')).toBeInTheDocument()
    await confirm()
    expect(mockDelete.mock.calls[0][1].reveal).toBe(true)
    const undo = lastAction(p.notify)
    await act(async () => undo.onClick())
    expect(mockRestore.mock.calls[0][1].reveal).toBe(true)
    expect(p.notify).toHaveBeenLastCalledWith(
      'A file now exists at n/.env; not restored',
      { variant: 'warning' },
    )
    await act(async () => undo.onClick())
    expect(p.notify).toHaveBeenLastCalledWith(
      'A file now exists at .env; not restored',
      { variant: 'warning' },
    )
    await act(async () => undo.onClick())
    expect(p.notify).toHaveBeenCalledWith(
      "The pane's directory changed; .env was not restored",
      { variant: 'warning' },
    )
    await act(async () => undo.onClick())
    expect(p.notify).toHaveBeenLastCalledWith('Could not restore .env', {
      variant: 'danger',
    })
  })

  it('an Undo of an entry gone elsewhere says so neutrally', async () => {
    mockDelete.mockResolvedValue({
      root: '/r',
      path: 'README.md',
      trashId: 't',
    })
    mockRestore.mockRejectedValueOnce(
      new RequestError(404, 'not_in_trash', 'x'),
    )
    const p = await withTrash()
    await choose('README.md')
    await confirm()
    await act(async () => lastAction(p.notify).onClick())
    expect(p.notify).toHaveBeenLastCalledWith(
      'README.md was already restored or removed',
      { variant: 'info' },
    )
  })

  it('offers the Trash only with a trash, to a full client, once the root is read', async () => {
    const { unmount } = await show()
    expect(screen.queryByRole('button', { name: 'Trash' })).toBeNull()
    unmount()
    const second = await withTrash({ readOnly: true })
    expect(screen.queryByRole('button', { name: 'Trash' })).toBeNull()
    second.unmount()
    // The root not read yet: none (the store read it above)
    resetFilesStores()
    let answer: (v: unknown) => void = () => {}
    mockTree.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    )
    await withTrash()
    expect(screen.queryByRole('button', { name: 'Trash' })).toBeNull()
    await act(async () =>
      answer({
        root: '/home/kim/app',
        isRepo: true,
        path: '',
        entries: DIRS[''],
      }),
    )
    expect(screen.getByRole('button', { name: 'Trash' })).toBeInTheDocument()
  })

  it('opens the Trash of the root shown, with a file open too', async () => {
    mockContent.mockResolvedValue({
      root: '/home/kim/app',
      path: 'README.md',
      size: 3,
      text: 'hi',
    })
    mockTrash.mockResolvedValue({ root: '/home/kim/app', entries: [] })
    await withTrash()
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Trash' })),
    )
    expect(mockTrash).toHaveBeenCalledWith(
      { paneId: '%1', place: undefined },
      '/home/kim/app',
    )
    expect(screen.getByText(/The trash is empty/)).toBeInTheDocument()
  })

  it('a file restored from the Trash shows in the tree again', async () => {
    mockTrash.mockResolvedValue({
      root: '/home/kim/app',
      entries: [
        {
          trashId: 't',
          path: 'src/b.ts',
          kind: 'file',
          deletedAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          size: 1,
        },
      ],
    })
    mockRestore.mockResolvedValue({ root: '/home/kim/app', path: 'src/b.ts' })
    await withTrash()
    mockTree.mockClear()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Trash' })),
    )
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Restore b.ts' })),
    )
    // The folders down to it are read again, src opened
    expect(mockTree.mock.calls.map((c) => c[1])).toEqual(
      expect.arrayContaining(['', 'src']),
    )
    expect(item('src')).toHaveAttribute('aria-expanded', 'true')
  })

  it('a discard restored from the Trash reads its open tab again', async () => {
    mockContent.mockResolvedValue({
      root: '/home/kim/app',
      path: 'README.md',
      size: 3,
      text: 'hi',
    })
    const discard = {
      trashId: 'x',
      path: 'README.md',
      kind: 'discard',
      deletedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      size: 3,
    }
    mockTrash.mockResolvedValue({ root: '/home/kim/app', entries: [discard] })
    mockRestore.mockResolvedValue({ root: '/home/kim/app', path: 'README.md' })
    await withTrash()
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    const reads = mockContent.mock.calls.length
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Trash' })),
    )
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Restore the discarded text of README.md',
        }),
      ),
    )
    await waitFor(() =>
      expect(mockContent.mock.calls.length).toBeGreaterThan(reads),
    )
    // Another file's discard restored: this tab is not read again
    mockTrash.mockResolvedValue({
      root: '/home/kim/app',
      entries: [{ ...discard, trashId: 'y', path: 'src/a.ts' }],
    })
    mockRestore.mockResolvedValue({ root: '/home/kim/app', path: 'src/a.ts' })
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Close' })),
    )
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Trash' })),
    )
    const after = mockContent.mock.calls.length
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Restore the discarded text of a.ts',
        }),
      ),
    )
    await act(async () => {})
    expect(
      mockContent.mock.calls.slice(after).filter((c) => c[1] === 'README.md'),
    ).toHaveLength(0)
  })

  it('deletes for good after a second ask, with no Undo', async () => {
    mockDelete
      .mockRejectedValueOnce(new RequestError(409, 'cross_device', 'x'))
      .mockResolvedValueOnce({ root: '/r', path: 'README.md', permanent: true })
    const p = await withTrash()
    await choose('README.md')
    await confirm()
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Delete permanently' }),
      ),
    )
    expect(p.notify).toHaveBeenLastCalledWith('Deleted README.md permanently')
  })

  it('a swapped file in the trash still gets an Undo', async () => {
    mockDelete.mockRejectedValue(
      new RequestError(409, 'changed', 'x', { trashId: 'sw' }),
    )
    const p = await withTrash()
    await choose('README.md')
    await confirm()
    expect(p.notify).toHaveBeenLastCalledWith(
      'README.md changed; the file that was there is in the trash',
      {
        variant: 'warning',
        action: { label: 'Undo', onClick: expect.any(Function) },
      },
    )
    expect(item('README.md')).toBeInTheDocument()
    mockRestore.mockResolvedValue({ root: '/r', path: 'README.md' })
    const undo = lastAction(p.notify)
    await act(async () => undo.onClick())
    expect(mockRestore.mock.calls[0][1].trashId).toBe('sw')
  })

  it("the row menu's own keys never reach the tree", async () => {
    await withTrash()
    fireEvent.keyDown(actions('README.md'), { key: 'Delete' })
    await act(async () => {})
    expect(screen.queryByText('Delete file?')).toBeNull()
  })

  it('a file shown without its text is hashed by the box', async () => {
    mockContent.mockResolvedValue({
      root: '/home/kim/app',
      path: 'README.md',
      size: 9,
      previewable: false,
      reason: 'binary',
    })
    mockDelete.mockResolvedValue({
      root: '/r',
      path: 'README.md',
      trashId: 't',
    })
    await withTrash()
    fireEvent.click(item('README.md'))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await confirm()
    expect(mockHash).toHaveBeenCalled()
    expect(mockDelete.mock.calls[0][1].baseHash).toBe('hh')
  })

  it('a folder goes only once it is known to be empty', async () => {
    mockDelete.mockResolvedValue({ root: '/r', path: 'src/lib', trashId: 't' })
    const p = await withTrash()
    // Not read yet: read now, and it holds something
    await choose('src')
    expect(p.notify).toHaveBeenLastCalledWith('The folder is not empty')
    // Read: its menu says so
    fireEvent.click(item('src'))
    await act(async () => {})
    fireEvent.click(actions('src'))
    expect(
      screen.getByRole('menuitem', { name: 'Delete (not empty)' }),
    ).toBeDisabled()
    // An empty one, read already
    fireEvent.click(item('lib'))
    await act(async () => {})
    mockTree.mockClear()
    await choose('lib')
    expect(mockTree).not.toHaveBeenCalled()
    expect(screen.getByText('Delete folder?')).toBeInTheDocument()
    await confirm()
    expect(mockDelete.mock.calls[0][1]).toMatchObject({
      path: 'src/lib',
      kind: 'dir',
    })
    expect(p.notify).toHaveBeenLastCalledWith('Deleted lib', {
      action: { label: 'Undo', onClick: expect.any(Function) },
    })
  })

  it("says when a folder can't be read", async () => {
    const p = await withTrash()
    mockTree.mockRejectedValueOnce(new RequestError(403, '', 'x'))
    await choose('src')
    expect(p.notify).toHaveBeenLastCalledWith("This folder can't be read")
  })

  it('the Delete key opens the same box, never deleting at once', async () => {
    await withTrash()
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'End' })
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' })
    await act(async () => {})
    expect(screen.getByText('Delete file?')).toBeInTheDocument()
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('Cmd+Backspace opens it too; Backspace alone does nothing', async () => {
    await withTrash()
    const tree = screen.getByRole('tree')
    fireEvent.keyDown(tree, { key: 'End' })
    fireEvent.keyDown(tree, { key: 'Backspace' })
    await act(async () => {})
    expect(screen.queryByText('Delete file?')).toBeNull()
    fireEvent.keyDown(tree, { key: 'Backspace', metaKey: true })
    await act(async () => {})
    expect(screen.getByText('Delete file?')).toBeInTheDocument()
  })

  it('deletes the open file from its header, its unsaved changes too', async () => {
    mockContent.mockResolvedValue({
      root: '/home/kim/app',
      path: 'README.md',
      size: 2,
      text: 'hi',
      hash: 'shown',
      editable: true,
    })
    mockDelete.mockResolvedValue({
      root: '/home/kim/app',
      path: 'README.md',
      trashId: 't',
    })
    await withTrash()
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    // Not while editing: the draft is never lost unasked
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'changed' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await confirm()
    expect(mockHash).not.toHaveBeenCalled()
    expect(mockDelete.mock.calls[0][1].baseHash).toBe('shown')
    expect(screen.getByRole('tree')).toBeInTheDocument()
  })

  it('a file deleted from the tree while it has a draft drops the draft', async () => {
    mockDelete.mockResolvedValue({
      root: '/home/kim/app',
      path: 'README.md',
      trashId: 't',
    })
    const draft = renderHook(() =>
      useFileDraft('%1', '/home/kim/app', 'README.md'),
    )
    act(() =>
      draft.result.current[1]({
        root: '/home/kim/app',
        path: 'README.md',
        baseHash: 'h',
        base: 'a',
        crlf: false,
        text: 'b',
        reveal: false,
      }),
    )
    await withTrash()
    await choose('README.md')
    await confirm()
    expect(draft.result.current[0]).toBeUndefined()
  })

  it("a deleted file keeps another file's draft", async () => {
    mockDelete.mockResolvedValue({ root: '/r', path: 'src', trashId: 't' })
    const draft = renderHook(() =>
      useFileDraft('%1', '/home/kim/app', 'other.md'),
    )
    const other = {
      root: '/home/kim/app',
      path: 'other.md',
      baseHash: 'h',
      base: 'a',
      crlf: false,
      text: 'b',
      reveal: false,
    }
    act(() => draft.result.current[1](other))
    await withTrash()
    await choose('README.md')
    await confirm()
    expect(draft.result.current[0]).toEqual(other)
  })
})

describe('FilesView rename', () => {
  const ROOT = '/home/kim/app'
  beforeEach(() => {
    mockRename.mockReset()
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })
  const actions = (name: string) =>
    within(item(name)).getByRole('button', { name: `Actions for ${name}` })
  const ask = (name: string) => {
    fireEvent.click(actions(name))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
  }
  const send = async (to: string) => {
    const box = within(screen.getByRole('dialog', { name: 'Rename' }))
    fireEvent.change(box.getByRole('textbox'), { target: { value: to } })
    await act(async () => {
      fireEvent.click(box.getByRole('button', { name: 'Rename' }))
    })
  }
  const toast = (notify: ViewProps['notify']) => {
    const calls = vi.mocked(notify).mock.calls
    return calls[calls.length - 1]
  }

  it('renames from the tree, and Undo renames it back', async () => {
    mockRename
      .mockResolvedValueOnce({ root: ROOT, path: 'NOTES.md' })
      .mockResolvedValueOnce({ root: ROOT, path: 'README.md' })
    const p = await show()
    ask('README.md')
    await send('NOTES.md')
    expect(mockRename.mock.calls[0]).toEqual([
      { paneId: '%1' },
      { root: ROOT, path: 'README.md', newPath: 'NOTES.md', reveal: false },
    ])
    expect(toast(p.notify)[0]).toBe('Renamed README.md to NOTES.md')
    await act(async () => lastAction(p.notify).onClick())
    expect(mockRename.mock.calls[1][1]).toEqual({
      root: ROOT,
      path: 'NOTES.md',
      newPath: 'README.md',
      reveal: false,
    })
    expect(toast(p.notify)).toEqual([
      'Renamed back to README.md',
      { variant: 'success' },
    ])
  })

  it('a sensitive file from the tree is asked about, then renamed with reveal', async () => {
    mockRename
      .mockRejectedValueOnce(new RequestError(403, 'sensitive', 'x'))
      .mockResolvedValueOnce({ root: ROOT, path: 'src/.env' })
    const p = await show()
    ask('.env')
    await send('src/.env')
    expect(mockRename.mock.calls[0][1].reveal).toBe(false)
    await act(async () => {
      fireEvent.click(
        within(
          screen.getByRole('dialog', { name: 'Rename this file?' }),
        ).getByRole('button', { name: 'Rename' }),
      )
    })
    expect(mockRename.mock.calls[1][1].reveal).toBe(true)
    expect(toast(p.notify)[0]).toBe('Moved .env to src')
  })

  it('moves a file to the top folder', async () => {
    mockRename.mockResolvedValue({ root: ROOT, path: 'a.ts' })
    const p = await show()
    fireEvent.click(item('src'))
    await screen.findByRole('treeitem', { name: /^a\.ts/ })
    ask('a.ts')
    await send('a.ts')
    expect(toast(p.notify)[0]).toBe("Moved a.ts to the pane's directory")
  })

  it('renames the open file from its header; the tab follows', async () => {
    mockContent.mockResolvedValue({
      root: ROOT,
      path: 'README.md',
      size: 2,
      text: 'hi',
      hash: 'h',
      editable: true,
    })
    mockRename.mockResolvedValue({ root: ROOT, path: 'docs/README.md' })
    await show()
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    mockContent.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await send('docs/README.md')
    await waitFor(() =>
      expect(mockContent).toHaveBeenCalledWith(
        { paneId: '%1' },
        'docs/README.md',
        expect.anything(),
      ),
    )
  })

  it('a refused Undo says why', async () => {
    const p = await show()
    const undo = async (err: unknown) => {
      mockRename
        .mockResolvedValueOnce({ root: ROOT, path: 'B.md' })
        .mockRejectedValueOnce(err)
      ask('README.md')
      await send('B.md')
      await act(async () => lastAction(p.notify).onClick())
      return toast(p.notify)
    }
    const refused = (
      status: number,
      code: string,
      root?: string,
      path?: string,
    ) => new RequestError(status, code, 'x', { root, path })
    expect(
      (await undo(refused(409, 'exists', undefined, 'README.md')))[0],
    ).toBe('A file now exists at README.md; not renamed back')
    expect((await undo(refused(409, 'exists')))[0]).toBe(
      'A file now exists at README.md; not renamed back',
    )
    expect((await undo(refused(409, 'changed', undefined, 'C.md')))[0]).toBe(
      'The file changed while it was renamed; it is at C.md',
    )
    expect((await undo(new TypeError('offline')))[0]).toBe(
      'Could not undo the rename',
    )
    await undo(refused(409, '', '/other'))
    expect(p.notify).toHaveBeenCalledWith(
      "The pane's directory changed; README.md was not renamed back",
      { variant: 'warning' },
    )
  })

  it('Undo is not sent over unsaved changes at the old path', async () => {
    mockRename.mockResolvedValueOnce({ root: ROOT, path: 'B.md' })
    const p = await show()
    ask('README.md')
    await send('B.md')
    const draft = renderHook(() =>
      useFileDraft('%1', '/home/kim/app', 'README.md'),
    )
    act(() =>
      draft.result.current[1]({
        root: ROOT,
        path: 'README.md',
        baseHash: 'h',
        base: 'a',
        crlf: false,
        text: 'b',
        reveal: false,
      }),
    )
    await act(async () => lastAction(p.notify).onClick())
    expect(mockRename).toHaveBeenCalledTimes(1)
    expect(toast(p.notify)[0]).toBe(
      'README.md has unsaved changes; not renamed back',
    )
  })

  it('an old name the server would refuse has no Undo', async () => {
    mockTree.mockImplementation(async (_p: string, path: string) => ({
      root: ROOT,
      isRepo: true,
      path,
      entries: [e('notes.')],
      truncated: false,
    }))
    mockRename.mockResolvedValue({ root: ROOT, path: 'notes.md' })
    const p = await show()
    ask('notes.')
    await send('notes.md')
    expect(toast(p.notify)).toEqual([
      "Renamed notes. to notes.md. Undo isn't available for this name",
    ])
  })

  it('a name taken: Open it opens that file in a tab', async () => {
    mockRename.mockRejectedValue(
      new RequestError(409, 'exists', 'x', { path: 'src/a.ts' }),
    )
    mockContent.mockResolvedValue({
      root: ROOT,
      path: 'src/a.ts',
      size: 1,
      text: 'a',
      hash: 'h',
      editable: true,
    })
    await show()
    ask('README.md')
    await send('src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    await waitFor(() =>
      expect(mockContent).toHaveBeenCalledWith(
        { paneId: '%1' },
        'src/a.ts',
        expect.anything(),
      ),
    )
  })

  it('a file swapped while renamed: told where it is', async () => {
    mockRename.mockRejectedValue(
      new RequestError(409, 'changed', 'x', { path: 'X.md' }),
    )
    const p = await show()
    ask('README.md')
    await send('B.md')
    expect(toast(p.notify)).toEqual([
      'The file changed while it was renamed; it is at X.md',
      { variant: 'warning' },
    ])
  })

  it('the same path answered: nothing follows, nothing is said', async () => {
    mockRename.mockResolvedValue({ root: ROOT, path: 'README.md' })
    const p = await show()
    ask('README.md')
    await send('./README.md')
    expect(p.notify).not.toHaveBeenCalled()
  })

  it('renaming the file a search result opened reads the results again', async () => {
    mockFind.mockResolvedValue({
      root: ROOT,
      isRepo: true,
      results: [{ path: 'README.md', ignored: false, sensitive: false }],
      truncated: false,
      incomplete: false,
    })
    mockContent.mockResolvedValue({
      root: ROOT,
      path: 'README.md',
      size: 2,
      text: 'hi',
      hash: 'h',
      editable: true,
    })
    mockRename.mockResolvedValue({ root: ROOT, path: 'B.md' })
    await show()
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'read' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /README/ }))
    await screen.findByTestId('markdown-preview')
    const before = mockFind.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await send('B.md')
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    await waitFor(() =>
      expect(mockFind.mock.calls.length).toBeGreaterThan(before),
    )
  })

  it('never offered to a view-only client, nor on a link', async () => {
    await show({ readOnly: true })
    expect(
      within(item('README.md')).queryByRole('button', { name: /Actions/ }),
    ).toBeNull()
    // Nor does a finger resting on a row open anything
    vi.useFakeTimers()
    try {
      fireEvent.pointerDown(item('README.md'), { pointerType: 'touch' })
      act(() => vi.advanceTimersByTime(600))
    } finally {
      vi.useRealTimers()
    }
    expect(screen.queryByRole('menu')).toBeNull()
    cleanup()
    await show()
    expect(
      within(item('link')).queryByRole('button', { name: /Actions/ }),
    ).toBeNull()
  })

  it('a finger resting on a row opens its menu', async () => {
    await show()
    vi.useFakeTimers()
    try {
      fireEvent.pointerDown(item('README.md'), {
        pointerType: 'touch',
        clientX: 1,
        clientY: 1,
      })
      act(() => vi.advanceTimersByTime(600))
    } finally {
      vi.useRealTimers()
    }
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    // The click ending the press opens nothing
    fireEvent.click(item('README.md'))
    expect(screen.getByRole('tree')).toBeInTheDocument()
  })
})

describe('FilesView tabs', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    mockContent.mockImplementation(async (_p: string, path: string) =>
      path === '.env'
        ? { root: '/home/kim/app', path, sensitive: true }
        : {
            root: '/home/kim/app',
            path,
            size: 3,
            text:
              path === 'README.md'
                ? '[code](src/a.ts) [lib](src/lib/)'
                : `text of ${path}`,
            hash: `h:${path}`,
            editable: true,
          },
    )
  })

  const tabs = () =>
    within(screen.getByRole('tablist', { name: 'Open files' }))
      .getAllByRole('tab')
      .map((t) => t.textContent)
  const tab = (name: RegExp | string) => screen.getByRole('tab', { name })

  async function openA() {
    fireEvent.click(item('src'))
    await act(async () => {})
    fireEvent.click(item('a.ts'))
    await screen.findByTestId('code-block')
  }

  it('a single click opens the preview tab, a double click keeps it', async () => {
    await show()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    expect(tabs()).toEqual(['Files', 'README.md (preview)'])
    // The file shows in the panel the selected tab names
    expect(
      screen.getByRole('tabpanel', { name: /^README\.md/ }),
    ).toContainElement(screen.getByTestId('markdown-preview'))
    fireEvent.click(tab('Files'))
    await openA()
    // The preview tab now shows a.ts
    expect(tabs()).toEqual(['Files', 'a.ts (preview)'])
    // A double click: the second click lands on the viewer that took the
    // tree's place
    fireEvent.click(tab('Files'))
    fireEvent.click(item('a.ts'))
    fireEvent.doubleClick(await screen.findByTestId('code-block'))
    fireEvent.click(tab('Files'))
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    expect(tabs()).toEqual(['Files', 'a.ts', 'README.md (preview)'])
    fireEvent.click(tab('a.ts'))
    expect(await screen.findByTestId('code-block')).toHaveTextContent(
      'text of src/a.ts',
    )
    // Keep open pins README.md from its header
    fireEvent.click(tab(/^README\.md/))
    fireEvent.click(await screen.findByRole('button', { name: 'Keep open' }))
    expect(tabs()).toEqual(['Files', 'a.ts', 'README.md'])
  })

  it('a double click pins only right after the tree opened the file', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      await show()
      fireEvent.click(item('README.md'))
      await screen.findByTestId('markdown-preview')
      now.mockReturnValue(1000 + TREE_DOUBLE_CLICK_MS)
      fireEvent.doubleClick(screen.getByTestId('markdown-preview'))
      expect(tabs()).toEqual(['Files', 'README.md (preview)'])
      // Once only: a later double click selects text
      now.mockReturnValue(1000)
      fireEvent.doubleClick(screen.getByTestId('markdown-preview'))
      expect(tabs()).toEqual(['Files', 'README.md (preview)'])
      // A double click on the tree itself (a folder) pins nothing
      fireEvent.click(tab('Files'))
      fireEvent.doubleClick(item('src'))
      expect(tabs()).toEqual(['Files', 'README.md (preview)'])
    } finally {
      now.mockRestore()
    }
  })

  it('switching tabs brings back where each file was scrolled', async () => {
    await show()
    await openA()
    const code = screen.getByTestId('code-block')
    code.scrollTop = 90
    fireEvent.scroll(code)
    fireEvent.doubleClick(tab(/^a\.ts/))
    fireEvent.click(tab('Files'))
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    fireEvent.click(tab('a.ts'))
    expect((await screen.findByTestId('code-block')).scrollTop).toBe(90)
  })

  it('switching tabs brings back a table as it was left: widths, wraps, first row', async () => {
    const csv = `n,note\n${Array.from({ length: 2000 }, (_, i) => `${i},x`).join('\n')}\n`
    mockTree.mockImplementation(async (_p: string, path: string) => ({
      root: '/home/kim/app',
      isRepo: true,
      path,
      entries: path === 'src' ? [...DIRS.src, e('data.csv')] : DIRS[path],
      truncated: false,
    }))
    const text = mockContent.getMockImplementation()
    mockContent.mockImplementation(async (p: string, path: string) =>
      path === 'src/data.csv'
        ? {
            root: '/home/kim/app',
            path,
            size: csv.length,
            text: csv,
            hash: 'h',
          }
        : text?.(p, path),
    )
    await show()
    fireEvent.click(item('src'))
    await act(async () => {})
    fireEvent.click(item('data.csv'))
    const grid = await screen.findByRole('grid')
    fireEvent.doubleClick(tab(/^data\.csv/))
    fireEvent.keyDown(
      screen.getByRole('separator', { name: 'Resize column note' }),
      { key: 'End' },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Wrap' })).getByRole(
        'menuitemcheckbox',
        { name: '2 · note' },
      ),
    )
    grid.scrollTop = 61 * 500
    fireEvent.scroll(grid)
    fireEvent.click(tab('Files'))
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    fireEvent.click(tab('data.csv'))
    const again = await screen.findByRole('grid')
    expect(again).not.toBe(grid)
    expect(again.scrollTop).toBe(61 * 500)
    const rows = within(again).getAllByRole('row')
    expect(rows[0].style.gridTemplateColumns).toContain('var(--w-1, 120ch)')
    expect(rows[1]).toHaveStyle({ height: '61px' })
  })

  it('a tab with unsaved changes closes only after Discard', async () => {
    await show()
    await openA()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Text of src/a.ts' }),
      {
        target: { value: 'changed' },
      },
    )
    // Editing pinned it; the dot says it has changes
    expect(tabs()).toEqual(['Files', 'a.ts (unsaved changes)'])
    fireEvent.click(screen.getByLabelText('Close a.ts'))
    const ask = screen.getByRole('dialog', { name: 'Discard changes?' })
    expect(ask).toHaveTextContent('Your changes to a.ts will be lost.')
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(tabs()).toHaveLength(2)
    // The tree, then the tab again: the draft is still there
    fireEvent.click(tab('Files'))
    fireEvent.click(tab(/^a\.ts/))
    expect(
      screen.getByRole('textbox', { name: 'Text of src/a.ts' }),
    ).toHaveValue('changed')
    fireEvent.keyDown(tab(/^a\.ts/), { key: 'Delete' })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('tree')).toBeInTheDocument()
    const draft = renderHook(() =>
      useFileDraft('%1', '/home/kim/app', 'src/a.ts'),
    )
    expect(draft.result.current[0]).toBeUndefined()
  })

  it('a clean tab closes at once', async () => {
    await show()
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    fireEvent.click(screen.getByLabelText('Close README.md'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('tree')).toBeInTheDocument()
  })

  it('Ctrl+click on a link opens it in a new tab', async () => {
    await show()
    fireEvent.click(item('README.md'))
    fireEvent.click(await screen.findByRole('button', { name: 'code' }), {
      ctrlKey: true,
    })
    expect(await screen.findByTestId('code-block')).toHaveTextContent(
      'text of src/a.ts',
    )
    expect(tabs()).toEqual(['Files', 'README.md (preview)', 'a.ts'])
  })

  it('declining a sensitive file closes its tab', async () => {
    await show()
    fireEvent.click(item('.env'))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('tree')).toBeInTheDocument()
  })

  it('a file gone from the host is struck through in the tab bar', async () => {
    mockContent.mockRejectedValue(new RequestError(404, '', 'x'))
    await show()
    fireEvent.click(item('README.md'))
    const gone = await screen.findByRole('tab', { name: /\(not found\)$/ })
    expect(gone.getAttribute('title')).toMatch(/README\.md — File not found$/)
    expect(gone.querySelector('.line-through')).toHaveTextContent('README.md')
  })

  it('a file gone from the host keeps its tab until closed', async () => {
    mockContent.mockRejectedValue(new RequestError(404, '', 'x'))
    await show()
    fireEvent.click(item('README.md'))
    fireEvent.click(await screen.findByRole('button', { name: 'Close tab' }))
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  async function moveRoot() {
    mockTree.mockRejectedValueOnce(
      new RequestError(409, '', 'root changed', { root: '/n' }),
    )
    mockTree.mockImplementation(async (_p: string, path: string) => ({
      root: '/n',
      isRepo: true,
      path,
      entries: DIRS[path],
      truncated: false,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await act(async () => {})
  }

  it.each([
    ['Keep', 1],
    ['Discard and close', 0],
  ])(
    'a moved root asks about tabs with unsaved changes: %s',
    async (choice, left) => {
      await show()
      fireEvent.click(item('README.md'))
      await screen.findByTestId('markdown-preview')
      fireEvent.click(tab('Files'))
      await openA()
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      fireEvent.change(
        screen.getByRole('textbox', { name: 'Text of src/a.ts' }),
        {
          target: { value: 'changed' },
        },
      )
      fireEvent.click(tab('Files'))
      await moveRoot()
      const ask = screen.getByRole('dialog', {
        name: 'Close a file with unsaved changes?',
      })
      fireEvent.click(within(ask).getByRole('button', { name: choice }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryAllByRole('tab', { name: /^a\.ts/ })).toHaveLength(
        left,
      )
      expect(screen.queryByRole('tab', { name: /^README/ })).toBeNull()
    },
  )

  it('a phone lists the open files in a sheet instead of a tab bar', async () => {
    await show({ isMobile: true })
    expect(screen.queryByRole('button', { name: /^Open files/ })).toBeNull()
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    expect(screen.queryByRole('tablist')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    // On the tree too, while a file is open
    fireEvent.click(screen.getByRole('button', { name: 'Open files (1)' }))
    const sheet = screen.getByRole('dialog', { name: 'Open files' })
    fireEvent.click(within(sheet).getByRole('button', { name: /^README\.md/ }))
    expect(await screen.findByTestId('markdown-preview')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open files (1)' }))
    // Closing the file shown keeps the sheet open
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Open files' })).getByRole(
        'button',
        { name: 'Close README.md' },
      ),
    )
    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(
      screen.getByRole('dialog', { name: 'Open files' }),
    ).toBeInTheDocument()
  })
})

describe('FilesView download', () => {
  const ROOT = '/home/kim/app'
  const trashCaps = {
    backend: 'tmux',
    caps: { clientSideSelect: false, copyMode: true, files: true, trash: true },
  }
  beforeEach(() => {
    mockDownload.mockReset()
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })
  const actions = (name: string) =>
    within(item(name)).getByRole('button', { name: `Actions for ${name}` })

  it('is offered first on a file row, never on a folder or a link', async () => {
    await show({ mux: trashCaps })
    fireEvent.click(actions('README.md'))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Download',
      'Rename',
      'Delete',
    ])
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    })
    for (const name of ['src', 'link']) {
      fireEvent.click(actions(name))
      expect(screen.queryByRole('menuitem', { name: 'Download' })).toBeNull()
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'Escape',
      })
    }
  })

  it('is not offered to a view-only client', async () => {
    await show({ readOnly: true })
    expect(
      within(item('README.md')).queryByRole('button', { name: /Actions/ }),
    ).toBeNull()
  })

  it('downloads a file of the tree', async () => {
    const p = await show()
    fireEvent.click(actions('README.md'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }))
    expect(mockDownload).toHaveBeenCalledWith(
      { paneId: '%1', root: ROOT, path: 'README.md', reveal: false },
      p.notify,
      expect.any(Function),
      expect.any(Function),
    )
  })

  it('asks before a sensitive file, then downloads it revealed', async () => {
    await show()
    fireEvent.click(actions('.env'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }))
    const box = () =>
      within(
        screen.getByRole('dialog', {
          name: 'Download a file that may contain secrets?',
        }),
      )
    fireEvent.click(box().getByRole('button', { name: 'Cancel' }))
    expect(mockDownload).not.toHaveBeenCalled()
    fireEvent.click(actions('.env'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }))
    fireEvent.click(box().getByRole('button', { name: 'Download' }))
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(mockDownload.mock.calls[0][0]).toEqual({
      paneId: '%1',
      root: ROOT,
      path: '.env',
      reveal: true,
    })
  })

  it('is not offered in the header of a file opened through a link', async () => {
    mockContent.mockResolvedValue({
      root: ROOT,
      path: 'link/x',
      size: 1,
      text: 'x',
      hash: 'h',
      editable: false,
    })
    await show()
    fireEvent.click(item('link'))
    fireEvent.click(await screen.findByRole('treeitem', { name: /^x/ }))
    await screen.findByTestId('code-block')
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
  })

  it('downloads the open file from its header', async () => {
    mockContent.mockResolvedValue({
      root: ROOT,
      path: 'README.md',
      size: 2,
      text: 'hi',
      hash: 'h',
      editable: true,
    })
    await show()
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(mockDownload.mock.calls[0][0]).toEqual({
      paneId: '%1',
      root: ROOT,
      path: 'README.md',
      reveal: false,
    })
  })
})

describe('FilesView review comments', () => {
  const ROOT = '/home/kim/app'
  const review = (over: Partial<ReviewComment> = {}): ReviewComment => ({
    id: 'c',
    root: ROOT,
    path: 'README.md',
    source: 'file',
    start: 2,
    end: 2,
    text: 'Why?',
    at: 1,
    ...over,
  })
  beforeEach(() => {
    // The Markdown file as its source, with its line numbers
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ markdownPreview: false }),
    )
    mockContent.mockResolvedValue({
      root: ROOT,
      path: 'README.md',
      size: 4,
      text: 'a\nb\n',
    })
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })
  afterEach(() => {
    sessionStorage.clear()
    resetReviewDrafts()
  })

  const openReview = () =>
    fireEvent.click(screen.getByRole('button', { name: /^Review, / }))

  it('comments on lines of a file, and opens the comment again at its line', async () => {
    await show()
    fireEvent.click(item('README.md'))
    fireEvent.click(await screen.findByRole('button', { name: 'Line 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), {
      target: { value: 'Why?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(loadReview('%1')).toMatchObject([
      { root: ROOT, path: 'README.md', source: 'file', start: 2, quote: 'b' },
    ])
    expect(screen.getByRole('button', { name: 'Line 2' })).toHaveAttribute(
      'data-commented',
    )
    openReview()
    fireEvent.click(screen.getByRole('button', { name: /^line 2/ }))
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: 'center',
      }),
    )
  })

  it('opens a comment on a diff in Changes', async () => {
    addReviewComment('%1', review({ source: 'unstaged' }))
    const p = await show()
    openReview()
    fireEvent.click(screen.getByRole('button', { name: /^line 2/ }))
    expect(p.showView).toHaveBeenCalledWith(CHANGES_VIEW_ID)
  })

  it('tells when a comment is under another folder', async () => {
    addReviewComment('%1', review({ root: '/other' }))
    const p = await show()
    openReview()
    fireEvent.click(screen.getByRole('button', { name: /^line 2/ }))
    expect(p.notify).toHaveBeenCalledWith('The pane is in another folder now', {
      variant: 'warning',
    })
  })

  it('offers no comment to a view-only client', async () => {
    addReviewComment('%1', review())
    await show({ readOnly: true })
    fireEvent.click(item('README.md'))
    await screen.findByTestId('code-block')
    expect(screen.queryByRole('button', { name: 'Line 1' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Review/ })).toBeNull()
  })
})

describe('FilesView upload', () => {
  const ROOT = '/home/kim/app'
  const pdf = (name = 'a.pdf') =>
    new File([new Uint8Array(3)], name, { type: 'application/pdf' })
  // The path an upload of name into dir gets
  const at = (dir: string, name: string) =>
    dir === '.' ? name : `${dir}/${name}`
  beforeEach(() => {
    resetFileUploads()
    mockCheckUpload.mockReset()
    mockUploadFile.mockReset()
    mockCheckUpload.mockImplementation(async (_t, a) => ({
      ok: true,
      path: at(a.dir, a.name),
    }))
    mockUploadFile.mockImplementation(async (_t, a, _f, cb) => {
      cb.onSent?.()
      return { ok: true, path: at(a.dir, a.name) }
    })
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })
  // The dir each upload was checked for
  const dirs = () => mockCheckUpload.mock.calls.map((c) => c[1].dir)
  const pick = async (...files: File[]) => {
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Upload files' }))
    expect(click).toHaveBeenCalled()
    await act(async () => {
      fireEvent.change(input, { target: { files } })
    })
  }
  const files = (list: File[], types = ['Files']) => ({
    dataTransfer: { types, files: list, items: [], dropEffect: '' },
  })
  const drop = async (el: Element, list: File[] = [pdf()]) => {
    let kept = true
    await act(async () => {
      kept = fireEvent.drop(el, files(list))
    })
    return kept
  }
  const status = () => screen.getByTestId('upload-status')

  it('the button uploads into the focused folder, the root when none is', async () => {
    const p = await show()
    await pick(pdf())
    fireEvent.click(item('src'))
    await act(async () => {})
    await pick(pdf('b.pdf'))
    // A file focused (by the keys: a click would open it): its folder
    fireEvent.keyDown(item('src'), { key: 'ArrowDown' })
    fireEvent.keyDown(item('lib'), { key: 'ArrowDown' })
    expect(item('a.ts')).toHaveFocus()
    await pick(pdf('c.pdf'))
    expect(dirs()).toEqual(['.', 'src', 'src'])
    expect(mockCheckUpload.mock.calls[0][1]).toEqual({
      root: ROOT,
      dir: '.',
      name: 'a.pdf',
      reveal: false,
    })
    expect(mockCheckUpload.mock.calls[0][0]).toEqual({ paneId: '%1' })
    expect(p.notify).toHaveBeenCalledWith('Uploaded a.pdf', {
      variant: 'success',
    })
  })

  it('a link to a folder, and a folder through one, are not taken: the nearest folder above is', async () => {
    mockTree.mockImplementation(async (_p: string, path: string) => ({
      root: ROOT,
      isRepo: true,
      path,
      entries: path === 'link' ? [e('in', { type: 'dir' })] : DIRS[path],
    }))
    await show()
    fireEvent.click(item('link'))
    await act(async () => {})
    await pick(pdf())
    fireEvent.click(item('in'))
    await act(async () => {})
    await pick(pdf('b.pdf'))
    await drop(item('in'))
    expect(dirs()).toEqual(['.', '.', '.'])
  })

  it('focuses the row of the file it saved, from inside Files only', async () => {
    let saved: string[] = []
    mockTree.mockImplementation(async (_p: string, path: string) => ({
      root: ROOT,
      isRepo: true,
      path,
      entries:
        path === '' ? [...DIRS[''], ...saved.map((n) => e(n))] : DIRS[path],
    }))
    mockUploadFile.mockImplementation(async (_t, a) => {
      saved = [...saved, a.name]
      return { ok: true, path: a.name }
    })
    await show()
    await pick(pdf('new.pdf'))
    expect(item('new.pdf')).toHaveFocus()
    expect(item('new.pdf')).toHaveAttribute('tabindex', '0')
    // The keyboard elsewhere (the terminal): it stays there
    const outside = document.createElement('textarea')
    document.body.append(outside)
    outside.focus()
    await pick(pdf('next.pdf'))
    expect(outside).toHaveFocus()
    expect(item('next.pdf')).toHaveAttribute('tabindex', '0')
    outside.remove()
  })

  it('a file saved for another root is not focused', async () => {
    await show()
    await act(async () => {
      startUploads(
        [pdf('far.pdf')],
        { target: { paneId: '%1' }, root: '/elsewhere', dir: '.' },
        { notify: vi.fn(), t: tFor('en') },
      )
    })
    expect(item('src')).toHaveAttribute('tabindex', '0')
  })

  it('the answer lost after every byte went: the folder read again shows it saved', async () => {
    mockTree.mockImplementation(async (_p: string, path: string) => ({
      root: ROOT,
      isRepo: true,
      path,
      entries:
        path === 'src' ? [...DIRS.src, e('a.pdf', { size: 3 })] : DIRS[path],
    }))
    mockUploadFile.mockImplementation(async (_t, _a, _f, cb) => {
      cb.onSent?.()
      return { ok: false, reason: 'network' }
    })
    const p = await show()
    fireEvent.click(item('src'))
    await act(async () => {})
    await pick(pdf())
    expect(p.notify).toHaveBeenCalledWith('Uploaded a.pdf', {
      variant: 'success',
    })
  })

  it('shows the progress of several files, and Cancel stops them', async () => {
    let abortSeen = false
    mockUploadFile.mockImplementation(
      (_t, _a, _f, cb) =>
        new Promise((resolve) => {
          cb.onProgress?.(0.5)
          cb.signal.addEventListener('abort', () => {
            abortSeen = true
            resolve({ ok: false, reason: 'aborted' })
          })
        }),
    )
    const p = await show()
    expect(status()).toHaveTextContent('')
    await pick(pdf('a.pdf'), pdf('b.pdf'))
    expect(status()).toHaveTextContent('Uploading a.pdf (1 of 2)')
    expect(status()).toHaveTextContent('50 %')
    await act(async () => {
      fireEvent.click(within(status()).getByRole('button', { name: 'Cancel' }))
    })
    expect(abortSeen).toBe(true)
    expect(p.notify).toHaveBeenCalledWith('Upload canceled.', undefined)
    expect(status()).toHaveTextContent('')
    expect(mockUploadFile).toHaveBeenCalledTimes(1)
  })

  it('says when another upload holds the slot', async () => {
    mockCheckUpload.mockResolvedValue({ ok: false, reason: 'upload_busy' })
    await show()
    await pick(pdf())
    expect(status()).toHaveTextContent('Waiting for another upload…')
    expect(status()).not.toHaveTextContent('%')
  })

  it('goes on when Files closes, and shows where it is when it opens again', async () => {
    let finish!: () => void
    mockUploadFile.mockImplementation(
      (_t, a) =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, path: a.name })
        }),
    )
    const p = await show()
    await pick(pdf())
    cleanup()
    await show()
    expect(status()).toHaveTextContent('Uploading a.pdf')
    await act(async () => finish())
    expect(p.notify).toHaveBeenCalledWith('Uploaded a.pdf', {
      variant: 'success',
    })
  })

  it('asks before a folder that may hold secrets, naming the file, then sends reveal', async () => {
    mockCheckUpload.mockImplementation(async (_t, a) =>
      a.reveal
        ? { ok: true, path: at(a.dir, a.name) }
        : { ok: false, reason: 'sensitive' },
    )
    await show()
    await pick(pdf())
    const box = screen.getByRole('dialog', {
      name: 'Upload where secrets may be?',
    })
    expect(box).toHaveTextContent(
      'a.pdf goes to the top folder of /home/kim/app,',
    )
    await act(async () => {
      fireEvent.click(within(box).getByRole('button', { name: 'Upload' }))
    })
    expect(mockUploadFile.mock.calls[0][1].reveal).toBe(true)
    // Said no: nothing sent
    fireEvent.click(item('src'))
    await act(async () => {})
    await pick(pdf('b.pdf'))
    const again = screen.getByRole('dialog', {
      name: 'Upload where secrets may be?',
    })
    expect(again).toHaveTextContent('b.pdf goes to src of /home/kim/app,')
    await act(async () => {
      fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }))
    })
    expect(mockUploadFile).toHaveBeenCalledTimes(1)
  })

  it('no Upload button for a view-only client, nor while a file is open', async () => {
    await show({ readOnly: true })
    expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull()
    cleanup()
    mockContent.mockResolvedValue({
      root: ROOT,
      path: 'README.md',
      size: 2,
      text: 'hi',
    })
    await show()
    expect(
      screen.getByRole('button', { name: 'Upload files' }),
    ).toBeInTheDocument()
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull()
  })

  it('a drop goes into the folder under the pointer, a file’s or a link’s parent', async () => {
    await show()
    fireEvent.click(item('src'))
    await act(async () => {})
    fireEvent.click(item('lib'))
    await act(async () => {})
    expect(await drop(item('src'))).toBe(false)
    await drop(item('a.ts'))
    await drop(item('README.md'))
    await drop(item('link'))
    await drop(item('lib'))
    // The note of an empty folder: that folder
    await drop(screen.getByText('Empty'))
    // Empty space under the rows, and the header: the root
    await drop(screen.getByRole('tree'))
    await drop(screen.getByTestId('pane-root'))
    expect(dirs()).toEqual([
      'src',
      'src',
      '.',
      '.',
      'src/lib',
      'src/lib',
      '.',
      '.',
    ])
  })

  it('highlights the folder files are dragged over (a file’s), never a link', async () => {
    await show()
    const over = (el: Element) => fireEvent.dragOver(el, files([pdf()]))
    expect(over(item('src'))).toBe(false)
    expect(item('src').className).toContain('bg-accent/10')
    over(item('link'))
    expect(item('src').className).not.toContain('bg-accent/10')
    expect(item('link').className).not.toContain('bg-accent/10')
    over(item('src'))
    // Leaving for a row inside keeps it; leaving the view clears it (jsdom
    // drops relatedTarget from a drag event's init)
    const leave = (to: Element | null) => {
      const ev = createEvent.dragLeave(item('src'))
      Object.defineProperty(ev, 'relatedTarget', { value: to })
      fireEvent(item('src'), ev)
    }
    leave(item('README.md'))
    expect(item('src').className).toContain('bg-accent/10')
    leave(null)
    expect(item('src').className).not.toContain('bg-accent/10')
  })

  it('a drag without files is left alone', async () => {
    await show()
    expect(fireEvent.dragOver(item('src'), files([], ['text/plain']))).toBe(
      true,
    )
    expect(fireEvent.dragOver(item('src'))).toBe(true)
    expect(await drop(item('src'), [])).toBe(false)
    let kept = false
    await act(async () => {
      kept = fireEvent.drop(item('src'), files([pdf()], ['text/plain']))
    })
    expect(kept).toBe(true)
    expect(mockCheckUpload).not.toHaveBeenCalled()
  })

  it('folders dropped are skipped and said with the result', async () => {
    const p = await show()
    await drop(item('src'), [pdf(), new File([], 'photos')])
    expect(p.notify).toHaveBeenCalledWith(
      "Uploaded a.pdf. Folders can't be uploaded.",
      { variant: 'success' },
    )
    await drop(item('src'), [new File([], 'photos')])
    expect(p.notify).toHaveBeenLastCalledWith("Folders can't be uploaded", {
      variant: 'warning',
    })
    expect(mockCheckUpload).toHaveBeenCalledTimes(1)
  })

  it('a drop on an empty root goes to the root', async () => {
    mockTree.mockImplementation(async (_p: string, path: string) => ({
      root: ROOT,
      isRepo: true,
      path,
      entries: [],
    }))
    await show()
    await drop(screen.getByText('This directory is empty'))
    expect(dirs()).toEqual(['.'])
  })

  it('with a file open, a drop goes into its folder and names it; the editor never gets it', async () => {
    mockContent.mockResolvedValue({
      root: ROOT,
      path: 'src/a.ts',
      size: 3,
      text: 'x = 1',
    })
    const p = await show()
    fireEvent.click(item('src'))
    await act(async () => {})
    fireEvent.click(item('a.ts'))
    const code = await screen.findByText('x = 1')
    const editorDrop = vi.fn()
    code.addEventListener('drop', editorDrop)
    code.addEventListener('dragover', editorDrop)
    // No highlight while the tree is hidden
    fireEvent.dragOver(code, files([pdf()]))
    await drop(code)
    expect(editorDrop).not.toHaveBeenCalled()
    expect(dirs()).toEqual(['src'])
    expect(p.notify).toHaveBeenCalledWith('Saved to src/a.pdf', {
      variant: 'success',
    })
  })

  it('a tab kept from a root the pane has left takes no drop', async () => {
    mockContent.mockResolvedValue({
      root: ROOT,
      path: 'README.md',
      size: 2,
      text: 'hi',
      hash: 'h',
      editable: true,
    })
    const p = await show()
    fireEvent.click(item('README.md'))
    await screen.findByTestId('markdown-preview')
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    })
    const box = await screen.findByRole('textbox')
    fireEvent.input(box, { target: { textContent: 'changed' } })
    // The pane moved; the edited tab stays, of the old root
    mockTree.mockImplementation(async (_p: string, path: string) => ({
      root: '/home/kim/other',
      isRepo: true,
      path,
      entries: DIRS[path],
    }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    })
    await drop(screen.getByTestId('pane-root'))
    expect(mockCheckUpload).not.toHaveBeenCalled()
    expect(p.notify).toHaveBeenCalledWith(
      "This file's folder isn't the pane's any more: not uploaded",
      { variant: 'warning' },
    )
  })

  it('a drop on a dialog over Files uploads nothing', async () => {
    mockCheckUpload.mockResolvedValue({ ok: false, reason: 'sensitive' })
    await show()
    await pick(pdf())
    const box = screen.getByRole('dialog', {
      name: 'Upload where secrets may be?',
    })
    mockCheckUpload.mockClear()
    expect(await drop(box)).toBe(false)
    expect(mockCheckUpload).not.toHaveBeenCalled()
  })

  it('the button goes to the root once the focused row is gone', async () => {
    let gone = false
    mockTree.mockImplementation(async (_p: string, path: string) => ({
      root: ROOT,
      isRepo: true,
      path,
      entries:
        gone && path === ''
          ? DIRS[''].filter((x) => x.name !== 'src')
          : DIRS[path],
    }))
    await show()
    fireEvent.click(item('src'))
    await act(async () => {})
    gone = true
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    })
    await pick(pdf())
    expect(dirs()).toEqual(['.'])
  })

  it('with a root file open, a drop goes into the root', async () => {
    mockContent.mockResolvedValue({
      root: ROOT,
      path: 'README.md',
      size: 2,
      text: 'hi',
    })
    await show()
    fireEvent.click(item('README.md'))
    await drop(await screen.findByTestId('markdown-preview'))
    expect(dirs()).toEqual(['.'])
  })

  it('a view-only client is told, and the browser never opens the file', async () => {
    const p = await show({ readOnly: true })
    const ev = createEvent.dragOver(item('src'), files([pdf()]))
    fireEvent(item('src'), ev)
    expect(ev.defaultPrevented).toBe(true)
    // 'none' would keep the drop from firing at all
    expect((ev as DragEvent).dataTransfer?.dropEffect).toBe('copy')
    expect(item('src').className).not.toContain('bg-accent/10')
    expect(await drop(item('src'))).toBe(false)
    expect(p.notify).toHaveBeenCalledWith('A view-only device cannot upload', {
      variant: 'warning',
    })
    expect(mockCheckUpload).not.toHaveBeenCalled()
  })

  it('a drop before the root is known sends nothing', async () => {
    mockTree.mockRejectedValue(new RequestError(404, 'not_found', 'gone'))
    await show()
    expect(await drop(screen.getByText('Directory not found'))).toBe(false)
    expect(mockCheckUpload).not.toHaveBeenCalled()
  })

  it('pasting files in the tree uploads them to the focused folder', async () => {
    await show()
    fireEvent.click(item('src'))
    await act(async () => {})
    let kept = true
    await act(async () => {
      kept = fireEvent.paste(item('src'), { clipboardData: { files: [pdf()] } })
    })
    expect(kept).toBe(false)
    expect(dirs()).toEqual(['src'])
  })

  it('a paste into a text box, or with no files, keeps its default', async () => {
    await show()
    const box = screen.getByRole('searchbox', { name: 'Find a file' })
    expect(fireEvent.paste(box, { clipboardData: { files: [pdf()] } })).toBe(
      true,
    )
    expect(fireEvent.paste(item('src'), { clipboardData: { files: [] } })).toBe(
      true,
    )
    expect(mockCheckUpload).not.toHaveBeenCalled()
  })

  it('a paste with a file open, or on a view-only client, uploads nothing', async () => {
    await show({ readOnly: true })
    expect(
      fireEvent.paste(item('src'), { clipboardData: { files: [pdf()] } }),
    ).toBe(true)
    cleanup()
    mockContent.mockResolvedValue({
      root: ROOT,
      path: 'README.md',
      size: 2,
      text: 'hi',
    })
    await show()
    fireEvent.click(item('README.md'))
    const preview = await screen.findByTestId('markdown-preview')
    expect(
      fireEvent.paste(preview, { clipboardData: { files: [pdf()] } }),
    ).toBe(true)
    expect(mockCheckUpload).not.toHaveBeenCalled()
  })
})
