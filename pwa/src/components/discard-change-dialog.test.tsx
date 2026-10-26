import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type ChangeEntry, RequestError } from '../hooks/use-mux-api'
import { DiscardChangeDialog } from './discard-change-dialog'

const mockHash = vi.fn()
const mockApply = vi.fn()
vi.mock('../hooks/use-media-query', () => ({ useIsMobile: () => false }))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFileHash: (...a: unknown[]) => mockHash(...a),
  applyChange: (...a: unknown[]) => mockApply(...a),
}))

const refused = (status: number, code: string, extra: object = {}) =>
  Object.assign(new RequestError(status, code, code), extra)

const entry = (over: Partial<ChangeEntry> = {}): ChangeEntry => ({
  path: 'src/a.ts',
  staged: '',
  unstaged: 'M',
  sensitive: false,
  ...over,
})

function show(over: Partial<Parameters<typeof DiscardChangeDialog>[0]> = {}) {
  const p = {
    paneId: '%1',
    root: '/home/kim/app',
    entry: entry(),
    onClose: vi.fn(),
    onDiscarded: vi.fn(),
    onRootChanged: vi.fn(),
    onRefresh: vi.fn(),
    ...over,
  }
  const view = render(<DiscardChangeDialog {...p} />)
  return { ...p, ...view }
}

const button = (name: string) => screen.getByRole('button', { name })

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
  mockApply.mockReset()
  mockHash.mockResolvedValue({ root: '/r', path: 'x', size: 3, hash: 'h1' })
  mockApply.mockResolvedValue({
    root: '/home/kim/app',
    path: 'src/a.ts',
    trashId: 't1',
  })
})

describe('DiscardChangeDialog', () => {
  it('reads the hash of a whole file, then discards it; Cancel has the focus', async () => {
    const p = show({ entry: entry({ sensitive: true, orig: 'src/o.ts' }) })
    expect(screen.getByText('Discard changes in a.ts?')).toBeInTheDocument()
    expect(screen.getByText('/home/kim/app/src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('This is a sensitive file')).toBeInTheDocument()
    expect(
      screen.getByText(
        "The current file goes to Termote's trash; Undo puts it back.",
      ),
    ).toBeInTheDocument()
    expect(button('Discard')).toBeDisabled()
    await waitFor(() => expect(button('Discard')).toBeEnabled())
    expect(mockHash).toHaveBeenCalledWith('%1', 'src/a.ts', '/home/kim/app')
    await waitFor(() => expect(button('Cancel')).toHaveFocus())
    await act(async () => fireEvent.click(button('Discard')))
    expect(mockApply).toHaveBeenCalledWith('%1', {
      root: '/home/kim/app',
      action: 'discard',
      path: 'src/a.ts',
      orig: 'src/o.ts',
      hunk: undefined,
      baseHash: 'h1',
      reveal: true,
      permanent: undefined,
    })
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onDiscarded).toHaveBeenCalledWith({
      root: '/home/kim/app',
      path: 'src/a.ts',
      trashId: 't1',
    })
  })

  it('sends the hash of the diff shown without reading one', async () => {
    show({ hash: 'seen', root: '/r/' })
    expect(screen.getByText('/r/src/a.ts')).toBeInTheDocument()
    await act(async () => fireEvent.click(button('Discard')))
    expect(mockHash).not.toHaveBeenCalled()
    expect(mockApply.mock.calls[0][1].baseHash).toBe('seen')
  })

  it('a hunk is discarded by its id, with no hash', async () => {
    show({
      hunk: { id: 'h-2', header: '@@ -3 +3 @@', lines: [] },
    })
    expect(screen.getByText('Discard this change?')).toBeInTheDocument()
    expect(screen.getByText('@@ -3 +3 @@')).toBeInTheDocument()
    await act(async () => fireEvent.click(button('Discard')))
    expect(mockHash).not.toHaveBeenCalled()
    expect(mockApply.mock.calls[0][1]).toMatchObject({
      hunk: 'h-2',
      baseHash: undefined,
    })
  })

  it('a deleted file comes back from the index', async () => {
    mockApply.mockResolvedValue({ root: '/r', path: 'src/a.ts' })
    const p = show({ entry: entry({ unstaged: 'D' }) })
    expect(screen.getByText('Restore a.ts?')).toBeInTheDocument()
    expect(
      screen.getByText('The file comes back as the index has it.'),
    ).toBeInTheDocument()
    await act(async () => fireEvent.click(button('Restore')))
    expect(mockHash).not.toHaveBeenCalled()
    expect(p.onDiscarded).toHaveBeenCalled()
  })

  it('an untracked file on another file system is deleted for good only after a second ask', async () => {
    mockApply
      .mockRejectedValueOnce(refused(409, 'cross_device'))
      .mockRejectedValueOnce(refused(409, 'cross_device'))
      .mockResolvedValueOnce({ root: '/r', path: 'src/a.ts', permanent: true })
    const p = show({ entry: entry({ unstaged: '?' }) })
    expect(screen.getByText('Delete a.ts?')).toBeInTheDocument()
    expect(
      screen.getByText("The file goes to Termote's trash; Undo puts it back."),
    ).toBeInTheDocument()
    await waitFor(() => expect(button('Delete')).toBeEnabled())
    await act(async () => fireEvent.click(button('Delete')))
    expect(screen.getByText('Delete permanently?')).toBeInTheDocument()
    // Cancelled once, asked again
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[1])
    await act(async () => fireEvent.click(button('Delete')))
    await act(async () => fireEvent.click(button('Delete permanently')))
    expect(mockApply.mock.calls[2][1].permanent).toBe(true)
    expect(p.onDiscarded).toHaveBeenCalledWith({
      root: '/r',
      path: 'src/a.ts',
      permanent: true,
    })
  })

  it('says why the server refused, reading the list again when it is stale', async () => {
    const p = show({ hash: 'h' })
    for (const [code, text, stale] of [
      [
        'stale_hunk',
        'The file changed since the diff was read; it was read again',
        true,
      ],
      [
        'filtered',
        'This file goes through a git filter (such as LFS); use the terminal',
        false,
      ],
      ['odd', 'Could not discard it', false],
    ] as const) {
      mockApply.mockRejectedValueOnce(refused(409, code))
      vi.mocked(p.onRefresh as () => void).mockClear()
      await act(async () => fireEvent.click(button('Discard')))
      expect(screen.getByRole('alert')).toHaveTextContent(text)
      expect(p.onRefresh).toHaveBeenCalledTimes(stale ? 1 : 0)
    }
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('a failure without an answer may have discarded it', async () => {
    mockApply.mockRejectedValue(new TypeError('network'))
    const p = show({ hash: 'h' })
    await act(async () => fireEvent.click(button('Discard')))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'It may have been discarded. Refresh to check.',
    )
    expect(p.onRefresh).toHaveBeenCalled()
  })

  it('a moved root closes the box', async () => {
    mockApply.mockRejectedValue(refused(409, '', { root: '/new' }))
    const p = show({ hash: 'h' })
    await act(async () => fireEvent.click(button('Discard')))
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onRootChanged).toHaveBeenCalledWith('/new')
  })

  it('a reply after the box closed only tells what happened', async () => {
    let answer: (v: unknown) => void = () => {}
    let fail: (e: unknown) => void = () => {}
    mockApply.mockReturnValueOnce(new Promise((r) => (answer = r)))
    const p = show({ hash: 'h' })
    fireEvent.click(button('Discard'))
    fireEvent.click(button('Cancel'))
    await act(async () =>
      answer({ root: '/r', path: 'src/a.ts', trashId: 't' }),
    )
    expect(p.onClose).toHaveBeenCalledTimes(1)
    expect(p.onDiscarded).toHaveBeenCalled()
    // A refusal after closing changes nothing on screen
    mockApply.mockReturnValueOnce(new Promise((_, r) => (fail = r)))
    const q = show({ hash: 'h' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[1])
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[1])
    await act(async () => fail(refused(409, 'changed')))
    expect(q.onRefresh).toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a file past the hash limit, gone or unreadable cannot be discarded', async () => {
    mockHash.mockResolvedValueOnce({ root: '/r', path: 'x', size: 9 })
    const a = show()
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Too large to discard here; use the terminal',
      ),
    )
    expect(button('Discard')).toBeDisabled()
    a.unmount()
    mockHash.mockRejectedValueOnce(refused(404, 'x'))
    const b = show()
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('File not found'),
    )
    b.unmount()
    mockHash.mockRejectedValueOnce(new TypeError('x'))
    show()
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not read the file',
      ),
    )
  })

  it('a moved root while the hash is read closes the box', async () => {
    mockHash.mockRejectedValue(refused(409, '', { root: '/new' }))
    const p = show()
    await waitFor(() => expect(p.onRootChanged).toHaveBeenCalledWith('/new'))
    expect(p.onClose).toHaveBeenCalled()
  })

  it('a failure or a moved root after the box closed changes nothing on screen', async () => {
    let fail: (e: unknown) => void = () => {}
    mockApply.mockReturnValueOnce(new Promise((_, r) => (fail = r)))
    const p = show({ hash: 'h' })
    fireEvent.click(button('Discard'))
    fireEvent.click(button('Cancel'))
    await act(async () => fail(new TypeError('network')))
    expect(p.onRefresh).toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    p.unmount()
    mockApply.mockReturnValueOnce(new Promise((_, r) => (fail = r)))
    const q = show({ hash: 'h' })
    fireEvent.click(button('Discard'))
    fireEvent.click(button('Cancel'))
    await act(async () => fail(refused(409, '', { root: '/new' })))
    expect(q.onClose).toHaveBeenCalledTimes(1)
    expect(q.onRootChanged).toHaveBeenCalledWith('/new')
  })

  it('a hash failure after the box closed is dropped', async () => {
    let fail: (e: unknown) => void = () => {}
    mockHash.mockReturnValue(new Promise((_, r) => (fail = r)))
    const p = show()
    p.unmount()
    await act(async () => fail(refused(409, '', { root: '/new' })))
    expect(p.onRootChanged).not.toHaveBeenCalled()
  })

  it('a hash read after the box closed is dropped', async () => {
    let answer: (v: unknown) => void = () => {}
    mockHash.mockReturnValue(new Promise((r) => (answer = r)))
    const p = show()
    p.unmount()
    await act(async () => answer({ hash: 'late' }))
    expect(p.onRootChanged).not.toHaveBeenCalled()
  })
})
