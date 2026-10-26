import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFilesStores, useFileDraft } from '../hooks/use-files'
import { RequestError } from '../hooks/use-mux-api'
import { RenameFileDialog } from './rename-file-dialog'

const mockRename = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  renameFile: (...a: unknown[]) => mockRename(...a),
}))
vi.mock('../hooks/use-media-query', () => ({ useIsMobile: () => false }))

beforeEach(() => {
  resetFilesStores()
  mockRename.mockReset()
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

function show(path = 'docs/report.final.md', reveal = false) {
  const p = {
    onClose: vi.fn(),
    onRenamed: vi.fn(),
    onOpen: vi.fn(),
    onRootChanged: vi.fn(),
    onRefresh: vi.fn(),
  }
  const { unmount } = render(
    <RenameFileDialog
      paneId="%1"
      root="/r"
      path={path}
      reveal={reveal}
      {...p}
    />,
  )
  return { ...p, unmount }
}

const box = () => screen.getByRole('textbox') as HTMLInputElement
const type = (v: string) => fireEvent.change(box(), { target: { value: v } })
const rename = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  })
}
const refused = (status: number, code: string, root?: string, path?: string) =>
  new RequestError(status, code, 'x', { root, path })

describe('RenameFileDialog', () => {
  it('starts with the path, the name without its extension selected', () => {
    show()
    expect(box()).toHaveValue('docs/report.final.md')
    // At once, not a frame later: typing over the whole path meanwhile
    // would be cut down to the name
    expect(box()).toHaveFocus()
    expect([box().selectionStart, box().selectionEnd]).toEqual([5, 17])
  })

  it('renames, handing on the path the server answered', async () => {
    mockRename.mockResolvedValue({ root: '/r', path: 'docs/b.md' })
    const p = show()
    // Unchanged: nothing to send
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
    type('./docs/b.md')
    await rename()
    expect(mockRename).toHaveBeenCalledWith('%1', {
      root: '/r',
      path: 'docs/report.final.md',
      newPath: './docs/b.md',
      reveal: false,
    })
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onRenamed).toHaveBeenCalledWith('docs/b.md', false, false)
  })

  it('a sensitive file shown already goes with reveal, no second ask', async () => {
    mockRename.mockResolvedValue({ root: '/r', path: 'b.env' })
    const p = show('.env', true)
    type('b.env')
    await rename()
    expect(mockRename.mock.calls[0][1].reveal).toBe(true)
    expect(p.onRenamed).toHaveBeenCalledWith('b.env', true, false)
  })

  it('a name that usually holds secrets is renamed after a second ask', async () => {
    mockRename
      .mockRejectedValueOnce(refused(403, 'sensitive'))
      .mockRejectedValueOnce(refused(403, 'sensitive'))
      .mockResolvedValueOnce({ root: '/r', path: '.env' })
    const p = show('env.txt')
    type('.env')
    await rename()
    const ask = screen.getByRole('dialog', { name: 'Rename this file?' })
    // Cancel keeps the box as it was
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    await rename()
    await act(async () => {
      fireEvent.click(
        within(
          screen.getByRole('dialog', { name: 'Rename this file?' }),
        ).getByRole('button', { name: 'Rename' }),
      )
    })
    expect(mockRename.mock.calls.at(-1)?.[1].reveal).toBe(true)
    expect(p.onRenamed).toHaveBeenCalledWith('.env', true, false)
  })

  it('a name typed wrong is caught before sending', async () => {
    show()
    for (const [v, want] of [
      ['', 'Enter a file name'],
      ['docs/', 'Enter a file name after the last /'],
      ['../x', "A path can't go up with .."],
    ]) {
      type(v)
      await rename()
      expect(screen.getByRole('alert')).toHaveTextContent(want)
    }
    expect(mockRename).not.toHaveBeenCalled()
  })

  it('never renames onto a file with unsaved changes', async () => {
    const { result } = renderHook(() => useFileDraft('%2', 'notes.md'))
    act(() =>
      result.current[1]({
        root: '/r',
        path: 'notes.md',
        baseHash: 'h',
        base: 'a',
        crlf: false,
        text: 'b',
        reveal: false,
      }),
    )
    show()
    type('notes.md')
    await rename()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'notes.md has unsaved changes. Save or discard them first',
    )
    expect(mockRename).not.toHaveBeenCalled()
  })

  it('an existing name offers to open it, as the server names it', async () => {
    mockRename.mockRejectedValue(refused(409, 'exists', undefined, 'docs/b.md'))
    const p = show()
    type('docs\\b.md')
    await rename()
    expect(screen.getByRole('alert')).toHaveTextContent('already exists')
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onOpen).toHaveBeenCalledWith('docs/b.md')
  })

  it('an existing name the server did not name opens the one typed', async () => {
    mockRename.mockRejectedValue(refused(409, 'exists'))
    const p = show()
    type('b.md')
    await rename()
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    expect(p.onOpen).toHaveBeenCalledWith('b.md')
  })

  it('sends once while a rename runs', async () => {
    mockRename.mockReturnValue(new Promise(() => {}))
    show()
    type('b.md')
    await rename()
    fireEvent.submit(box())
    expect(mockRename).toHaveBeenCalledTimes(1)
  })

  it('after closing: a moved root and a swapped file are still handed on', async () => {
    let fail: (e: unknown) => void = () => {}
    mockRename.mockReturnValueOnce(new Promise((_, r) => (fail = r)))
    const p = show()
    type('b.md')
    await rename()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => fail(refused(409, '', '/other')))
    expect(p.onRootChanged).toHaveBeenCalledWith('/other')
    mockRename.mockReturnValueOnce(new Promise((_, r) => (fail = r)))
    type('c.md')
    await rename()
    await act(async () => fail(refused(409, 'changed', undefined, 'x/c.md')))
    expect(p.onRenamed).toHaveBeenCalledWith('x/c.md', false, true)
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('a file gone offers to read the tree again', async () => {
    mockRename.mockRejectedValue(new RequestError(404, '', 'not found'))
    const p = show()
    type('b.md')
    await rename()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This file no longer exists',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(p.onRefresh).toHaveBeenCalled()
  })

  it('a lost reply says the file may have moved, with a Refresh', async () => {
    mockRename.mockRejectedValue(new TypeError('offline'))
    show()
    type('b.md')
    await rename()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The file may have been renamed',
    )
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })

  it.each([
    ['cross_device', "Can't move a file to another file system"],
    ['in_use', 'The file is open in another program on the host'],
    ['changed', 'The file changed while it was being renamed'],
    ['not_file', 'Only a file can be renamed'],
    ['not_allowed', "Files can't be moved there"],
    ['odd', 'Could not rename the file'],
  ])('%s says why', async (code, want) => {
    mockRename.mockRejectedValue(refused(409, code))
    show()
    type('b.md')
    await rename()
    expect(screen.getByRole('alert')).toHaveTextContent(want)
  })

  it('a file swapped while renamed is handed on where it stayed', async () => {
    mockRename.mockRejectedValue(refused(409, 'changed', undefined, 'c.md'))
    const p = show()
    type('b.md')
    await rename()
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onRenamed).toHaveBeenCalledWith('c.md', false, true)
  })

  it('a moved root closes the box and is handed on', async () => {
    mockRename.mockRejectedValue(refused(409, '', '/other'))
    const p = show()
    type('b.md')
    await rename()
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onRootChanged).toHaveBeenCalledWith('/other')
  })

  it('after closing: the tabs still follow, a refusal shows nothing', async () => {
    let answer: (v: unknown) => void = () => {}
    mockRename.mockReturnValueOnce(new Promise((r) => (answer = r)))
    const p = show()
    type('b.md')
    await rename()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
    await act(async () => answer({ root: '/r', path: 'b.md' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
    expect(p.onRenamed).toHaveBeenCalledWith('b.md', false, false)
    // A refusal after closing: nothing shown, root moves still followed
    let fail: (e: unknown) => void = () => {}
    mockRename.mockReturnValueOnce(new Promise((_, r) => (fail = r)))
    p.unmount()
    const q = show()
    type('c.md')
    await rename()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => fail(refused(409, 'exists')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(q.onClose).toHaveBeenCalledTimes(1)
  })
})
