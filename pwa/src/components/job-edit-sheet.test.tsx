import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Job, RequestError } from '../hooks/use-mux-api'
import { renderWithLocale } from '../i18n/test-utils'
import { JobEditSheet, MAX_JOB_AFTER } from './job-edit-sheet'

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

  describe('priority, dependencies and workspace', () => {
    const FIELDS = ['priority', 'after', 'workspace'] as const
    const GROUPS = [
      { id: 'w1', name: 'acme-api' },
      { id: 'w2', name: 'web' },
    ]
    const JOBS = [
      job({ id: 'a', title: 'Fix login', state: 'todo', workspace: 'w1' }),
      job({ id: 'b', title: 'Write docs', state: 'todo' }),
      // Waits on a, and c on b: neither can be picked for a
      job({ id: 'c', title: 'Release', state: 'todo', after: ['a'] }),
      job({ id: 'd', title: 'Announce', state: 'review', after: ['c'] }),
      job({ id: 'e', title: 'Old work', state: 'done' }),
      job({ id: 'f', title: 'Dropped', state: 'abandoned' }),
    ]
    const edit = (j: Job | null, fields: readonly string[] = FIELDS) => {
      const onClose = vi.fn()
      render(
        <JobEditSheet
          job={j}
          agents={AGENTS}
          onClose={onClose}
          jobs={JOBS}
          groups={GROUPS}
          fields={fields as typeof FIELDS}
        />,
      )
      return { onClose }
    }
    const radio = (name: string) => screen.getByRole('radio', { name })
    const select = () => screen.getByRole('combobox', { name: 'Workspace' })
    const check = (name: string | RegExp) =>
      screen.getByRole('checkbox', { name })

    it('adds a job with its priority, the jobs it waits on and its workspace', async () => {
      edit(null)
      expect(radio('Normal')).toHaveAttribute('aria-checked', 'true')
      expect(select()).toHaveValue('')
      expect(select()).toBeEnabled()
      type('Title', 'New')
      fireEvent.click(radio('High'))
      fireEvent.click(check(/Write docs/))
      fireEvent.change(select(), { target: { value: 'w2' } })
      await click('Add')
      expect(store.add).toHaveBeenCalledWith({
        title: 'New',
        prompt: undefined,
        note: undefined,
        priority: 'high',
        after: ['b'],
        workspace: 'w2',
      })
    })

    it('sends each change alone, with the version read', async () => {
      edit(JOBS[0])
      // Not itself, not a finished job, and the jobs waiting on it disabled
      expect(screen.queryByRole('checkbox', { name: /Fix login/ })).toBeNull()
      expect(screen.queryByRole('checkbox', { name: /Old work/ })).toBeNull()
      expect(check(/Release/)).toBeDisabled()
      expect(check(/Release/)).toHaveAccessibleDescription('Waits on this job')
      expect(check(/Announce/)).toBeDisabled()
      expect(check(/Write docs/)).toBeEnabled()
      fireEvent.click(radio('Low'))
      await click('Save')
      expect(store.change).toHaveBeenLastCalledWith(JOBS[0], {
        priority: 'low',
      })
      fireEvent.click(radio('Normal'))
      fireEvent.click(check(/Write docs/))
      await click('Save')
      expect(store.change).toHaveBeenLastCalledWith(JOBS[0], { after: ['b'] })
      fireEvent.click(check(/Write docs/))
      fireEvent.change(select(), { target: { value: '' } })
      await click('Save')
      expect(store.change).toHaveBeenLastCalledWith(JOBS[0], { workspace: '' })
      // Nothing changed: nothing sent
      store.change.mockClear()
      fireEvent.change(select(), { target: { value: 'w1' } })
      await click('Save')
      expect(store.change).not.toHaveBeenCalled()
    })

    it('keeps a finished job it waits on, to be dropped', async () => {
      const j = job({ id: 'x', state: 'todo', after: ['e', 'b'] })
      edit(j)
      expect(check(/Old work/)).toBeChecked()
      // The same jobs in another order are no change
      fireEvent.click(check(/Write docs/))
      fireEvent.click(check(/Write docs/))
      await click('Save')
      expect(store.change).not.toHaveBeenCalled()
      fireEvent.click(check(/Old work/))
      await click('Save')
      expect(store.change).toHaveBeenCalledWith(j, { after: ['b'] })
    })

    it('finds a job by its title', () => {
      edit(job({ id: 'x', state: 'todo' }))
      const find = screen.getByRole('searchbox', {
        name: 'Find a job by its title',
      })
      fireEvent.change(find, { target: { value: 'DOCS' } })
      expect(screen.getAllByRole('checkbox').map((c) => c.id)).toHaveLength(1)
      expect(check(/Write docs/)).toBeVisible()
      fireEvent.change(find, { target: { value: 'zzz' } })
      expect(screen.getByText('No job matches')).toBeVisible()
    })

    it('tells when no other job is there to wait on', () => {
      render(
        <JobEditSheet
          job={null}
          agents={AGENTS}
          onClose={vi.fn()}
          jobs={[JOBS[4]]}
          fields={FIELDS}
        />,
      )
      expect(screen.getByText('No other unfinished job')).toBeVisible()
      expect(screen.queryByRole('searchbox')).toBeNull()
    })

    it(`picks ${MAX_JOB_AFTER} jobs at most`, () => {
      const many = Array.from({ length: MAX_JOB_AFTER + 1 }, (_, i) =>
        job({ id: `m${i}`, title: `Job ${i}`, state: 'todo' }),
      )
      const picked = many.slice(1, MAX_JOB_AFTER).map((j) => j.id)
      render(
        <JobEditSheet
          job={job({ id: 'x', state: 'todo', after: picked })}
          agents={AGENTS}
          onClose={vi.fn()}
          jobs={many}
          fields={FIELDS}
        />,
      )
      fireEvent.click(check('Job 0 To do'))
      expect(check(`Job ${MAX_JOB_AFTER} To do`)).toBeDisabled()
      expect(check('Job 0 To do')).toBeEnabled()
      expect(screen.getByText('A job waits on 20 jobs at most')).toBeVisible()
      fireEvent.click(check('Job 0 To do'))
      expect(check(`Job ${MAX_JOB_AFTER} To do`)).toBeEnabled()
    })

    it.each([
      ['an agent', { agent: { key: 'k', paneId: '%1', kind: 'claude' } }],
      ['a worktree', { worktree: { branch: 'b', base: 'main', dir: '/x' } }],
    ])('keeps the workspace of a job with %s', async (_, over) => {
      const j = job({ state: 'active', workspace: 'w9', ...over })
      edit(j)
      expect(select()).toBeDisabled()
      expect(select()).toHaveAccessibleDescription('Set when the job started')
      // Its id, as no open group is it
      expect(select()).toHaveDisplayValue('w9')
      fireEvent.click(radio('High'))
      await click('Save')
      expect(store.change).toHaveBeenCalledWith(j, { priority: 'high' })
    })

    it('lets a job to do without either change its workspace', () => {
      edit(job({ state: 'todo' }))
      expect(select()).toBeEnabled()
      expect(select()).not.toHaveAccessibleDescription()
    })

    it('changes what a job in review waits on', async () => {
      const j = job({
        id: 'r',
        state: 'review',
        agent: { key: 'k', paneId: '%1', kind: 'claude' },
      })
      edit(j)
      fireEvent.click(check(/Write docs/))
      await click('Save')
      expect(store.change).toHaveBeenCalledWith(j, { after: ['b'] })
    })

    it('hides the editors of the fields the server does not take', () => {
      edit(JOBS[0], ['priority'])
      expect(screen.getByRole('radiogroup', { name: 'Priority' })).toBeVisible()
      expect(screen.queryByRole('combobox', { name: 'Workspace' })).toBeNull()
      expect(screen.queryByRole('group', { name: 'Waits on' })).toBeNull()
    })

    it('shows the job as it is now after a change elsewhere', async () => {
      const theirs = job({
        ...JOBS[0],
        priority: 'high',
        after: ['b'],
        workspace: 'w2',
        updated: 'u2',
      })
      store.change.mockRejectedValueOnce(
        new RequestError(409, 'job_conflict', 'x', { job: theirs }),
      )
      edit(JOBS[0])
      fireEvent.click(radio('Low'))
      await click('Save')
      expect(radio('High')).toHaveAttribute('aria-checked', 'true')
      expect(check(/Write docs/)).toBeChecked()
      expect(select()).toHaveValue('w2')
    })

    it.each([
      ['job_cycle', 'These jobs would wait on each other'],
      ['job_after_missing', 'A job it waits on no longer exists'],
      ['job_workspace_unknown', 'No such workspace is open'],
      [
        'job_workspace_bound',
        'This job has an agent or a worktree: its workspace stays',
      ],
    ])('tells the refusal %s', async (code, words) => {
      store.change.mockRejectedValueOnce(new RequestError(409, code, 'x'))
      edit(JOBS[0])
      fireEvent.click(radio('High'))
      await click('Save')
      expect(screen.getByRole('alert')).toHaveTextContent(words)
    })

    it('tells the refusals in Vietnamese', async () => {
      store.change
        .mockRejectedValueOnce(new RequestError(409, 'job_cycle', 'x'))
        .mockRejectedValueOnce(
          new RequestError(409, 'job_workspace_bound', 'x'),
        )
      renderWithLocale(
        <JobEditSheet
          job={JOBS[0]}
          agents={AGENTS}
          onClose={vi.fn()}
          jobs={JOBS}
          groups={GROUPS}
          fields={FIELDS}
        />,
        'vi',
      )
      expect(
        screen.getByRole('radiogroup', { name: 'Mức ưu tiên' }),
      ).toBeVisible()
      expect(screen.getByRole('group', { name: 'Chờ các việc' })).toBeVisible()
      expect(
        screen.getByRole('option', { name: 'Không thuộc workspace nào' }),
      ).toBeInTheDocument()
      fireEvent.click(screen.getByRole('radio', { name: 'Cao' }))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
      })
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Các việc này sẽ chờ lẫn nhau',
      )
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
      })
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Việc này đã có agent hoặc worktree nên không đổi được workspace',
      )
    })
  })
})
