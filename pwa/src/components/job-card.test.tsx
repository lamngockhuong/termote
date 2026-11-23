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
  it('shows the brief data a view-only device gets, nothing to press', () => {
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
    expect(within(card()).getByText('web:claude')).toBeVisible()
    expect(within(card()).getByText('feat/x')).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names the pane of an agent the job had, and none without an agent', () => {
    const { rerender } = render(
      <JobCard job={job({ live: {}, agent })} now={NOW} />,
    )
    expect(within(card()).getByText('w:old')).toBeVisible()
    expect(within(card()).getByText('Active')).toBeVisible()
    rerender(<JobCard job={job({ live: {}, state: 'todo' })} now={NOW} />)
    expect(card().textContent).toBe('Fix loginTo do')
  })

  it.each([
    ['working', false, 'Working'],
    ['blocked', false, 'Waiting for an answer'],
    ['background', false, 'Waiting for background work'],
    ['idle', false, 'Idle'],
    ['idle', true, 'Turn ended, not read yet'],
    ['unknown', false, 'Could not be read'],
  ] as const)('tells a %s agent (unread %s)', (status, unread, words) => {
    render(<JobCard job={job({ live: { status, unread } })} now={NOW} />)
    expect(within(card()).getByText(words)).toBeVisible()
  })

  it("is one button opening a full client's details, with its counts", () => {
    const onSelect = vi.fn()
    const j = job({
      diff: { commits: 1, files: 3, at: ago(2) },
      grants: [grant(), grant({ id: 'g2', revoked: ago(1) })],
      worktree: { branch: 'feat/x', dir: '/w/x' },
    })
    const { rerender } = render(
      <JobCard job={j} now={NOW} onSelect={onSelect} />,
    )
    const open = within(card()).getByRole('button', { name: 'Fix login' })
    expect(within(card()).getAllByRole('button')).toHaveLength(1)
    expect(open).toHaveAttribute('aria-pressed', 'false')
    expect(open).toHaveAccessibleDescription(
      /Working.*web:claude.*feat\/x.*1 commit · 3 files · 1 grant/,
    )
    fireEvent.click(open)
    expect(onSelect).toHaveBeenCalledWith(j)
    rerender(<JobCard job={j} now={NOW} onSelect={onSelect} selected />)
    expect(open).toHaveAttribute('aria-pressed', 'true')
  })

  it('counts nothing a job has not, nor for a view-only device', () => {
    const j = job({
      diff: { commits: 2, files: 1, at: ago(2) },
      grants: [grant()],
    })
    const { rerender } = render(<JobCard job={j} now={NOW} />)
    expect(card()).not.toHaveTextContent('commit')
    expect(card()).not.toHaveTextContent('grant')
    rerender(<JobCard job={job()} now={NOW} onSelect={vi.fn()} />)
    expect(card()).not.toHaveTextContent('commit')
    expect(card()).not.toHaveTextContent('grant')
  })

  it.each([
    [false, 'job-ledger-case'],
    [true, 'main'],
  ])(
    'shows the worktree branch only while its agent works in it (outside %s)',
    (outsideWorktree, branch) => {
      render(
        <JobCard
          job={job({
            worktree: { branch: 'job-ledger-case', dir: '/wt/job-ledger-case' },
            live: {
              status: 'idle',
              paneId: '%1',
              branch: outsideWorktree ? 'main' : 'job-ledger-case',
              outsideWorktree,
            },
          })}
          now={NOW}
        />,
      )
      expect(within(card()).getByText(branch)).toBeInTheDocument()
    },
  )

  it('shows the hidden characters of the title and the branch', () => {
    render(
      <JobCard
        job={job({ title: 'Fix\u202elogin', branch: 'feat/\u200bx', live: {} })}
        now={NOW}
        onSelect={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Fix⟨U+202E⟩login' }),
    ).toHaveTextContent('Fix⟨U+202E⟩login')
    expect(screen.getByText('feat/⟨U+200B⟩x')).toBeInTheDocument()
  })
})
