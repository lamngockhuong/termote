import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Job, JobGrant } from '../hooks/use-mux-api'
import { JobCard } from './job-card'

const NOW = Date.parse('2026-11-23T10:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

const agent = { key: 'k', paneId: '%1', kind: 'claude', ref: 'w:old' }
const grant = (over: Partial<JobGrant> = {}): JobGrant => ({
  id: 'g1',
  agent,
  kind: 'bash',
  prefix: 'pnpm test',
  created: ago(30),
  expires: ago(-60),
  ...over,
})

const job = (over: Partial<Job> = {}): Job => ({
  id: 'a',
  title: 'Fix login',
  state: 'active',
  updated: 'u1',
  live: { status: 'working', paneId: '%1', ref: 'web:claude' },
  ...over,
})

const card = () => screen.getByRole('article', { name: 'Fix login' })

describe('JobCard', () => {
  it('shows the brief data a view-only device gets, nothing to change', () => {
    render(
      <JobCard
        job={{
          id: 'a',
          title: 'Fix login',
          state: 'review',
          updated: 'u',
          branch: 'feat/x',
          live: { status: 'gone', paneId: '%1', ref: 'web:claude' },
        }}
        now={NOW}
      />,
    )
    expect(within(card()).getByText('Review')).toBeInTheDocument()
    expect(within(card()).getByText('Agent no longer running')).toBeVisible()
    // No way to open a pane the overview does not show
    expect(within(card()).getByText('web:claude')).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
    expect(within(card()).getByText('feat/x')).toBeVisible()
  })

  it('opens the pane of its agent', () => {
    const onOpenPane = vi.fn()
    render(<JobCard job={job()} now={NOW} onOpenPane={onOpenPane} />)
    expect(within(card()).getByText('Working')).toBeVisible()
    fireEvent.click(
      screen.getByRole('button', { name: 'Open pane web:claude' }),
    )
    expect(onOpenPane).toHaveBeenCalledWith('%1')
  })

  it('names a pane it cannot open, and none for a job without an agent', () => {
    const { rerender } = render(
      <JobCard job={job({ live: {}, agent })} now={NOW} />,
    )
    expect(within(card()).getByText('w:old')).toBeVisible()
    expect(within(card()).getByText('Active')).toBeVisible()
    rerender(<JobCard job={job({ live: {}, state: 'todo' })} now={NOW} />)
    expect(card().textContent).toBe('Fix loginTo do')
  })

  it.each([
    ['blocked', false, 'Waiting for an answer'],
    ['background', false, 'Waiting for background work'],
    ['idle', false, 'Idle'],
    ['idle', true, 'Turn ended, not read yet'],
    ['unknown', false, 'Could not be read'],
  ] as const)('tells a %s agent (unread %s)', (status, unread, words) => {
    render(<JobCard job={job({ live: { status, unread } })} now={NOW} />)
    expect(within(card()).getByText(words)).toBeVisible()
  })

  it('shows the last diff and the grants in force', () => {
    render(
      <JobCard
        job={job({
          diff: { commits: 1, files: 3, at: ago(2) },
          grants: [
            grant(),
            grant({ id: 'g2', kind: 'edit', prefix: undefined }),
            grant({ id: 'g3', revoked: ago(1) }),
          ],
        })}
        now={NOW}
      />,
    )
    expect(within(card()).getByText(/1 commit · 3 files changed/)).toBeVisible()
    const grants = within(card()).getByRole('list', { name: 'Grants in force' })
    expect(
      within(grants)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual(['Run: pnpm test', 'Edit files in the worktree'])
  })

  it('opens the details of a full client: prompt, note, folder, answers, history', () => {
    render(
      <JobCard
        job={job({
          prompt: 'Do it\nwell',
          note: 'careful',
          worktree: { branch: 'feat/x', dir: '/w/x' },
          grants: [
            grant({
              uses: [
                { at: ago(10), command: 'pnpm test a' },
                { at: ago(2), path: 'src/a.ts' },
                { at: ago(5) },
              ],
            }),
            grant({ id: 'g2' }),
          ],
          events: [
            { at: ago(30), kind: 'created' },
            { at: ago(20), kind: 'state', text: 'review' },
            { at: ago(15), kind: 'state', text: 'weird' },
            { at: ago(12), kind: 'agent', text: 'w:t' },
            { at: ago(3), kind: 'future_kind' },
            { at: ago(-5), kind: 'constructor' },
          ],
        })}
        now={NOW}
      />,
    )
    const toggle = screen.getByRole('button', { name: 'Details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Do it/)).toHaveTextContent('Do it well')
    expect(screen.getByText('careful')).toBeVisible()
    expect(screen.getByText('/w/x')).toBeVisible()
    const answers = screen.getByText('Answered under a grant').parentElement!
    expect(
      within(answers)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual(['2 min agosrc/a.ts', '5 min ago', '10 min agopnpm test a'])
    const history = screen.getByText('History').parentElement!
    expect(
      within(history)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual([
      'just nowconstructor',
      '3 min agofuture_kind',
      '12 min agoGiven to an agent: w:t',
      '15 min agoState changed: weird',
      '20 min agoState changed: Review',
      '30 min agoAdded',
    ])
    fireEvent.click(toggle)
    expect(screen.queryByText('careful')).toBeNull()
  })

  it('has no details without any', () => {
    render(<JobCard job={job({ worktree: undefined })} now={NOW} />)
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  })

  it('offers Edit and Grants to a full client', () => {
    const onEdit = vi.fn()
    const onGrants = vi.fn()
    const j = job()
    render(<JobCard job={j} now={NOW} onEdit={onEdit} onGrants={onGrants} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Fix login' }))
    expect(onEdit).toHaveBeenCalledWith(j)
    fireEvent.click(screen.getByRole('button', { name: 'Grants of Fix login' }))
    expect(onGrants).toHaveBeenCalledWith(j)
  })
})
