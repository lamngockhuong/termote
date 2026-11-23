import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { JobPRChip } from './job-pr-chip'

describe('JobPRChip', () => {
  it('shows one pull request by its number, coloured by its checks', () => {
    render(<JobPRChip summary={{ worst: 'fail', count: 1, numbers: [12] }} />)
    const chip = screen.getByRole('img', {
      name: 'Pull requests #12: checks failed',
    })
    expect(chip.textContent).toContain('#12')
    expect(chip.className).toContain('text-danger')
    expect(chip.dataset.worst).toBe('fail')
  })

  it('counts several, and shows nothing without one', () => {
    const { rerender } = render(
      <JobPRChip
        summary={{
          worst: 'merged',
          count: 2,
          allMerged: true,
          numbers: [3, 4],
        }}
      />,
    )
    expect(screen.getByTestId('job-pr-chip').textContent).toContain('2 PRs')
    expect(screen.getByTestId('job-pr-chip').textContent).toContain(
      'all merged',
    )
    // Numbers left out (an older server): counted, named by none
    rerender(<JobPRChip summary={{ worst: 'pending', count: 1 }} />)
    expect(screen.getByTestId('job-pr-chip').textContent).toContain('1 PR')
    expect(
      screen.getByRole('img', { name: 'Pull requests : checks running' }),
    ).toBeTruthy()
    rerender(<JobPRChip summary={undefined} />)
    expect(screen.queryByTestId('job-pr-chip')).toBeNull()
    rerender(<JobPRChip summary={{ count: 0 }} />)
    expect(screen.queryByTestId('job-pr-chip')).toBeNull()
  })
})
