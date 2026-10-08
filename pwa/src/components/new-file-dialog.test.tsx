import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFilesStores, useFileDraft } from '../hooks/use-files'
import { RequestError } from '../hooks/use-mux-api'
import { NewFileDialog } from './new-file-dialog'

const mockCreate = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  createFile: (...a: unknown[]) => mockCreate(...a),
}))
vi.mock('../hooks/use-media-query', () => ({ useIsMobile: () => false }))

beforeEach(() => {
  resetFilesStores()
  mockCreate.mockReset()
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

function show(initialPath = 'docs/') {
  const p = {
    onClose: vi.fn(),
    onCreated: vi.fn(),
    onRootChanged: vi.fn(),
    onRefresh: vi.fn(),
  }
  const { unmount } = render(
    <NewFileDialog paneId="%1" root="/r" initialPath={initialPath} {...p} />,
  )
  return { ...p, unmount }
}

const box = () => screen.getByRole('textbox')
const type = (v: string) => fireEvent.change(box(), { target: { value: v } })
const create = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  })
}
const dialog = (name: string) => screen.getByRole('dialog', { name })

const refused = (status: number, code: string, root?: string, path?: string) =>
  new RequestError(
    status,
    code,
    'x',
    undefined,
    undefined,
    root,
    undefined,
    path,
  )

// A draft of another file in the pane, changed or not
function draft(text: string) {
  const { result } = renderHook(() => useFileDraft('%1', 'notes.md'))
  act(() =>
    result.current[1]({
      root: '/r',
      path: 'notes.md',
      baseHash: 'h',
      base: 'a',
      crlf: false,
      text,
      reveal: false,
    }),
  )
  return result
}

describe('NewFileDialog', () => {
  it('starts in the focused directory and creates the file', async () => {
    mockCreate.mockResolvedValue({ root: '/r', path: 'docs/a.md' })
    const p = show()
    expect(box()).toHaveValue('docs/')
    await waitFor(() => expect(box()).toHaveFocus())
    expect((box() as HTMLInputElement).selectionStart).toBe(5)
    type('docs/a.md')
    await create()
    expect(mockCreate).toHaveBeenCalledWith('%1', {
      root: '/r',
      path: 'docs/a.md',
      reveal: false,
    })
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onCreated).toHaveBeenCalledWith('docs/a.md', '/r', false)
  })

  it.each([
    ['', 'Enter a file name'],
    ['docs/', 'Enter a file name after the last /'],
    ['a/../../b', "A path can't go up with .."],
  ])('%j is caught before sending', async (path, message) => {
    show(path)
    await create()
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(box()).toHaveAttribute('aria-invalid', 'true')
    expect(mockCreate).not.toHaveBeenCalled()
    // Typing clears it
    type('x')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it("creates without asking, keeping another file's unsaved changes", async () => {
    mockCreate.mockResolvedValue({ root: '/r', path: 'a.md' })
    const d = draft('changed')
    const p = show('a.md')
    await create()
    expect(screen.queryByRole('dialog', { name: /Discard/ })).toBeNull()
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(p.onCreated).toHaveBeenCalledWith('a.md', '/r', false)
    expect(d.current[0]?.text).toBe('changed')
  })

  it('a name that usually holds secrets is created after a second ask', async () => {
    mockCreate
      .mockRejectedValueOnce(refused(403, 'sensitive'))
      .mockRejectedValueOnce(refused(403, 'sensitive'))
      .mockResolvedValueOnce({ root: '/r', path: '.env.local' })
    const p = show('.env.local')
    await create()
    const ask = dialog('Create this file?')
    expect(ask).toHaveTextContent(
      'This name usually holds secrets. Create it anyway?',
    )
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(p.onCreated).not.toHaveBeenCalled()
    await create()
    await act(async () => {
      fireEvent.click(
        within(dialog('Create this file?')).getByRole('button', {
          name: 'Create',
        }),
      )
    })
    expect(mockCreate).toHaveBeenLastCalledWith('%1', {
      root: '/r',
      path: '.env.local',
      reveal: true,
    })
    expect(p.onCreated).toHaveBeenCalledWith('.env.local', '/r', true)
  })

  it('an existing name offers to open it', async () => {
    mockCreate.mockRejectedValue(refused(409, 'exists'))
    const p = show('a.md')
    await create()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A file or directory of that name already exists',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onCreated).toHaveBeenCalledWith('a.md', '/r', false)
  })

  it("Open it opens the server's name for an existing file", async () => {
    // A Windows host takes \ as a separator and reports the name with /
    mockCreate.mockRejectedValue(refused(409, 'exists', undefined, 'w/v.md'))
    const p = show('w\\v.md')
    await create()
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    expect(p.onCreated).toHaveBeenCalledWith('w/v.md', '/r', false)
  })

  it('a moved root closes the box and is handed on', async () => {
    mockCreate.mockRejectedValue(refused(409, '', '/n'))
    const p = show('a.md')
    await create()
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onRootChanged).toHaveBeenCalledWith('/n')
    expect(p.onCreated).not.toHaveBeenCalled()
  })

  it('a lost reply says the file may exist, with a Refresh', async () => {
    mockCreate.mockRejectedValue(new TypeError('Failed to fetch'))
    const p = show('a.md')
    await create()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The file may have been created. Refresh to check.',
    )
    fireEvent.click(
      within(screen.getByRole('alert')).getByRole('button', {
        name: 'Refresh',
      }),
    )
    expect(p.onRefresh).toHaveBeenCalled()
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onCreated).not.toHaveBeenCalled()
  })

  it.each([
    [409, 'not_directory', 'Part of this path is a file, not a directory'],
    [403, 'symlink', 'Part of this path is a symbolic link'],
    [403, 'not_allowed', "Files can't be created there"],
    [403, 'permission', "The server can't create a file there"],
    [400, 'invalid_name', "This name can't be used"],
    [429, 'busy', 'Too many writes at once. Try again'],
    [507, 'storage_full', "The host's disk or quota is full"],
    [403, 'read_only', 'The file system there is read-only'],
    [500, '', 'Could not create the file'],
  ])('%i %s says why', async (status, code, message) => {
    mockCreate.mockRejectedValue(refused(status, code))
    const p = show('a.md')
    await create()
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(within(screen.getByRole('alert')).queryByRole('button')).toBeNull()
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('sends once while a create runs', async () => {
    let finish!: (v: unknown) => void
    mockCreate.mockReturnValue(new Promise((r) => (finish = r)))
    const p = show('a.md')
    await create()
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    fireEvent.submit(box().closest('form')!)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    await act(async () => finish({ root: '/r', path: 'a.md' }))
    expect(p.onCreated).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Cancel', 1],
    ['an unmount', 0],
  ])(
    'a reply after %s refreshes the tree without opening the file',
    async (how, closes) => {
      let finish!: (v: unknown) => void
      mockCreate.mockReturnValue(new Promise((r) => (finish = r)))
      const p = show('a.md')
      await create()
      // Cancel stays usable while the create runs
      const cancel = screen.getByRole('button', { name: 'Cancel' })
      expect(cancel).toBeEnabled()
      if (how === 'Cancel') fireEvent.click(cancel)
      else p.unmount()
      await act(async () => finish({ root: '/r', path: 'a.md' }))
      expect(p.onRefresh).toHaveBeenCalledTimes(1)
      expect(p.onCreated).not.toHaveBeenCalled()
      // Only the user's close, never a second one from the reply
      expect(p.onClose).toHaveBeenCalledTimes(closes)
    },
  )

  it('a refusal after closing shows nothing and closes nothing', async () => {
    let fail!: (e: unknown) => void
    mockCreate.mockReturnValue(new Promise((_, r) => (fail = r)))
    const p = show('a.md')
    await create()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => fail(refused(409, 'exists')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(p.onClose).toHaveBeenCalledTimes(1)
    expect(p.onCreated).not.toHaveBeenCalled()
    expect(p.onRefresh).not.toHaveBeenCalled()
  })

  it('a moved root after closing still reaches the tree', async () => {
    let fail!: (e: unknown) => void
    mockCreate.mockReturnValue(new Promise((_, r) => (fail = r)))
    const p = show('a.md')
    await create()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => fail(refused(409, '', '/n')))
    expect(p.onRootChanged).toHaveBeenCalledWith('/n')
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('Cancel closes the box', () => {
    const p = show()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(p.onClose).toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
