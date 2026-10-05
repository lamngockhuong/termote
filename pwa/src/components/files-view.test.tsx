import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { ThemeProvider } from '../contexts/theme-context'
import { resetFilesStores } from '../hooks/use-files'
import { type FileEntry, RequestError } from '../hooks/use-mux-api'
import { FilesView } from './files-view'

const mockTree = vi.fn()
const mockContent = vi.fn()
const mockCreate = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFilesTree: (...a: unknown[]) => mockTree(...a),
  fetchFileContent: (...a: unknown[]) => mockContent(...a),
  createFile: (...a: unknown[]) => mockCreate(...a),
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
