import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Job, type JobGrant, RequestError } from '../hooks/use-mux-api'
import { setCurrentMachineForTest } from '../utils/api-base'
import { JobGrantSheet } from './job-grant-sheet'

const store = vi.hoisted(() => ({
  grant: vi.fn(),
  revoke: vi.fn(),
  current: vi.fn(),
}))
vi.mock('../hooks/use-jobs', () => ({
  grantJob: store.grant,
  revokeJobGrant: store.revoke,
  useCurrentJob: (j: Job) => store.current(j) ?? j,
}))

const NOW = Date.parse('2026-11-23T10:00:00Z')
const later = (min: number) => new Date(NOW + min * 60_000).toISOString()
const agent = { key: 'k', paneId: '%1', kind: 'claude', ref: 'web:claude' }

const grant = (over: Partial<JobGrant> = {}): JobGrant => ({
  id: 'g1',
  agent,
  kind: 'bash',
  prefix: 'pnpm test',
  created: later(-10),
  expires: later(90),
  ...over,
})

const job = (over: Partial<Job> = {}): Job => ({
  id: 'a',
  title: 'Fix login',
  state: 'active',
  updated: 'u1',
  agent,
  live: { status: 'working', paneId: '%1', ref: 'web:claude' },
  ...over,
})

function open(j: Job = job(), canGrant = true, ciAvailable = false) {
  const onClose = vi.fn()
  render(
    <JobGrantSheet
      job={j}
      canGrant={canGrant}
      ciAvailable={ciAvailable}
      now={NOW}
      onClose={onClose}
    />,
  )
  return { onClose }
}

const prefixBox = () => screen.getByRole('textbox', { name: 'Command prefix' })
const typePrefix = (value: string) =>
  fireEvent.change(prefixBox(), { target: { value } })
const give = () =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Give the grant' }))
  })

describe('JobGrantSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    store.grant.mockResolvedValue(job())
    store.revoke.mockResolvedValue(job())
  })

  it('gives a grant to run a prefix the user typed, for as long as asked', async () => {
    open()
    expect(
      screen.getByRole('dialog', { name: 'Grants of Fix login' }),
    ).toBeVisible()
    expect(screen.getByText('No grant is in force')).toBeVisible()
    expect(
      screen.getByText('Pinned to the agent in pane web:claude'),
    ).toBeVisible()
    // Nothing filled in for the user
    expect(prefixBox()).toHaveValue('')
    expect(
      screen.getByText(
        /pnpm test runs its test files and whatever package.json/,
      ),
    ).toBeVisible()
    typePrefix(' pnpm test ')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'For' }), {
      target: { value: '60' },
    })
    await give()
    expect(store.grant).toHaveBeenCalledWith(job(), {
      kind: 'bash',
      prefix: 'pnpm test',
      minutes: 60,
    })
    expect(screen.getByRole('status')).toHaveTextContent(
      'The grant is in force',
    )
    expect(prefixBox()).toHaveValue('')
  })

  it('lists every length, a day at most', () => {
    open()
    expect(
      within(screen.getByRole('combobox', { name: 'For' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      '30 minutes',
      '1 hour',
      '4 hours',
      '8 hours',
      'Until the job ends (24 h at most)',
    ])
  })

  it('checks the prefix as the server does, before sending it', async () => {
    open()
    await give()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Type the command prefix',
    )
    expect(prefixBox()).toHaveFocus()
    expect(prefixBox()).toHaveAttribute('aria-invalid', 'true')
    typePrefix('pnpm test; rm -rf ~')
    expect(screen.getByRole('alert')).toHaveTextContent(/no quotes/)
    typePrefix('npx vitest')
    expect(screen.getByRole('alert')).toHaveTextContent(
      /This program cannot be granted/,
    )
    typePrefix('cat /etc/hosts')
    expect(screen.getByRole('alert')).toHaveTextContent(
      /read only inside the folder the grant keeps/,
    )
    typePrefix('pnpm lint')
    expect(screen.getByRole('alert')).toHaveTextContent(/not pnpm lint/)
    typePrefix('x'.repeat(201))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The prefix is longer than 200 characters',
    )
    await give()
    expect(store.grant).not.toHaveBeenCalled()
  })

  it('refuses a program alone, and takes it with a command', async () => {
    open()
    // Not a problem before the user tried to give one
    typePrefix('')
    expect(screen.queryByRole('alert')).toBeNull()
    typePrefix('pnpm')
    await give()
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Type the command you allow after the program/,
    )
    expect(store.grant).not.toHaveBeenCalled()
    typePrefix('pnpm run lint')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    await give()
    expect(store.grant).toHaveBeenCalledWith(job(), {
      kind: 'bash',
      prefix: 'pnpm run lint',
      minutes: 1440,
    })
  })

  it('says a test or build command runs code the agent can edit, and that options after the prefix are not covered', () => {
    open()
    expect(
      screen.getByText(
        /A test, build or script command runs code the agent can edit/,
      ),
    ).toBeVisible()
    expect(screen.getByText(/words that are no option/)).toBeVisible()
    fireEvent.click(screen.getByRole('radio', { name: 'Edit files' }))
    expect(screen.queryByText(/runs code the agent can edit/)).toBeNull()
  })

  it('gives a grant to edit files in the worktree, naming what it never covers', async () => {
    const j = job({ worktree: { branch: 'b', dir: '/w/fix' } })
    open(j)
    expect(
      screen.getByText('Pinned to the agent in pane web:claude, folder /w/fix'),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('radio', { name: 'Edit files' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(
      screen.getByText(/Never covered: agent settings \(.claude\//),
    ).toBeVisible()
    expect(screen.getByText(/except for the files/)).toBeVisible()
    await give()
    expect(store.grant).toHaveBeenCalledWith(j, {
      kind: 'edit',
      prefix: undefined,
      minutes: 1440,
    })
  })

  it('gives no grant to edit files to a job without a worktree', () => {
    open()
    fireEvent.click(screen.getByRole('radio', { name: 'Edit files' }))
    expect(screen.getByText(/a grant to edit files needs one/)).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Give the grant' }),
    ).toBeDisabled()
  })

  it("gives no grant to edit files while the job's agent works outside its worktree", () => {
    open(
      job({
        worktree: { branch: 'b', dir: '/w/fix' },
        live: {
          status: 'idle',
          paneId: '%1',
          ref: 'web:claude',
          outsideWorktree: true,
        },
      }),
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Edit files' }))
    expect(
      screen.getByText(/works outside the job's worktree now/),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Give the grant' }),
    ).toBeDisabled()
  })

  it('says why an edit grant outside the worktree was refused', async () => {
    store.grant.mockRejectedValueOnce(
      new RequestError(409, 'grant_outside_worktree', 'x'),
    )
    open(job({ worktree: { branch: 'b', dir: '/w/fix' } }))
    fireEvent.click(screen.getByRole('radio', { name: 'Edit files' }))
    await give()
    expect(
      screen.getByText(
        "The job's agent works outside the job's worktree, so no grant to edit files can be given",
      ),
    ).toBeVisible()
  })

  it('gives a grant to send failed checks where the server follows pull requests', async () => {
    open()
    expect(
      screen.queryByRole('radio', { name: 'Send failed checks' }),
    ).toBeNull()
    cleanup()
    open(job(), true, true)
    fireEvent.click(screen.getByRole('radio', { name: 'Send failed checks' }))
    expect(screen.getByText(/up to 3 times/)).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Command prefix' })).toBeNull()
    await give()
    expect(store.grant).toHaveBeenCalledWith(job(), {
      kind: 'ci',
      prefix: undefined,
      minutes: 1440,
    })
  })

  it('counts the rounds a ci grant sent', () => {
    open(
      job({
        grants: [
          grant({ kind: 'ci', prefix: undefined, uses: [{ at: later(-1) }] }),
        ],
      }),
      true,
      true,
    )
    expect(screen.getByText(/sent 1 of 3 times/)).toBeVisible()
    expect(screen.getByText('Send failed checks to the agent')).toBeVisible()
  })

  it('tells why the server refused', async () => {
    store.grant
      .mockRejectedValueOnce(new RequestError(400, 'job_invalid', 'x'))
      .mockRejectedValueOnce(new Error('offline'))
    open()
    typePrefix('pnpm test')
    await give()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The job cannot take this change',
    )
    await give()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not change the grants',
    )
    // Another kind starts afresh
    fireEvent.click(screen.getByRole('radio', { name: 'Edit files' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('lists the grants in force, pinned, and ends one once confirmed', async () => {
    const j = job({
      grants: [
        grant({ uses: [{ at: later(-1), command: 'pnpm test a' }] }),
        grant({
          id: 'g2',
          kind: 'edit',
          prefix: undefined,
          dir: '/w/fix',
          expires: later(5),
          agent: { ...agent, ref: undefined },
        }),
        grant({ id: 'g3', revoked: later(-1) }),
      ],
    })
    open(j)
    const items = screen
      .getByRole('heading', { name: 'In force' })
      .parentElement!.querySelectorAll('li')
    expect([...items].map((l) => l.textContent)).toEqual([
      'Run: pnpm testPinned to the agent in pane web:claudeEnds in 1 h · used 1 timeEnd',
      'Edit files in the worktreePinned to the agent in pane %1Folder: /w/fixEnds in 5 min · used 0 timesEnd',
    ])
    fireEvent.click(
      screen.getByRole('button', { name: 'End the grant Run: pnpm test' }),
    )
    const dialog = screen.getByRole('dialog', { name: 'End this grant?' })
    expect(dialog).toHaveTextContent('Run: pnpm test')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'End' }))
    })
    expect(store.revoke).toHaveBeenCalledWith(j, 'g1')
    expect(screen.getByRole('status')).toHaveTextContent('The grant ended')
  })

  it('tells a refused revoke', async () => {
    store.revoke.mockRejectedValueOnce(
      new RequestError(404, 'grant_not_found', 'x'),
    )
    open(job({ grants: [grant()] }))
    fireEvent.click(screen.getByRole('button', { name: /End the grant/ }))
    const dialog = screen.getByRole('dialog', { name: 'End this grant?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(store.revoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /End the grant/ }))
    await act(async () => {
      fireEvent.click(
        within(
          screen.getByRole('dialog', { name: 'End this grant?' }),
        ).getByRole('button', { name: 'End' }),
      )
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This grant no longer exists',
    )
  })

  it('explains, and offers nothing, where this browser cannot grant', () => {
    open(job({ grants: [grant()] }), false)
    expect(screen.getByRole('note')).toHaveTextContent(
      /Only a browser signed in with the password/,
    )
    expect(screen.getByText('Run: pnpm test')).toBeVisible()
    expect(screen.queryByRole('button', { name: /End/ })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it("says a machine's grants are given on that machine, offering nothing", () => {
    setCurrentMachineForTest('0123456789abcdef')
    try {
      open(job({ grants: [grant()] }), false)
      expect(screen.getByRole('note')).toHaveTextContent(
        /given on its own Termote/,
      )
      expect(screen.getByText('Run: pnpm test')).toBeVisible()
      expect(screen.queryByRole('button', { name: /End|Give/ })).toBeNull()
      expect(screen.queryByRole('textbox')).toBeNull()
    } finally {
      setCurrentMachineForTest('')
    }
  })

  it('takes no new grant for a finished job, or one without an agent', () => {
    open(job({ state: 'done' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(/A new grant needs the job/)).toBeVisible()
  })

  it('shows the job as the last read has it', () => {
    store.current.mockReturnValue(job({ title: 'Renamed', agent: undefined }))
    open()
    expect(
      screen.getByRole('dialog', { name: 'Grants of Renamed' }),
    ).toBeVisible()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
