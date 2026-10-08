import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { ThemeProvider } from '../contexts/theme-context'
import { resetFilesStores, useFileDraft } from '../hooks/use-files'
import { type FileEntry, RequestError } from '../hooks/use-mux-api'
import { FilesView, TREE_DOUBLE_CLICK_MS } from './files-view'

const mockTree = vi.fn()
const mockContent = vi.fn()
const mockCreate = vi.fn()
const mockFind = vi.fn()
const mockHash = vi.fn()
const mockDelete = vi.fn()
const mockRestore = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFilesTree: (...a: unknown[]) => mockTree(...a),
  fetchFileContent: (...a: unknown[]) => mockContent(...a),
  createFile: (...a: unknown[]) => mockCreate(...a),
  findFiles: (...a: unknown[]) => mockFind(...a),
  fetchFileHash: (...a: unknown[]) => mockHash(...a),
  deleteFile: (...a: unknown[]) => mockDelete(...a),
  restoreFile: (...a: unknown[]) => mockRestore(...a),
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
    // Mobile wraps at first
    expect(screen.getByRole('button', { name: 'Wrap lines' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
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
      new RequestError(
        409,
        '',
        'root changed',
        undefined,
        undefined,
        '/home/kim/other',
      ),
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
    expect(mockContent).toHaveBeenLastCalledWith('%1', '.env', {
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
      new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
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
        expect(mockCreate).toHaveBeenCalledWith('%1', {
          root: '/home/kim/app',
          path: 'src/new.md',
          reveal: false,
        })
        expect(
          await screen.findByRole('textbox', { name: 'Text of src/new.md' }),
        ).toHaveValue('')
        expect(mockContent).toHaveBeenLastCalledWith('%1', 'src/new.md', {
          root: '/home/kim/app',
          reveal: false,
        })
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
      expect(mockContent).toHaveBeenCalledWith('%1', '.env.local', {
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
      '%1',
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
        '%1',
        expect.objectContaining({ fresh: true }),
        expect.any(AbortSignal),
      ),
    )
    // Cleared: the tree as it was, src opened down to the file
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(item('src')).toHaveAttribute('aria-expanded', 'true')
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
    mockHash.mockResolvedValue({ root: '/r', path: 'x', size: 1, hash: 'hh' })
  })

  it('is offered only with a trash and to a client that may write', async () => {
    const { unmount } = await show()
    expect(
      within(item('README.md')).queryByRole('button', { name: /Actions/ }),
    ).toBeNull()
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
    expect(mockRestore).toHaveBeenCalledWith('%1', {
      root: '/home/kim/app',
      trashId: 't1',
      reveal: false,
    })
    expect(p.notify).toHaveBeenLastCalledWith('Restored README.md', {
      variant: 'success',
    })
  })

  it('Undo says why it could not restore', async () => {
    mockDelete.mockResolvedValue({ root: '/r', path: '.env', trashId: 't' })
    mockRestore
      .mockRejectedValueOnce(
        new RequestError(
          409,
          'exists',
          'x',
          undefined,
          undefined,
          undefined,
          undefined,
          'n/.env',
        ),
      )
      .mockRejectedValueOnce(new RequestError(409, 'exists', 'x'))
      .mockRejectedValueOnce(
        new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
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
      new RequestError(
        409,
        'changed',
        'x',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'sw',
      ),
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
    const draft = renderHook(() => useFileDraft('%1', 'README.md'))
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
    const draft = renderHook(() => useFileDraft('%1', 'other.md'))
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
    const draft = renderHook(() => useFileDraft('%1', 'src/a.ts'))
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

  it('a file gone from the host keeps its tab until closed', async () => {
    mockContent.mockRejectedValue(new RequestError(404, '', 'x'))
    await show()
    fireEvent.click(item('README.md'))
    fireEvent.click(await screen.findByRole('button', { name: 'Close tab' }))
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  async function moveRoot() {
    mockTree.mockRejectedValueOnce(
      new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
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
