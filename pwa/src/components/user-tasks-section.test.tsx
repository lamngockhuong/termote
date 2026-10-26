import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError, type UserTask } from '../hooks/use-mux-api'
import type { UserTasksState } from '../hooks/use-user-tasks'
import { UserTasksSection } from './user-tasks-section'

const store = vi.hoisted(() => ({
  state: {} as UserTasksState,
  refresh: vi.fn(async () => {}),
  remove: vi.fn(),
}))
vi.mock('../hooks/use-user-tasks', () => ({
  useUserTasks: () => ({
    ...store.state,
    refresh: store.refresh,
    remove: store.remove,
  }),
}))
vi.mock('./user-task-editor', () => ({
  UserTaskEditor: (p: { task: UserTask | null; onClose: () => void }) => (
    <div data-testid="editor">
      {p.task ? p.task.name : 'new'}
      <button type="button" onClick={p.onClose}>
        CloseEditor
      </button>
    </div>
  ),
}))

const task = (id: string, name: string, updated = 'u'): UserTask => ({
  id,
  name,
  command: `run ${name}`,
  updated,
})

function set(tasks: UserTask[], over: Partial<UserTasksState> = {}) {
  store.state = {
    tasks,
    readOnly: false,
    loaded: true,
    loading: false,
    error: false,
    ...over,
  }
}

const confirmDialog = () => screen.getByRole('dialog')
const click = (name: string | RegExp) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })

describe('UserTasksSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    set([task('1', 'Build'), task('2', 'De‮ploy')])
  })

  it('reads them again and lists them, with their hidden characters shown', () => {
    render(<UserTasksSection />)
    expect(store.refresh).toHaveBeenCalledTimes(1)
    const rows = within(
      screen.getByRole('list', { name: 'Tasks' }),
    ).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      'Buildrun BuildEditDelete',
      'De⟨U+202E⟩ploy' + 'run De⟨U+202E⟩ploy' + 'EditDelete',
    ])
    expect(
      screen.getByRole('button', { name: 'Edit De⟨U+202E⟩ploy' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('No tasks yet.')).toBeNull()
  })

  it('says when there are none, or they cannot be read', () => {
    set([])
    const { unmount } = render(<UserTasksSection />)
    expect(screen.getByText('No tasks yet.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Tasks' })).toBeNull()
    unmount()
    set([], { loaded: false, error: true })
    render(<UserTasksSection />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read the tasks',
    )
    expect(screen.queryByText('No tasks yet.')).toBeNull()
  })

  it('keeps the list when a later read fails', () => {
    set([task('1', 'Build')], { error: true })
    render(<UserTasksSection />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Build')).toBeInTheDocument()
  })

  it('opens the editor for a new one or one to change', () => {
    render(<UserTasksSection />)
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    expect(screen.getByTestId('editor')).toHaveTextContent('new')
    fireEvent.click(screen.getByRole('button', { name: 'CloseEditor' }))
    expect(screen.queryByTestId('editor')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Build' }))
    expect(screen.getByTestId('editor')).toHaveTextContent('Build')
  })

  it('a newer file only lists', () => {
    set([task('1', 'Build')], { readOnly: true })
    render(<UserTasksSection />)
    expect(screen.getByText(/Saved by a newer Termote/)).toBeInTheDocument()
    expect(screen.getByText('Build')).toBeInTheDocument()
    for (const name of [/^Edit/, /^Delete/, 'New task'])
      expect(screen.queryByRole('button', { name })).toBeNull()
  })

  it('deletes after asking, naming the version shown', async () => {
    store.remove.mockResolvedValue(undefined)
    render(<UserTasksSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Build' }))
    expect(confirmDialog()).toHaveAccessibleName('Delete Build?')
    expect(confirmDialog()).toHaveTextContent(
      'Every device of this server loses Build.',
    )
    await click('Delete')
    expect(store.remove).toHaveBeenCalledWith(task('1', 'Build'))
    expect(screen.getByRole('status')).toHaveTextContent('Deleted Build')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'New task' })).toHaveFocus()
  })

  it('cancelled, nothing is deleted', () => {
    render(<UserTasksSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Build' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('changed elsewhere: asks again with it as it is now', async () => {
    const now = task('1', 'Build', 'u2')
    store.remove
      .mockRejectedValueOnce(
        new RequestError(409, 'conflict', 'x', { task: now }),
      )
      .mockResolvedValueOnce(undefined)
    render(<UserTasksSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Build' }))
    await click('Delete')
    expect(confirmDialog()).toHaveAccessibleName(
      'Changed on another device: delete anyway?',
    )
    await click('Delete')
    expect(store.remove).toHaveBeenLastCalledWith(now)
    expect(store.remove).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status')).toHaveTextContent('Deleted Build')
  })

  it('a conflict that carries no task is told, not asked again', async () => {
    store.remove.mockRejectedValueOnce(new RequestError(409, 'conflict', 'x'))
    render(<UserTasksSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Build' }))
    await click('Delete')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Changed on another device',
    )
  })

  it('deleted elsewhere is deleted; another refusal is told', async () => {
    store.remove.mockRejectedValueOnce(new RequestError(404, 'not_found', 'x'))
    render(<UserTasksSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Build' }))
    await click('Delete')
    expect(screen.getByRole('status')).toHaveTextContent('Deleted Build')
    expect(store.refresh).toHaveBeenCalledTimes(2)
    store.remove.mockRejectedValueOnce(new RequestError(503, 'busy', 'x'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Build' }))
    await click('Delete')
    expect(screen.getByRole('alert')).toHaveTextContent('try again')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a failed delete says so', async () => {
    store.remove.mockRejectedValueOnce(new Error('offline'))
    render(<UserTasksSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Build' }))
    await click('Delete')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not save the tasks',
    )
  })

  it('opening the editor clears an old message', async () => {
    store.remove.mockRejectedValueOnce(new Error('offline'))
    render(<UserTasksSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Build' }))
    await click('Delete')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'CloseEditor' }))
    store.remove.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Build' }))
    await click('Delete')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Build' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
