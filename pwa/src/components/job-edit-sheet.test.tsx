import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Job, RequestError } from '../hooks/use-mux-api'
import { JobEditSheet } from './job-edit-sheet'

const store = vi.hoisted(() => ({
  add: vi.fn(),
  change: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('../hooks/use-jobs', () => ({
  addJob: store.add,
  changeJob: store.change,
  removeJob: store.remove,
}))

const AGENTS = [
  { paneId: '%1', name: 'Claude Code', place: 'web / claude' },
  { paneId: '%2', name: 'Codex', place: 'api / codex' },
]

const job = (over: Partial<Job> = {}): Job => ({
  id: 'a',
  title: 'Fix login',
  prompt: 'Do it',
  state: 'active',
  updated: 'u1',
  live: {},
  ...over,
})

function open(j: Job | null = null) {
  const onClose = vi.fn()
  render(<JobEditSheet job={j} agents={AGENTS} onClose={onClose} />)
  return { onClose }
}

const box = (name: string) => screen.getByRole('textbox', { name })
const type = (name: string, value: string) =>
  fireEvent.change(box(name), { target: { value } })
const click = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })

describe('JobEditSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    store.add.mockResolvedValue(job())
    store.change.mockResolvedValue(job())
    store.remove.mockResolvedValue(undefined)
  })

  it('adds a todo job, with no state or agent to pick', async () => {
    const { onClose } = open()
    expect(screen.getByRole('dialog', { name: 'New job' })).toBeVisible()
    expect(box('Title')).toHaveFocus()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    type('Title', '  Write docs ')
    await click('Add')
    expect(store.add).toHaveBeenCalledWith({
      title: 'Write docs',
      prompt: undefined,
      note: undefined,
    })
    expect(onClose).toHaveBeenCalled()
    type('Prompt', 'p')
    type('Note', 'n')
    await click('Add')
    expect(store.add).toHaveBeenLastCalledWith({
      title: 'Write docs',
      prompt: 'p',
      note: 'n',
    })
  })

  it('checks the title first', async () => {
    open()
    await click('Add')
    expect(screen.getByRole('alert')).toHaveTextContent('Give the job a title')
    type('Title', 'x'.repeat(201))
    await click('Add')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The title is longer than 200 characters',
    )
    expect(box('Title')).toHaveFocus()
    expect(store.add).not.toHaveBeenCalled()
  })

  it('sends only what changed, with the version read', async () => {
    const j = job({
      agent: { key: 'k', paneId: '%9', kind: 'claude' },
      grants: [
        {
          id: 'g',
          agent: { key: 'k', paneId: '%9', kind: 'claude' },
          kind: 'bash',
          prefix: 'pnpm test',
          created: 'c',
          expires: 'e',
        },
      ],
    })
    const { onClose } = open(j)
    expect(screen.getByRole('dialog', { name: 'Edit Fix login' })).toBeVisible()
    // Nothing changed: nothing sent
    await click('Save')
    expect(store.change).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)

    type('Title', 'Fix the login')
    type('Prompt', 'Do it now')
    type('Note', 'n')
    fireEvent.change(screen.getByRole('combobox', { name: 'State' }), {
      target: { value: 'review' },
    })
    const pane = screen.getByRole('combobox', { name: 'Agent' })
    expect(pane).toHaveDisplayValue('Keep the agent it has')
    expect(screen.queryByText(/ends every grant/)).toBeNull()
    fireEvent.change(pane, { target: { value: '%2' } })
    expect(screen.getByRole('status')).toHaveTextContent(
      'Giving the job to another agent ends every grant it has',
    )
    await click('Save')
    expect(store.change).toHaveBeenCalledWith(j, {
      title: 'Fix the login',
      prompt: 'Do it now',
      note: 'n',
      state: 'review',
      pane: '%2',
    })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('gives a job to an agent, nothing else changed', async () => {
    const j = job({ prompt: undefined, note: 'n0' })
    open(j)
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), {
      target: { value: '%1' },
    })
    // No grant to end
    expect(screen.queryByRole('status')).toBeNull()
    await click('Save')
    expect(store.change).toHaveBeenCalledWith(j, { pane: '%1' })
  })

  it('shows a job without prompt or note as it is now', async () => {
    store.change.mockRejectedValueOnce(
      new RequestError(409, 'job_conflict', 'x', {
        job: job({ prompt: undefined, updated: 'u2' }),
      }),
    )
    open(job({ note: 'mine' }))
    type('Title', 'Mine')
    await click('Save')
    expect(box('Prompt')).toHaveValue('')
    expect(box('Note')).toHaveValue('')
  })

  it('offers an agent to a job without one', () => {
    open(job({ prompt: undefined, state: 'todo' }))
    expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveDisplayValue(
      'No agent yet',
    )
    expect(
      screen.getByRole('option', { name: 'Codex · api / codex' }),
    ).toBeInTheDocument()
  })

  it('shows the job as it is now after a change elsewhere', async () => {
    const theirs = job({ title: 'Theirs', note: 'their note', updated: 'u2' })
    store.change.mockRejectedValueOnce(
      new RequestError(409, 'job_conflict', 'x', { job: theirs }),
    )
    const { onClose } = open(job())
    type('Title', 'Mine')
    await click('Save')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The job was changed elsewhere meanwhile. This is how it is now',
    )
    expect(box('Title')).toHaveValue('Theirs')
    expect(box('Note')).toHaveValue('their note')
    type('Title', 'Mine again')
    await click('Save')
    expect(store.change).toHaveBeenLastCalledWith(theirs, {
      title: 'Mine again',
    })
  })

  it('tells a refusal, and stops saving a job removed elsewhere', async () => {
    store.change
      .mockRejectedValueOnce(new RequestError(409, 'job_conflict', 'x'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new RequestError(404, 'job_not_found', 'x'))
    open(job())
    type('Title', 'Mine')
    await click('Save')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The job was changed elsewhere meanwhile',
    )
    await click('Save')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not save the job',
    )
    await click('Save')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This job no longer exists',
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('deletes the job once confirmed', async () => {
    const j = job()
    const { onClose } = open(j)
    await click('Delete')
    expect(
      screen.getByRole('dialog', { name: 'Delete Fix login?' }),
    ).toBeVisible()
    const cancel = screen.getAllByRole('button', { name: 'Cancel' })
    await act(async () => {
      fireEvent.click(cancel[cancel.length - 1])
    })
    expect(store.remove).not.toHaveBeenCalled()
    await click('Delete')
    const confirm = screen.getAllByRole('button', { name: 'Delete' })
    await act(async () => {
      fireEvent.click(confirm[confirm.length - 1])
    })
    expect(store.remove).toHaveBeenCalledWith(j)
    expect(onClose).toHaveBeenCalled()
  })

  it('tells why a delete was refused', async () => {
    store.remove.mockRejectedValueOnce(new RequestError(409, 'busy', 'x'))
    const { onClose } = open(job())
    await click('Delete')
    const confirm = screen.getAllByRole('button', { name: 'Delete' })
    await act(async () => {
      fireEvent.click(confirm[confirm.length - 1])
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Another change is still running',
    )
  })
})
