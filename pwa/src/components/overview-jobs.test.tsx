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

function show(over: Partial<JobsState> = {}, readOnly = false, focus?: object) {
  store.state = loaded(over)
  const onOpenPane = vi.fn()
  const view = render(
    <OverviewJobs
      readOnly={readOnly}
      agents={AGENTS}
      onOpenPane={onOpenPane}
      focus={focus}
    />,
  )
  return { onOpenPane, ...view }
}

const plan = () => screen.getByRole('region', { name: 'Plan' })
const titles = (heading: string) =>
  within(screen.getByRole('heading', { name: heading }).parentElement!)
    .getAllByRole('article')
    .map((a) => a.getAttribute('aria-label'))

describe('OverviewJobs', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })

  it('groups the jobs by what they need from the user', () => {
    show()
    expect(plan()).toBeVisible()
    expect(titles('Waiting for you (1)')).toEqual(['job w'])
    expect(titles('Done, not read (1)')).toEqual(['job u'])
    expect(titles('Running (1)')).toEqual(['job r'])
    expect(titles('To review (1)')).toEqual(['job v'])
    expect(titles('To do (1)')).toEqual(['job t'])
    // Finished jobs are folded away
    expect(screen.queryByRole('article', { name: 'job d' })).toBeNull()
    const finished = screen.getByRole('button', { name: 'Finished (2)' })
    fireEvent.click(finished)
    expect(finished).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('article', { name: 'job d' })).toBeVisible()
    expect(screen.getByRole('article', { name: 'job f' })).toBeVisible()
    fireEvent.click(finished)
    expect(screen.queryByRole('article', { name: 'job d' })).toBeNull()
  })

  it("opens the pane of a job's agent the overview shows", () => {
    const { onOpenPane } = show()
    fireEvent.click(
      screen.getByRole('button', { name: 'Open pane web:claude' }),
    )
    expect(onOpenPane).toHaveBeenCalledWith('%1')
    // %7 is no agent the overview shows
    expect(screen.queryByRole('button', { name: 'Open pane x:y' })).toBeNull()
  })

  it('offers no way to change anything on a view-only device', () => {
    show({}, true)
    expect(within(plan()).queryByRole('button', { name: 'New job' })).toBeNull()
    expect(within(plan()).queryByRole('button', { name: /^Edit/ })).toBeNull()
    expect(within(plan()).queryByRole('button', { name: /^Grants/ })).toBeNull()
  })

  it('offers nothing to change in a ledger a newer Termote saved', () => {
    show({ readOnly: true })
    expect(within(plan()).queryByRole('button', { name: 'New job' })).toBeNull()
  })

  it('adds a job and edits one in its sheet', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'New job' }))
    expect(screen.getByRole('dialog', { name: 'New job' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit job v' }))
    expect(screen.getByRole('dialog', { name: 'Edit job v' })).toBeVisible()
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
    expect(
      screen.getByRole('button', { name: 'Grants of job w' }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Grants of job g' }),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Grants of job t' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Finished (2)' }))
    expect(screen.queryByRole('button', { name: 'Grants of job d' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Grants of job w' }))
    const sheet = screen.getByRole('dialog', { name: 'Grants of job w' })
    expect(within(sheet).getByRole('textbox')).toBeVisible()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
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

  it('brings its title into view when asked, once it shows', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    store.state = loaded({ loaded: false })
    const props = {
      readOnly: false,
      agents: AGENTS,
      onOpenPane: vi.fn(),
      focus: {},
    }
    const { rerender } = render(<OverviewJobs {...props} />)
    expect(scroll).not.toHaveBeenCalled()
    store.state = loaded()
    rerender(<OverviewJobs {...props} />)
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: 'Plan' })).toHaveFocus()
    // Asked again
    act(() => {
      rerender(<OverviewJobs {...props} focus={{}} />)
    })
    expect(scroll).toHaveBeenCalledTimes(2)
  })
})
