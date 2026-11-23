import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRevoke } = vi.hoisted(() => ({ mockRevoke: vi.fn() }))
vi.mock('../hooks/use-jobs', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-jobs')>()),
  revokeJobGrant: (...a: unknown[]) => mockRevoke(...a),
}))

import { type Job, type JobGrant, RequestError } from '../hooks/use-mux-api'
import { JobDetail } from './job-detail'

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

// A field's value, beside its name
const value = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement

describe('JobDetail', () => {
  it('shows the pull requests only where the server follows them, and what a ci grant sent', () => {
    const j = job({
      agent,
      ci: {
        prs: [
          { number: 12, repo: 'github.com/o/r', state: 'open', checks: 'fail' },
        ],
      },
      grants: [
        grant({
          kind: 'ci',
          prefix: undefined,
          uses: [{ at: ago(3), command: '12@abc,15@def' }],
        }),
      ],
      events: [{ at: ago(3), kind: 'ci_sent', text: 'sent CI failure of #12' }],
    })
    const { rerender } = render(<JobDetail job={j} now={NOW} />)
    expect(screen.queryByTestId('job-ci')).toBeNull()
    expect(screen.getByText('Sent on their own: #12, #15')).toBeVisible()
    expect(screen.getByText('Failed checks sent to the agent')).toBeVisible()
    rerender(<JobDetail job={j} now={NOW} ciAvailable />)
    expect(screen.getByTestId('job-ci')).toBeVisible()
  })

  it('shows every field a full client gets: prompt, note, folder, answers, history', () => {
    render(
      <JobDetail
        job={job({
          agent,
          prompt: 'Do it\nwell',
          note: 'careful',
          worktree: { branch: 'feat/x', dir: '/w/x' },
          diff: { commits: 2, files: 1, at: ago(2) },
          grants: [
            grant({
              uses: [
                { at: ago(10), command: 'pnpm test a' },
                { at: ago(2), path: 'src/a.ts' },
                { at: ago(5) },
              ],
            }),
            grant({ id: 'g2', kind: 'edit', prefix: undefined }),
            grant({ id: 'g3', revoked: ago(1) }),
          ],
          events: [
            { at: ago(30), kind: 'created' },
            { at: ago(20), kind: 'state', text: 'review' },
            { at: ago(15), kind: 'state', text: 'weird' },
            { at: ago(12), kind: 'agent', text: 'w:t' },
            { at: ago(3), kind: 'future_kind' },
            { at: ago(-5), kind: 'constructor' },
          ],
          updated: ago(4),
        })}
        now={NOW}
      />,
    )
    const field = (label: string) =>
      screen.getByRole('heading', { name: label }).parentElement!
    expect(screen.getByText('Working').parentElement).toHaveTextContent(
      'Working · 4 min ago',
    )
    expect(value('State')).toHaveTextContent('Active')
    expect(value('Agent')).toHaveTextContent('Claude Code · w:old')
    expect(value('Branch')).toHaveTextContent('feat/x')
    expect(value('Folder')).toHaveTextContent('/w/x')
    expect(value('Changes')).toHaveTextContent('2 commits · 1 file changed')
    expect(field('Prompt')).toHaveTextContent('Do it well')
    expect(field('Note')).toHaveTextContent('careful')
    expect(
      within(field('Grants in force'))
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual([
      'Run: pnpm testEnds in 1 h · used 3 times',
      'Edit files in the worktreeEnds in 1 h · used 0 times',
    ])
    expect(
      within(field('Answered under a grant'))
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual(['src/a.ts2 min ago', '5 min ago', 'pnpm test a10 min ago'])
    expect(
      within(field('History'))
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual([
      'constructorjust now',
      'future_kind3 min ago',
      'Given to an agent: w:t12 min ago',
      'State changed: weird15 min ago',
      'State changed: Review20 min ago',
      'Added30 min ago',
    ])
  })

  it('draws no field it has no data for, and no button it is not given', () => {
    render(
      <JobDetail
        job={job({ live: {}, state: 'todo', updated: 'u' })}
        now={NOW}
      />,
    )
    expect(screen.queryByRole('heading')).toBeNull()
    expect(
      [...document.querySelectorAll('dt')].map((d) => d.textContent),
    ).toEqual(['State'])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names an agent it does not know by the kind the server recorded', () => {
    render(
      <JobDetail
        job={job({ agent: { key: 'k', paneId: '%3', kind: 'ai\u202eder' } })}
        now={NOW}
      />,
    )
    expect(value('Agent')).toHaveTextContent('ai⟨U+202E⟩der · %3')
  })

  it("shows a job's pane folder and branch when it has no worktree", () => {
    render(
      <JobDetail
        job={job({
          live: {
            status: 'idle',
            paneId: '%1',
            dir: '/src/web',
            branch: 'main',
          },
        })}
        now={NOW}
      />,
    )
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('/src/web')).toBeInTheDocument()
  })

  it("shows its agent's pane folder and branch once it left the worktree", () => {
    render(
      <JobDetail
        job={job({
          worktree: { branch: 'job-x', dir: '/wt/job-x' },
          live: {
            status: 'idle',
            paneId: '%1',
            dir: '/src/termote',
            branch: 'main',
            outsideWorktree: true,
          },
        })}
        now={NOW}
      />,
    )
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('/src/termote')).toBeInTheDocument()
    expect(screen.queryByText('/wt/job-x')).toBeNull()
  })

  it('counts the grants in force on its Grants button', () => {
    render(
      <JobDetail
        job={job({ grants: [grant(), grant({ id: 'g2' })] })}
        now={NOW}
        onGrants={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Grants of Fix login' }),
    ).toHaveTextContent('Grants · 2')
  })

  it('opens the pane, the grants and the editor', () => {
    const onOpenPane = vi.fn()
    const onEdit = vi.fn()
    const onGrants = vi.fn()
    const j = job()
    render(
      <JobDetail
        job={j}
        now={NOW}
        onOpenPane={onOpenPane}
        onEdit={onEdit}
        onGrants={onGrants}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Open pane web:claude' }),
    )
    expect(onOpenPane).toHaveBeenCalledWith('%1')
    fireEvent.click(screen.getByRole('button', { name: 'Grants of Fix login' }))
    expect(onGrants).toHaveBeenCalledWith(j)
    // No grant in force: the button says Grants alone
    expect(
      screen.getByRole('button', { name: 'Grants of Fix login' }),
    ).toHaveTextContent(/^Grants$/)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Fix login' }))
    expect(onEdit).toHaveBeenCalledWith(j)
  })

  it('shows the hidden characters of the title, branch, folder, prompt and note', () => {
    render(
      <JobDetail
        job={job({
          title: 'Fix\u202elogin',
          prompt: 'a\u200bb',
          note: 'c\u2066d',
          worktree: { branch: 'b\u202er', dir: '/w\u200b' },
        })}
        now={NOW}
        onEdit={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Edit Fix⟨U+202E⟩login' }),
    ).toBeInTheDocument()
    expect(screen.getByText('b⟨U+202E⟩r')).toBeInTheDocument()
    expect(screen.getByText('/w⟨U+200B⟩')).toBeInTheDocument()
    expect(screen.getByText('a⟨U+200B⟩b')).toBeInTheDocument()
    expect(screen.getByText('c⟨U+2066⟩d')).toBeInTheDocument()
  })

  describe('ending a grant', () => {
    beforeEach(() => {
      mockRevoke.mockReset()
      HTMLDialogElement.prototype.showModal = vi.fn(function (
        this: HTMLDialogElement,
      ) {
        this.setAttribute('open', '')
      })
      HTMLDialogElement.prototype.close = vi.fn()
    })
    const endButton = () =>
      screen.queryByRole('button', { name: 'End the grant Run: pnpm test' })
    const confirm = async () => {
      fireEvent.click(endButton()!)
      const dialog = screen.getByRole('dialog', { name: 'End this grant?' })
      expect(dialog).toHaveTextContent('Run: pnpm test')
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'End' }))
      })
    }

    it('offers End only where this browser may end grants', () => {
      const { rerender } = render(
        <JobDetail job={job({ grants: [grant()] })} now={NOW} />,
      )
      expect(endButton()).toBeNull()
      rerender(
        <JobDetail job={job({ grants: [grant()] })} now={NOW} canEndGrants />,
      )
      expect(endButton()).toBeInTheDocument()
    })

    it('ends a grant once confirmed, and says so', async () => {
      mockRevoke.mockResolvedValue(undefined)
      const j = job({ grants: [grant()] })
      render(<JobDetail job={j} now={NOW} canEndGrants />)
      // Cancel ends nothing
      fireEvent.click(endButton()!)
      fireEvent.click(
        within(
          screen.getByRole('dialog', { name: 'End this grant?' }),
        ).getByRole('button', { name: 'Cancel' }),
      )
      expect(mockRevoke).not.toHaveBeenCalled()
      await confirm()
      expect(mockRevoke).toHaveBeenCalledWith(j, 'g1')
      expect(screen.getByRole('status')).toHaveTextContent('The grant ended')
    })

    it('tells a refused end, in the server words or its own', async () => {
      mockRevoke.mockRejectedValueOnce(
        new RequestError(404, 'grant_not_found', 'x'),
      )
      render(
        <JobDetail job={job({ grants: [grant()] })} now={NOW} canEndGrants />,
      )
      await confirm()
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This grant no longer exists',
      )
      mockRevoke.mockRejectedValueOnce(new Error('offline'))
      await confirm()
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not change the grants',
      )
      // A later end that works clears the refusal
      mockRevoke.mockResolvedValueOnce(undefined)
      await confirm()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByRole('status')).toHaveTextContent('The grant ended')
    })
  })
})
