import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobsState } from '../hooks/use-jobs'
import type { Job } from '../hooks/use-mux-api'
import { OverviewJobs } from './overview-jobs'

const store = vi.hoisted(() => ({ state: {} as JobsState }))
vi.mock('../hooks/use-jobs', () => ({
  useJobs: () => store.state,
  useCurrentJob: (j: Job) => j,
  addJob: vi.fn(),
  changeJob: vi.fn(),
  removeJob: vi.fn(),
  grantJob: vi.fn(),
  revokeJobGrant: vi.fn(),
}))

const agent = { key: 'k', paneId: '%1', kind: 'claude' }
const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  title: `job ${id}`,
  state: 'todo',
  updated: 'u',
  live: {},
  ...over,
})

const JOBS = [
  job('w', {
    state: 'active',
    agent,
    live: { status: 'blocked', paneId: '%1', ref: 'web:claude' },
  }),
  job('u', {
    state: 'active',
    live: { status: 'idle', unread: true, paneId: '%7', ref: 'x:y' },
  }),
  job('r', {
    state: 'active',
    agent,
    live: { status: 'working', paneId: '%1' },
  }),
  job('v', { state: 'review' }),
  job('t'),
  job('d', { state: 'done', agent }),
  job('f', { state: 'failed' }),
]

const AGENTS = [{ paneId: '%1', name: 'Claude Code', place: 'web' }]

function loaded(over: Partial<JobsState> = {}): JobsState {
  return {
    jobs: JOBS,
    readOnly: false,
    canGrant: true,
    clockOffset: 0,
    loaded: true,
    error: false,
    unavailable: false,
    ...over,
  }
}

function show(
  over: Partial<JobsState> = {},
  readOnly = false,
  focus?: object,
  extra: Partial<Parameters<typeof OverviewJobs>[0]> = {},
) {
  store.state = loaded(over)
  const onOpenPane = vi.fn()
  const view = render(
    <OverviewJobs
      readOnly={readOnly}
      agents={AGENTS}
      onOpenPane={onOpenPane}
      focus={focus}
      {...extra}
    />,
  )
  return { onOpenPane, ...view }
}

const plan = () => screen.getByRole('region', { name: 'Plan' })
const column = (heading: string) =>
  screen.getByRole('heading', { name: heading }).parentElement!
const titles = (heading: string) =>
  within(column(heading))
    .getAllByRole('article')
    .map((a) => a.getAttribute('aria-label'))
const pick = (title: string) =>
  fireEvent.click(
    within(screen.getByRole('article', { name: title })).getByRole('button'),
  )
const finished = () => screen.getByRole('button', { name: /^Finished · / })

describe('OverviewJobs', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.removeAttribute('open')
    })
  })

  it('groups the jobs by what they need from the user', () => {
    show()
    expect(plan()).toBeVisible()
    expect(titles('Waiting for you · 1')).toEqual(['job w'])
    expect(titles('Done, not read · 1')).toEqual(['job u'])
    expect(titles('Running · 1')).toEqual(['job r'])
    expect(titles('To review · 1')).toEqual(['job v'])
    expect(titles('To do · 1')).toEqual(['job t'])
    expect(screen.getByText('5 open jobs')).toBeVisible()
    // Finished jobs are folded away, in a table
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.click(finished())
    expect(finished()).toHaveAttribute('aria-expanded', 'true')
    const table = screen.getByRole('table', { name: 'Finished jobs' })
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['job d', 'job f'])
    fireEvent.click(finished())
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('always shows Waiting for you, and names the empty groups in one line', () => {
    show({ jobs: [job('t'), job('v', { state: 'review' })] })
    expect(column('Waiting for you · 0')).toHaveTextContent(
      'No job waits for you',
    )
    expect(screen.queryByRole('heading', { name: /^Running/ })).toBeNull()
    // Above the columns, with the groups that have no job
    expect(screen.getByText('2 open jobs', { exact: false })).toHaveTextContent(
      '2 open jobs · Done, not read 0 · Running 0',
    )
  })

  it('leaves out the finished columns no job has a value for', () => {
    show({
      jobs: [
        job('d', { state: 'done' }),
        job('f', {
          state: 'failed',
          branch: 'feat/\u202ex',
          diff: { commits: 2, files: 1, at: 'x' },
          updated: '2026-01-01T00:00:00Z',
        }),
      ],
    })
    fireEvent.click(finished())
    const table = screen.getByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Job', 'State', 'Worktree', 'Changes', 'Updated'])
    expect(within(table).getByText('feat/⟨U+202E⟩x')).toBeVisible()
    expect(within(table).getByText('2 commits · 1 file changed')).toBeVisible()
  })

  it('opens the details of a job in a sheet, the editor and grants from there', () => {
    show()
    pick('job w')
    expect(
      within(screen.getByRole('article', { name: 'job w' })).getByRole(
        'button',
      ),
    ).toHaveAttribute('aria-pressed', 'true')
    const details = screen.getByRole('dialog', { name: 'job w' })
    fireEvent.click(
      within(details).getByRole('button', { name: 'Grants of job w' }),
    )
    // One modal at a time: the details step aside for the grants
    expect(screen.queryByRole('dialog', { name: 'job w' })).toBeNull()
    const grants = screen.getByRole('dialog', { name: 'Grants of job w' })
    fireEvent.click(within(grants).getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('dialog', { name: 'job w' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Edit job w' }))
    expect(screen.getByRole('dialog', { name: 'Edit job w' })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'job w' })).toBeNull()
    // The same card again closes the details, as does the sheet's close
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    pick('job w')
    expect(screen.queryByRole('dialog', { name: 'job w' })).toBeNull()
    pick('job w')
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'job w' })).getByRole(
        'button',
        { name: 'Close the details' },
      ),
    )
    expect(screen.queryByRole('dialog', { name: 'job w' })).toBeNull()
    expect(
      within(screen.getByRole('article', { name: 'job w' })).getByRole(
        'button',
      ),
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps a column, and the focus on its card, when its count changes', () => {
    const props = { readOnly: false, agents: AGENTS, onOpenPane: vi.fn() }
    store.state = loaded()
    const { rerender } = render(<OverviewJobs {...props} />)
    const button = within(
      screen.getByRole('article', { name: 'job r' }),
    ).getByRole('button')
    act(() => button.focus())
    store.state = loaded({
      jobs: [
        ...JOBS,
        job('r2', { state: 'active', live: { status: 'working' } }),
      ],
    })
    rerender(<OverviewJobs {...props} />)
    expect(titles('Running · 2')).toEqual(['job r', 'job r2'])
    expect(button).toHaveFocus()
  })

  it('opens a finished job from its row', () => {
    show()
    fireEvent.click(finished())
    const row = screen.getByRole('button', { name: 'job d' })
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-pressed', 'true')
    const details = screen.getByRole('dialog', { name: 'job d' })
    // Finished: nothing to grant
    expect(
      within(details).queryByRole('button', { name: 'Grants of job d' }),
    ).toBeNull()
    expect(
      within(details).getByRole('button', { name: 'Edit job d' }),
    ).toBeVisible()
  })

  it('offers grants for an unfinished job with an agent or grants', () => {
    show({
      jobs: [
        ...JOBS,
        job('g', {
          state: 'review',
          grants: [
            {
              id: 'g1',
              agent,
              kind: 'edit',
              created: 'c',
              expires: '2000-01-01T00:00:00Z',
            },
          ],
        }),
      ],
    })
    const grantsIn = (title: string) => {
      pick(title)
      const found = within(
        screen.getByRole('dialog', { name: title }),
      ).queryByRole('button', { name: `Grants of ${title}` })
      pick(title)
      return found
    }
    expect(grantsIn('job w')).not.toBeNull()
    expect(grantsIn('job g')).not.toBeNull()
    expect(grantsIn('job t')).toBeNull()
  })

  it("opens the pane of a job's agent the overview shows", () => {
    const { onOpenPane } = show()
    pick('job w')
    fireEvent.click(
      screen.getByRole('button', { name: 'Open pane web:claude' }),
    )
    expect(onOpenPane).toHaveBeenCalledWith('%1')
    pick('job w')
    // %7 is no agent the overview shows
    pick('job u')
    expect(screen.getByRole('dialog', { name: 'job u' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Open pane x:y' })).toBeNull()
  })

  it('offers no way to change or open anything on a view-only device', () => {
    show(
      {
        jobs: [
          job('w', {
            state: 'active',
            live: { status: 'blocked', paneId: '%1', ref: 'web:claude' },
          }),
          job('d', { state: 'done' }),
        ],
      },
      true,
    )
    expect(within(plan()).queryByRole('button', { name: 'New job' })).toBeNull()
    expect(
      within(screen.getByRole('article', { name: 'job w' })).queryByRole(
        'button',
      ),
    ).toBeNull()
    fireEvent.click(finished())
    expect(within(screen.getByRole('table')).queryByRole('button')).toBeNull()
    expect(
      within(screen.getByRole('table'))
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Job', 'State'])
  })

  it('offers nothing to change in a ledger a newer Termote saved', () => {
    show({ readOnly: true })
    expect(within(plan()).queryByRole('button', { name: 'New job' })).toBeNull()
    expect(
      within(screen.getByRole('article', { name: 'job t' })).queryByRole(
        'button',
      ),
    ).toBeNull()
  })

  it('adds a job in its sheet', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'New job' }))
    expect(screen.getByRole('dialog', { name: 'New job' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes the details of a job gone, unless its editor is open', () => {
    const props = { readOnly: false, agents: AGENTS, onOpenPane: vi.fn() }
    store.state = loaded()
    const { rerender } = render(<OverviewJobs {...props} />)
    pick('job v')
    expect(screen.getByRole('dialog', { name: 'job v' })).toBeVisible()
    store.state = loaded({ jobs: JOBS.filter((j) => j.id !== 'v') })
    rerender(<OverviewJobs {...props} />)
    expect(screen.queryByRole('dialog', { name: 'job v' })).toBeNull()
    // With its editor open, the editor stays to say the job is gone
    store.state = loaded()
    rerender(<OverviewJobs {...props} />)
    pick('job t')
    fireEvent.click(screen.getByRole('button', { name: 'Edit job t' }))
    store.state = loaded({ jobs: JOBS.filter((j) => j.id !== 't') })
    rerender(<OverviewJobs {...props} />)
    expect(screen.getByRole('dialog', { name: 'Edit job t' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the details beside the columns on a wide screen, making room with the Activity', () => {
    const onCloseActivity = vi.fn()
    const props = {
      readOnly: false,
      agents: AGENTS,
      onOpenPane: vi.fn(),
      wide: true,
      onCloseActivity,
    }
    store.state = loaded()
    const { rerender } = render(
      <OverviewJobs {...props} activityOpen={false} />,
    )
    pick('job w')
    const aside = screen.getByRole('complementary', { name: 'job w' })
    expect(onCloseActivity).toHaveBeenCalledTimes(1)
    // Not a modal: no dialog
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(aside).getByRole('button', { name: 'Edit job w' }))
    expect(screen.getByRole('dialog', { name: 'Edit job w' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(
      within(aside).getByRole('button', { name: 'Close the details' }),
    )
    expect(screen.queryByRole('complementary')).toBeNull()
    // The Activity opened: the details close
    pick('job w')
    expect(screen.getByRole('complementary', { name: 'job w' })).toBeVisible()
    rerender(<OverviewJobs {...props} activityOpen />)
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('shows the hidden characters of a title in its card, row and details', () => {
    show({
      jobs: [
        job('x', { title: 'a\u202eb', state: 'todo' }),
        job('y', { title: 'c\u200bd', state: 'done' }),
      ],
    })
    pick('a⟨U+202E⟩b')
    expect(screen.getByRole('dialog', { name: 'a⟨U+202E⟩b' })).toBeVisible()
    pick('a⟨U+202E⟩b')
    fireEvent.click(finished())
    expect(screen.getByRole('button', { name: 'c⟨U+200B⟩d' })).toBeVisible()
  })

  it('tells an empty plan and one with every job finished', () => {
    const { unmount } = show({ jobs: [] })
    expect(screen.getByText(/No job yet/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /Finished/ })).toBeNull()
    unmount()
    show({ jobs: [job('d', { state: 'done' })] })
    expect(screen.getByText('Every job is finished')).toBeVisible()
  })

  it('shows nothing before the first read, nor on a server without a ledger', () => {
    const { container, unmount } = show({ loaded: false })
    expect(container).toBeEmptyDOMElement()
    unmount()
    const again = show({ unavailable: true, error: true })
    expect(again.container).toBeEmptyDOMElement()
  })

  it('tells a failed read, over the last jobs read or none', () => {
    const { unmount } = show({ error: true })
    expect(screen.getByRole('status')).toHaveTextContent(
      'Could not read the plan',
    )
    expect(screen.getByRole('article', { name: 'job t' })).toBeVisible()
    unmount()
    show({ error: true, loaded: false, jobs: [] })
    expect(screen.getByRole('status')).toBeVisible()
    expect(screen.queryByText(/No job yet/)).toBeNull()
  })

  it('brings its title into view when asked, once it shows, and says so', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    store.state = loaded({ loaded: false })
    const onFocused = vi.fn()
    const props = {
      readOnly: false,
      agents: AGENTS,
      onOpenPane: vi.fn(),
      focus: {},
      onFocused,
    }
    const { rerender } = render(<OverviewJobs {...props} />)
    expect(scroll).not.toHaveBeenCalled()
    store.state = loaded()
    rerender(<OverviewJobs {...props} />)
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(onFocused).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: 'Plan' })).toHaveFocus()
    // Asked again
    act(() => {
      rerender(<OverviewJobs {...props} focus={{}} />)
    })
    expect(scroll).toHaveBeenCalledTimes(2)
  })
})
