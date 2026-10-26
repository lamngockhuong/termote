import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError, type UserTask } from '../hooks/use-mux-api'
import { UserTaskEditor } from './user-task-editor'

const store = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}))
vi.mock('../hooks/use-user-tasks', () => ({
  createTask: store.create,
  updateTask: store.update,
}))

const task = (over: Partial<UserTask> = {}): UserTask => ({
  id: 'a',
  name: 'Build',
  command: 'make build',
  updated: 'u1',
  ...over,
})

function renderEditor(t: UserTask | null = null) {
  const onClose = vi.fn()
  render(<UserTaskEditor task={t} onClose={onClose} />)
  return { onClose }
}

const nameBox = () => screen.getByRole('textbox', { name: 'Name' })
const commandBox = () => screen.getByRole('textbox', { name: 'Command' })
const save = () =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })

describe('UserTaskEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    store.create.mockResolvedValue(task())
    store.update.mockResolvedValue(task())
  })

  it('makes a new task', async () => {
    const { onClose } = renderEditor()
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeVisible()
    expect(nameBox()).toHaveFocus()
    fireEvent.change(nameBox(), { target: { value: 'Deploy' } })
    fireEvent.change(commandBox(), { target: { value: 'make deploy' } })
    await save()
    expect(store.create).toHaveBeenCalledWith({
      name: 'Deploy',
      command: 'make deploy',
    })
    expect(store.update).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('changes one, naming the version it read', async () => {
    const { onClose } = renderEditor(task({ name: 'Bu‮ild' }))
    expect(
      screen.getByRole('dialog', { name: 'Edit Bu⟨U+202E⟩ild' }),
    ).toBeVisible()
    fireEvent.change(nameBox(), { target: { value: 'Build all' } })
    await save()
    expect(store.update).toHaveBeenCalledWith('a', {
      name: 'Build all',
      command: 'make build',
      updated: 'u1',
    })
    expect(store.create).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('a line break typed or pasted into the command becomes a space', async () => {
    renderEditor()
    fireEvent.change(nameBox(), { target: { value: 'n' } })
    // jsdom strips line breaks from an input's value itself, so the value
    // a browser would report for a paste is given to the change event
    const box = commandBox() as HTMLInputElement
    Object.defineProperty(box, 'value', {
      configurable: true,
      get: () => 'a\r\n\nb\nc',
    })
    fireEvent.input(box)
    delete (box as { value?: string }).value
    expect(commandBox()).toHaveValue('a b c')
    await save()
    expect(store.create).toHaveBeenCalledWith({ name: 'n', command: 'a b c' })
  })

  it('checks before sending, and marks the field it is about', async () => {
    renderEditor()
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent('Name the task')
    expect(nameBox()).toHaveAttribute('aria-invalid', 'true')
    expect(nameBox()).toHaveAccessibleDescription('Name the task')
    expect(commandBox()).not.toHaveAttribute('aria-invalid')
    fireEvent.change(nameBox(), { target: { value: 'n' } })
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the command')
    expect(nameBox()).not.toHaveAttribute('aria-invalid')
    expect(commandBox()).toHaveAttribute('aria-invalid', 'true')
    expect(commandBox()).toHaveAccessibleDescription(
      /Runs in the shell of a tab.*Enter the command/,
    )
    fireEvent.change(commandBox(), { target: { value: 'a​b' } })
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The command contains hidden characters (U+200B)',
    )
    expect(store.create).not.toHaveBeenCalled()
    // A valid save clears the problem and the marks
    fireEvent.change(commandBox(), { target: { value: 'ok' } })
    await save()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(commandBox()).not.toHaveAttribute('aria-invalid')
  })

  it.each([
    ['name_taken', 'A task with this name exists'],
    ['too_many', 'Up to 100 tasks'],
    ['newer_format', 'Saved by a newer Termote'],
    ['busy', 'try again'],
  ])('says why the server refused: %s', async (code, text) => {
    store.create.mockRejectedValue(new RequestError(409, code, 'x'))
    renderEditor()
    fireEvent.change(nameBox(), { target: { value: 'n' } })
    fireEvent.change(commandBox(), { target: { value: 'c' } })
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(text)
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('marks the field the server says is wrong, and no other', async () => {
    renderEditor()
    fireEvent.change(nameBox(), { target: { value: 'n' } })
    fireEvent.change(commandBox(), { target: { value: 'c' } })
    store.create.mockRejectedValueOnce(
      new RequestError(400, 'invalid_task', 'the command is empty', {
        field: 'command',
      }),
    )
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Not saved: the command is empty',
    )
    expect(commandBox()).toHaveAttribute('aria-invalid', 'true')
    expect(nameBox()).not.toHaveAttribute('aria-invalid')
    store.create.mockRejectedValueOnce(
      new RequestError(400, 'invalid_task', 'the name is empty', {
        field: 'name',
      }),
    )
    await save()
    expect(nameBox()).toHaveAttribute('aria-invalid', 'true')
    expect(commandBox()).not.toHaveAttribute('aria-invalid')
    // A field the form does not have marks nothing
    store.create.mockRejectedValueOnce(
      new RequestError(400, 'invalid_task', 'x', { field: 'text' }),
    )
    await save()
    expect(nameBox()).not.toHaveAttribute('aria-invalid')
    expect(commandBox()).not.toHaveAttribute('aria-invalid')
  })

  it('changed on another device: load theirs, then save over theirs', async () => {
    const theirs = task({ name: 'Theirs', command: 'their cmd', updated: 'u2' })
    store.update.mockRejectedValueOnce(
      new RequestError(409, 'conflict', 'x', { task: theirs }),
    )
    const { onClose } = renderEditor(task())
    fireEvent.change(commandBox(), { target: { value: 'mine' } })
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Changed on another device',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load theirs' }))
    expect(nameBox()).toHaveValue('Theirs')
    expect(commandBox()).toHaveValue('their cmd')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Edit Theirs' })).toBeVisible()
    fireEvent.change(commandBox(), { target: { value: 'mine again' } })
    await save()
    expect(store.update).toHaveBeenLastCalledWith('a', {
      name: 'Theirs',
      command: 'mine again',
      updated: 'u2',
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('keep mine saves my text over theirs', async () => {
    store.update.mockRejectedValueOnce(
      new RequestError(409, 'conflict', 'x', { task: task({ updated: 'u2' }) }),
    )
    const { onClose } = renderEditor(task())
    fireEvent.change(commandBox(), { target: { value: 'mine' } })
    await save()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    })
    expect(store.update).toHaveBeenLastCalledWith('a', {
      name: 'Build',
      command: 'mine',
      updated: 'u2',
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('deleted on another device: save as new', async () => {
    store.update.mockRejectedValueOnce(new RequestError(404, 'not_found', 'x'))
    const { onClose } = renderEditor(task())
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Deleted on another device',
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save as new' }))
    })
    expect(store.create).toHaveBeenCalledWith({
      name: 'Build',
      command: 'make build',
    })
    expect(screen.queryByRole('dialog', { name: /^Edit/ })).toBeNull()
    expect(onClose).toHaveBeenCalled()
  })

  it('a refusal that is not the server code says it could not save', async () => {
    store.create.mockRejectedValue(new Error('offline'))
    renderEditor()
    fireEvent.change(nameBox(), { target: { value: 'n' } })
    fireEvent.change(commandBox(), { target: { value: 'c' } })
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not save the tasks',
    )
    expect(nameBox()).not.toHaveAttribute('aria-invalid')
    // A conflict without the task is no conflict to offer
    store.create.mockRejectedValue(new RequestError(409, 'conflict', 'x'))
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Changed on another device',
    )
    expect(screen.queryByRole('button', { name: 'Load theirs' })).toBeNull()
  })

  it('cancels', () => {
    const { onClose } = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
