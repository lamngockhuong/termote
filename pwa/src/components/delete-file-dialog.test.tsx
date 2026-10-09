import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import { DeleteFileDialog } from './delete-file-dialog'

const mockHash = vi.fn()
const mockDelete = vi.fn()
vi.mock('../hooks/use-media-query', () => ({ useIsMobile: () => false }))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFileHash: (...a: unknown[]) => mockHash(...a),
  deleteFile: (...a: unknown[]) => mockDelete(...a),
}))

const refused = (status: number, code: string, extra: object = {}) =>
  Object.assign(new RequestError(status, code, code), extra)

function show(over: Partial<Parameters<typeof DeleteFileDialog>[0]> = {}) {
  const p = {
    paneId: '%1',
    root: '/home/kim/app',
    path: 'src/a.ts',
    kind: 'file' as const,
    sensitive: false,
    onClose: vi.fn(),
    onDeleted: vi.fn(),
    onRootChanged: vi.fn(),
    onRefresh: vi.fn(),
    ...over,
  }
  const view = render(<DeleteFileDialog {...p} />)
  return { ...p, ...view }
}

const del = () => screen.getByRole('button', { name: 'Delete' })

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
  mockHash.mockReset()
  mockDelete.mockReset()
  mockHash.mockResolvedValue({ root: '/r', path: 'x', size: 3, hash: 'h1' })
})

describe('DeleteFileDialog', () => {
  it('shows the full path, reads the hash, and Cancel has the focus', async () => {
    const p = show()
    expect(screen.getByText('Delete file?')).toBeInTheDocument()
    expect(screen.getByText('/home/kim/app/src/a.ts')).toBeInTheDocument()
    expect(del()).toBeDisabled()
    await waitFor(() => expect(del()).toBeEnabled())
    expect(mockHash).toHaveBeenCalledWith('%1', 'src/a.ts', '/home/kim/app')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(p.onClose).toHaveBeenCalled()
  })

  it('shows unsafe characters in the path', async () => {
    show({ path: 'src/a\u202eb.ts' })
    expect(
      screen.getByText('/home/kim/app/src/a⟨U+202E⟩b.ts'),
    ).toBeInTheDocument()
    await waitFor(() => expect(del()).toBeEnabled())
  })

  it('moves the file to the trash with the hash read, and says so', async () => {
    mockDelete.mockResolvedValue({
      root: '/home/kim/app',
      path: 'src/a.ts',
      trashId: 't1',
      size: 3,
    })
    const p = show({ sensitive: true })
    expect(screen.getByText('This is a sensitive file')).toBeInTheDocument()
    await waitFor(() => expect(del()).toBeEnabled())
    await act(async () => fireEvent.click(del()))
    expect(mockDelete).toHaveBeenCalledWith('%1', {
      root: '/home/kim/app',
      path: 'src/a.ts',
      kind: 'file',
      baseHash: 'h1',
      reveal: true,
      permanent: false,
    })
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onDeleted).toHaveBeenCalledWith({
      path: 'src/a.ts',
      kind: 'file',
      trashId: 't1',
      permanent: undefined,
    })
  })

  it('uses the hash of the text shown, and a folder needs none', async () => {
    mockDelete.mockResolvedValue({ root: '/', path: 'd', trashId: 't' })
    const { unmount } = show({ hash: 'shown', root: '/' })
    expect(screen.getByText('/src/a.ts')).toBeInTheDocument()
    await act(async () => fireEvent.click(del()))
    expect(mockHash).not.toHaveBeenCalled()
    expect(mockDelete.mock.calls[0][1].baseHash).toBe('shown')
    unmount()
    show({ kind: 'dir', path: 'd' })
    expect(screen.getByText('Delete folder?')).toBeInTheDocument()
    await act(async () => fireEvent.click(del()))
    expect(mockHash).not.toHaveBeenCalled()
    expect(mockDelete.mock.calls[1][1]).toMatchObject({
      kind: 'dir',
      baseHash: undefined,
    })
  })

  it('a file too large to hash is deleted from a terminal', async () => {
    mockHash.mockResolvedValue({ root: '/r', path: 'x', size: 1 })
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too large to delete here; use the terminal',
    )
    expect(del()).toBeDisabled()
  })

  it('a busy server can be asked again; other failures say why', async () => {
    mockHash.mockRejectedValueOnce(refused(429, 'busy'))
    const { unmount } = show()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Busy; try again',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(del()).toBeEnabled())
    expect(mockHash).toHaveBeenCalledTimes(2)
    unmount()
    mockHash.mockRejectedValueOnce(refused(404, ''))
    const second = show()
    expect(await screen.findByRole('alert')).toHaveTextContent('File not found')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    second.unmount()
    mockHash.mockRejectedValueOnce(new Error('offline'))
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not read the file',
    )
  })

  it('a moved root closes the box', async () => {
    mockHash.mockRejectedValueOnce(
      refused(409, '', { root: '/n' }) as RequestError,
    )
    const p = show()
    await waitFor(() => expect(p.onRootChanged).toHaveBeenCalledWith('/n'))
    expect(p.onClose).toHaveBeenCalled()
  })

  it('a reply after the box closed changes nothing in it', async () => {
    let finish!: (v: unknown) => void
    mockHash.mockImplementationOnce(() => new Promise((r) => (finish = r)))
    const { unmount } = show()
    unmount()
    await act(async () => finish({ hash: 'h' }))
    let fail!: (e: unknown) => void
    mockHash.mockImplementationOnce(
      () => new Promise((_r, reject) => (fail = reject)),
    )
    const second = show()
    second.unmount()
    await act(async () => fail(new Error('x')))
  })

  it('asks a second time before deleting for good across file systems', async () => {
    mockDelete
      .mockRejectedValueOnce(refused(409, 'cross_device'))
      .mockRejectedValueOnce(refused(409, 'cross_device'))
      .mockResolvedValueOnce({ root: '/r', path: 'src/a.ts', permanent: true })
    const p = show()
    await waitFor(() => expect(del()).toBeEnabled())
    await act(async () => fireEvent.click(del()))
    expect(screen.getByText('Delete permanently?')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[1])
    expect(p.onDeleted).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(del()))
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Delete permanently' }),
      ),
    )
    expect(mockDelete.mock.calls[2][1].permanent).toBe(true)
    expect(p.onDeleted).toHaveBeenCalledWith({
      path: 'src/a.ts',
      kind: 'file',
      trashId: undefined,
      permanent: true,
    })
  })

  it('a changed file is read again; one swapped into the trash keeps its Undo', async () => {
    mockDelete
      .mockRejectedValueOnce(refused(409, 'changed'))
      .mockRejectedValueOnce(refused(409, 'changed', { trashId: 'sw' }))
    const p = show()
    await waitFor(() => expect(del()).toBeEnabled())
    await act(async () => fireEvent.click(del()))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The file changed since it was read',
    )
    expect(p.onRefresh).toHaveBeenCalledTimes(1)
    expect(p.onDeleted).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(del()))
    expect(p.onDeleted).toHaveBeenCalledWith({
      path: 'src/a.ts',
      kind: 'file',
      trashId: 'sw',
      swapped: true,
    })
  })

  it('a hash from the viewer that went stale is read again', async () => {
    mockDelete
      .mockRejectedValueOnce(refused(409, 'changed'))
      .mockResolvedValueOnce({ root: '/r', path: 'src/a.ts', trashId: 't' })
    show({ hash: 'old' })
    await act(async () => fireEvent.click(del()))
    expect(mockDelete.mock.calls[0][1].baseHash).toBe('old')
    await waitFor(() => expect(mockHash).toHaveBeenCalled())
    await waitFor(() => expect(del()).toBeEnabled())
    await act(async () => fireEvent.click(del()))
    expect(mockDelete.mock.calls[1][1].baseHash).toBe('h1')
  })

  it('says why a delete was refused', async () => {
    mockDelete
      .mockRejectedValueOnce(refused(409, 'not_empty'))
      .mockRejectedValueOnce(refused(404, ''))
      .mockRejectedValueOnce(refused(500, 'odd'))
      .mockRejectedValueOnce(new Error('offline'))
    show({ kind: 'dir' })
    for (const why of [
      'The folder is not empty',
      'Not found; it may be gone',
      'Could not delete it',
      'It may have been deleted. Refresh to check.',
    ]) {
      await act(async () => fireEvent.click(del()))
      expect(screen.getByRole('alert')).toHaveTextContent(why)
    }
  })

  it('a moved root on delete closes the box', async () => {
    mockDelete.mockRejectedValue(refused(409, '', { root: '/n' }))
    const p = show({ kind: 'dir' })
    await act(async () => fireEvent.click(del()))
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onRootChanged).toHaveBeenCalledWith('/n')
  })

  it('closed while deleting: a delete still says so, with its Undo', async () => {
    let settle!: () => void
    mockDelete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ root: '/r', path: 'd', trashId: 't' })
        }),
    )
    const p = show({ kind: 'dir', path: 'd' })
    act(() => {
      fireEvent.click(del())
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => settle())
    expect(p.onClose).toHaveBeenCalledTimes(1)
    expect(p.onDeleted).toHaveBeenCalledWith({
      path: 'd',
      kind: 'dir',
      trashId: 't',
      permanent: undefined,
    })
  })

  it('closed while deleting: a failure only reads the tree again', async () => {
    const replies: [string, unknown][] = [
      ['reject', new Error('offline')],
      ['reject', refused(409, '', { root: '/n' })],
      ['reject', refused(409, 'changed')],
    ]
    for (const [how, value] of replies) {
      let settle!: () => void
      mockDelete.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            settle = () => (how === 'resolve' ? resolve(value) : reject(value))
          }),
      )
      const p = show({ kind: 'dir' })
      act(() => {
        fireEvent.click(del())
      })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await act(async () => settle())
      expect(p.onDeleted).not.toHaveBeenCalled()
      expect(p.onClose).toHaveBeenCalledTimes(1)
      p.unmount()
    }
  })
})
