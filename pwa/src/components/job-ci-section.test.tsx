import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRun, mockPin, mockChange } = vi.hoisted(() => ({
  mockRun: vi.fn(),
  mockPin: vi.fn(),
  mockChange: vi.fn(),
}))
vi.mock('../hooks/use-jobs', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-jobs')>()),
  runJobCI: (...a: unknown[]) => mockRun(...a),
  pinJobPRs: (...a: unknown[]) => mockPin(...a),
  changeJob: (...a: unknown[]) => mockChange(...a),
}))

import { type Job, RequestError } from '../hooks/use-mux-api'
import { JobCISection } from './job-ci-section'

const NOW = Date.parse('2026-11-23T10:00:00Z')

const job = (over: Partial<Job> = {}): Job => ({
  id: 'a',
  title: 'Fix login',
  state: 'review',
  updated: 'u1',
  agent: { key: 'k', paneId: '%1', kind: 'claude' },
  live: { status: 'idle', paneId: '%1' },
  ciChecked: new Date(NOW - 40_000).toISOString(),
  ci: {
    repo: 'github.com/o/r',
    prs: [
      {
        number: 12,
        repo: 'github.com/o/r',
        state: 'open',
        checks: 'fail',
        head: 'aaa',
        failing: ['lint', 'e2e'],
        url: 'https://github.com/o/r/pull/12',
      },
      {
        number: 15,
        repo: 'github.com/o/r',
        state: 'open',
        checks: 'pass',
        pinned: true,
      },
      {
        number: 20,
        repo: 'github.com/x/r',
        state: 'open',
        checks: 'fail',
        foreign: true,
      },
    ],
  },
  ciSummary: { worst: 'fail', count: 3, numbers: [12, 15, 20] },
  ...over,
})

describe('JobCISection', () => {
  beforeEach(() => {
    mockRun.mockReset()
    mockPin.mockReset()
    mockChange.mockReset()
  })

  it('lists each pull request with its checks, link and tags', () => {
    render(<JobCISection job={job()} now={NOW} />)
    const rows = screen.getAllByTestId('job-pr')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('checks failed')
    expect(rows[0].textContent).toContain('lint, e2e')
    expect(
      screen.getByRole('link', { name: 'Open pull request #12' }),
    ).toHaveAttribute('href', 'https://github.com/o/r/pull/12')
    expect(rows[1].textContent).toContain('attached')
    expect(rows[2].textContent).toContain('never sent on its own')
    expect(screen.getByText(/Checked/)).toBeTruthy()
  })

  it('links a pull request only by an https link to its own number', () => {
    const one = (url: string) =>
      job({
        ci: {
          repo: 'github.com/o/r',
          prs: [
            {
              number: 12,
              repo: 'github.com/o/r',
              state: 'open',
              checks: 'pass',
              url,
            },
          ],
        },
      })
    for (const url of [
      'javascript:alert(1)//pull/12',
      'http://github.com/o/r/pull/12',
      'https://github.com/o/r/pull/13',
      'https://evil.example/o/r/pull/12',
    ]) {
      const { unmount } = render(<JobCISection job={one(url)} now={NOW} />)
      expect(screen.queryByRole('link')).toBeNull()
      unmount()
    }
    render(
      <JobCISection job={one('https://github.com/o/r/pull/12')} now={NOW} />,
    )
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/12',
    )
  })

  it('sends the failed checks and says whether the agent queued them', async () => {
    mockRun.mockResolvedValue({ job: job(), queued: true })
    render(<JobCISection job={job()} now={NOW} />)
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Send the failed checks to the agent',
        }),
      )
    })
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
      'send',
    )
    expect(screen.getByRole('status').textContent).toContain(
      'it reads them when it is done',
    )
  })

  it('reads the pull requests again', async () => {
    mockRun.mockResolvedValue({ job: job(), queued: false })
    render(<JobCISection job={job()} now={NOW} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    })
    expect(mockRun).toHaveBeenCalledWith(expect.anything(), 'refresh')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says the agent took them, and that an unexplained failure failed', async () => {
    mockRun.mockResolvedValue({ job: job(), queued: false })
    render(<JobCISection job={job()} now={NOW} />)
    const send = screen.getByRole('button', {
      name: 'Send the failed checks to the agent',
    })
    await act(async () => {
      fireEvent.click(send)
    })
    expect(screen.getByRole('status').textContent).toBe('Sent to the agent')
    mockRun.mockRejectedValue(new Error('network'))
    await act(async () => {
      fireEvent.click(send)
    })
    expect(screen.getByRole('alert').textContent).toBe('Could not do that')
  })

  it('explains a refusal by its code', async () => {
    mockRun.mockRejectedValue(
      new RequestError(409, 'refused', 'input_has_draft'),
    )
    render(<JobCISection job={job()} now={NOW} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    })
    expect(mockRun).toHaveBeenCalledWith(expect.anything(), 'refresh')
    expect(screen.getByRole('alert').textContent).not.toBe('')
  })

  it('offers sending again once that set was sent, and nothing without a failure', () => {
    const { rerender } = render(
      <JobCISection
        job={job({ ci: { ...job().ci, sent: 'fail:12@aaa,20@' } })}
        now={NOW}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Sent · send again' }),
    ).toBeTruthy()
    rerender(
      <JobCISection
        job={job({ ci: { prs: [job().ci!.prs![1]] } })}
        now={NOW}
      />,
    )
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull()
  })

  it('attaches and detaches pull requests by number', async () => {
    mockPin.mockResolvedValue(job())
    render(<JobCISection job={job()} now={NOW} />)
    const field = screen.getByLabelText('Attach a pull request by its number')
    fireEvent.change(field, { target: { value: 'x' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    })
    expect(mockPin).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('whole number')
    fireEvent.change(field, { target: { value: '#42' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    })
    expect(mockPin).toHaveBeenCalledWith(expect.anything(), [42], [])
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Detach pull request #15' }),
      )
    })
    expect(mockPin).toHaveBeenLastCalledWith(expect.anything(), [], [15])
  })

  it('offers setting the job done once every pull request is merged', async () => {
    mockChange.mockResolvedValue(job())
    const merged = job({
      ci: {
        prs: [{ number: 12, repo: 'github.com/o/r', state: 'merged' }],
      },
      ciSummary: { worst: 'merged', count: 1, allMerged: true, numbers: [12] },
    })
    render(<JobCISection job={merged} now={NOW} />)
    expect(screen.getByText(/Every pull request is merged/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set done' }))
    })
    expect(mockChange).toHaveBeenCalledWith(merged, { state: 'done' })
  })

  it('lists an attached number gh found nothing for, to detach it', async () => {
    mockPin.mockResolvedValue(job())
    render(
      <JobCISection
        job={job({ ci: { ...job().ci, pins: [15, 404] } })}
        now={NOW}
      />,
    )
    expect(screen.getByTestId('job-pr-unread').textContent).toContain('#404')
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Detach pull request #404' }),
      )
    })
    expect(mockPin).toHaveBeenCalledWith(expect.anything(), [], [404])
  })

  it('offers sending when only a foreign pull request failed', () => {
    render(
      <JobCISection
        job={job({ ci: { prs: [job().ci!.prs![2]] } })}
        now={NOW}
      />,
    )
    expect(
      screen.getByRole('button', {
        name: 'Send the failed checks to the agent',
      }),
    ).toBeTruthy()
  })

  it('says no pull request was found, before any read', () => {
    render(
      <JobCISection
        job={job({ ci: undefined, ciChecked: undefined })}
        now={NOW}
      />,
    )
    expect(
      screen.getByText('No pull request for the job’s branch yet'),
    ).toBeTruthy()
    expect(screen.queryByText(/Checked/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull()
  })

  it('tells a failed read by its code', () => {
    render(
      <JobCISection job={job({ ci: { error: 'ci_gh_auth' } })} now={NOW} />,
    )
    expect(screen.getByRole('status').textContent).toContain('gh auth login')
  })
})
