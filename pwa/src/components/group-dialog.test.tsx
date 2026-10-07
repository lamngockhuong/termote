import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import { GroupDialog, groupProblem } from './group-dialog'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

const setup = (onCreate = vi.fn(async () => {})) => {
  const onClose = vi.fn()
  render(<GroupDialog noun="workspace" onClose={onClose} onCreate={onCreate} />)
  return {
    onCreate,
    onClose,
    name: screen.getByLabelText('Name'),
    cwd: screen.getByLabelText('Directory (an absolute path on the host)'),
    create: screen.getByRole('button', { name: 'Create' }),
  }
}

// The isOpen function the dialog handed to its first create
const isOpenArg = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls[0][2] as () => boolean

describe('GroupDialog', () => {
  it('creates with the trimmed name and directory, then closes', async () => {
    const { onCreate, onClose, name, cwd, create } = setup()
    expect(screen.getByText('New workspace')).toBeInTheDocument()
    fireEvent.change(name, { target: { value: ' api ' } })
    fireEvent.change(cwd, { target: { value: ' /srv/api ' } })
    await act(async () => fireEvent.click(create))
    expect(onCreate).toHaveBeenCalledWith(
      'api',
      '/srv/api',
      expect.any(Function),
    )
    // Still open when the reply came
    expect(isOpenArg(onCreate)()).toBe(true)
    expect(onClose).toHaveBeenCalled()
  })

  it('asks for a name, and for one of at most 64 bytes, before sending', async () => {
    const { onCreate, name, create } = setup()
    await act(async () => fireEvent.click(create))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name')
    fireEvent.change(name, { target: { value: 'é'.repeat(33) } })
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => fireEvent.click(create))
    expect(screen.getByRole('alert')).toHaveTextContent('Use at most 64 bytes')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('says why the server refused and keeps what was typed', async () => {
    const onCreate = vi.fn(async () => {
      throw new RequestError(400, 'not_found', 'no such directory')
    })
    const { onClose, name, cwd, create } = setup(onCreate)
    fireEvent.change(name, { target: { value: 'api' } })
    fireEvent.change(cwd, { target: { value: '/nope' } })
    await act(async () => fireEvent.click(create))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No such directory on the host',
    )
    expect(name).toHaveValue('api')
    expect(cwd).toHaveValue('/nope')
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.change(cwd, { target: { value: '/srv' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a reply lost on the way says the group may exist', async () => {
    const { name, create } = setup(
      vi.fn(async () => Promise.reject(new TypeError('fetch'))),
    )
    fireEvent.change(name, { target: { value: 'api' } })
    await act(async () => fireEvent.click(create))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The workspace may have been created. Check the list.',
    )
  })

  it('Cancel closes, and a reply after that shows nothing', async () => {
    let reject!: (e: unknown) => void
    const onCreate = vi.fn(() => new Promise<void>((_, r) => (reject = r)))
    const { onClose, name, create } = setup(onCreate)
    fireEvent.change(name, { target: { value: 'api' } })
    fireEvent.click(create)
    // A second press, or Enter, while sending does nothing
    fireEvent.click(create)
    fireEvent.submit(create.closest('form')!)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => reject(new RequestError(409, 'exists', 'x')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('a create that ends after Cancel does not close again', async () => {
    let resolve!: () => void
    const onCreate = vi.fn(() => new Promise<void>((r) => (resolve = r)))
    const { onClose, name, create } = setup(onCreate)
    fireEvent.change(name, { target: { value: 'api' } })
    fireEvent.click(create)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // The create learns the box is closed
    expect(isOpenArg(onCreate)()).toBe(false)
    await act(async () => resolve())
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('groupProblem', () => {
  it('a workspace name has no character list', () => {
    expect(groupProblem('invalid_name', 'workspace')).toBe(
      "This name can't be used",
    )
  })

  it('words every code the server sends', () => {
    for (const [code, text] of [
      [
        'invalid_name',
        "This name can't be used. Avoid : . * ? [ \\ and a leading = or -",
      ],
      ['invalid_cwd', 'Enter an absolute path on the host, or leave it empty'],
      ['not_found', 'No such directory on the host'],
      ['not_directory', 'That path is a file, not a directory'],
      ['not_allowed', "A tmux session can't start in that directory"],
      ['busy', 'The directory did not answer. Try again'],
      ['exists', 'A tmux session of that name already exists'],
      ['unsupported', "This server can't create a tmux session"],
      ['', 'Could not create the tmux session'],
    ]) {
      expect(groupProblem(code, 'tmux session')).toBe(text)
    }
  })
})
