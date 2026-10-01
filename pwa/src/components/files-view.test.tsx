import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { ThemeProvider } from '../contexts/theme-context'
import { resetFilesStores } from '../hooks/use-files'
import { type FileEntry, RequestError } from '../hooks/use-mux-api'
import { FilesView } from './files-view'

const mockTree = vi.fn()
const mockContent = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFilesTree: (...a: unknown[]) => mockTree(...a),
  fetchFileContent: (...a: unknown[]) => mockContent(...a),
}))
vi.mock('../utils/highlight', () => ({ highlight: async () => null }))

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

beforeEach(() => {
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
    expect(await screen.findByTestId('code-block')).toBeInTheDocument()
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
    expect(await screen.findByTestId('code-block')).toBeInTheDocument()
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
})
