import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { OverviewAccount } from '../hooks/use-mux-api'
import { AccountUsageStrip } from './account-usage-strip'

const NOW = new Date(2026, 9, 14, 9, 0).getTime()
const account = (over: Partial<OverviewAccount> = {}): OverviewAccount => ({
  key: 'k1',
  agent: 'codex',
  plan: 'plus',
  windows: [
    {
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: new Date(2026, 9, 14, 14, 30).toISOString(),
    },
    { usedPercent: 95, windowMinutes: 10080 },
  ],
  updatedAt: new Date(NOW - 3 * 60_000).toISOString(),
  ...over,
})

describe('AccountUsageStrip', () => {
  it('shows nothing without an account', () => {
    const { container } = render(<AccountUsageStrip accounts={[]} now={NOW} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows each window, its reset and how old the numbers are', () => {
    render(<AccountUsageStrip accounts={[account()]} now={NOW} />)
    const strip = screen.getByRole('region', { name: 'Accounts' })
    expect(strip).toHaveTextContent('Codex · plus')
    expect(strip).toHaveTextContent('5h42%resets 14:30')
    expect(strip).toHaveTextContent('7d95%')
    expect(strip).toHaveTextContent('updated 3 min ago')
    const five = within(strip).getByRole('meter', { name: 'Codex 5h limit' })
    expect(five).toHaveAttribute('aria-valuetext', '42% used, resets 14:30')
    const seven = within(strip).getByRole('meter', { name: 'Codex 7d limit' })
    expect(seven).toHaveAttribute('aria-valuetext', '95% used')
    expect(seven).toHaveAttribute('data-level', 'danger')
    expect(strip.firstElementChild).not.toHaveAttribute('data-stale')
  })

  it('leaves out a window past its reset', () => {
    render(
      <AccountUsageStrip
        accounts={[
          account({
            windows: [
              {
                usedPercent: 80,
                windowMinutes: 300,
                resetsAt: new Date(NOW - 60_000).toISOString(),
              },
              { usedPercent: 10, windowMinutes: 10080 },
            ],
          }),
        ]}
        now={NOW}
      />,
    )
    const strip = screen.getByRole('region', { name: 'Accounts' })
    expect(
      within(strip).queryByRole('meter', { name: 'Codex 5h limit' }),
    ).toBeNull()
    expect(strip).toHaveTextContent('7d10%')
  })

  it('dims numbers older than half an hour, or of no readable time', () => {
    render(
      <AccountUsageStrip
        accounts={[
          account({
            key: 'old',
            plan: undefined,
            updatedAt: new Date(NOW - 31 * 60_000).toISOString(),
          }),
          account({ key: 'bad', updatedAt: 'yesterday' }),
        ]}
        now={NOW}
      />,
    )
    const [old, bad] = Array.from(
      screen.getByRole('region', { name: 'Accounts' }).children,
    )
    expect(old).toHaveAttribute('data-stale', 'true')
    expect(old).toHaveClass('opacity-60')
    expect(old).toHaveTextContent(/^Codex5h/)
    expect(old).toHaveTextContent('updated 31 min ago')
    expect(bad).toHaveAttribute('data-stale', 'true')
    expect(bad).not.toHaveTextContent('updated')
  })
})
