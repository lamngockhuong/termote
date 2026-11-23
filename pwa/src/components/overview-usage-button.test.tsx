import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { OverviewAccount } from '../hooks/use-mux-api'
import { writeSettingsPatch } from '../hooks/use-settings'
import { OverviewUsageButton } from './overview-usage-button'

const NOW = Date.now()
const DAY = 86_400_000
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const SUMMARY = {
  buckets: [
    { t: at(0), agent: 'claude' as const, tokens: 1_200_000, costUsd: 3.4 },
    { t: at(0), agent: 'codex' as const, tokens: 300_000, costUsd: 1 },
    { t: at(3 * DAY), agent: 'claude' as const, tokens: 800_000, costUsd: 1 },
  ],
  since: at(8 * DAY),
  truncated: false,
  pricesUpdated: '2026-11-15',
}

const ACCOUNT: OverviewAccount = {
  key: 'k1',
  agent: 'codex',
  plan: 'team',
  windows: [{ usedPercent: 12, windowMinutes: 300 }],
  updatedAt: new Date(NOW).toISOString(),
}

const button = () => screen.getByRole('button', { name: /^Tokens today/ })

afterEach(() => {
  cleanup()
  writeSettingsPatch({ showCost: true })
})

describe('OverviewUsageButton', () => {
  it("shows today's tokens of every agent, never a cost", () => {
    writeSettingsPatch({ showCost: true })
    render(
      <OverviewUsageButton
        summary={SUMMARY}
        accounts={[]}
        now={NOW}
        clockOffset={0}
      />,
    )
    expect(button()).toHaveAccessibleName('Tokens today: 1.5M')
    expect(button()).toHaveTextContent('Today')
    expect(button()).toHaveTextContent('1.5M tokens')
    expect(button().textContent).not.toMatch(/\$/)
    expect(button()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the totals and the accounts, and closes on Esc without letting it out', () => {
    render(
      <OverviewUsageButton
        summary={SUMMARY}
        accounts={[ACCOUNT]}
        now={NOW}
        clockOffset={0}
      />,
    )
    fireEvent.click(button())
    const panel = screen.getByRole('dialog', { name: 'Tokens and limits' })
    expect(panel).toHaveFocus()
    expect(button()).toHaveAttribute('aria-expanded', 'true')
    expect(button()).toHaveAttribute('aria-controls', panel.id)
    expect(panel).toHaveTextContent('Token usage · every session')
    const totals = screen.getByRole('region', { name: 'Agent tokens' })
    // Each agent's cost today and in 7 days, its tokens under them
    expect(totals.querySelector('[data-agent="claude"]')).toHaveTextContent(
      'Claude Code~$3.40~$4.40tokens1.2M2.0M',
    )
    expect(screen.getByRole('region', { name: 'Accounts' })).toHaveTextContent(
      'Codex · team',
    )
    // Esc in the panel closes it alone: the overview behind sees it handled
    let seen: boolean | undefined
    const onKey = (e: KeyboardEvent) => {
      seen = e.defaultPrevented
    }
    window.addEventListener('keydown', onKey)
    fireEvent.keyDown(panel, { key: 'Escape' })
    window.removeEventListener('keydown', onKey)
    expect(seen).toBeUndefined()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button()).toHaveFocus()
    // Esc on the closed button is the overview's
    let passed = false
    const onPass = () => {
      passed = true
    }
    window.addEventListener('keydown', onPass)
    fireEvent.keyDown(button(), { key: 'Escape' })
    window.removeEventListener('keydown', onPass)
    expect(passed).toBe(true)
    // Another key does nothing
    fireEvent.click(button())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes on a tap outside, not inside, and on the button again', () => {
    render(
      <OverviewUsageButton
        summary={SUMMARY}
        accounts={[]}
        now={NOW}
        clockOffset={0}
      />,
    )
    fireEvent.click(button())
    fireEvent.pointerDown(screen.getByRole('region', { name: 'Agent tokens' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button())
    fireEvent.click(button())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("counts this device's today, not the server's", () => {
    // The server two days ahead: its today has no token
    render(
      <OverviewUsageButton
        summary={SUMMARY}
        accounts={[]}
        now={NOW + 2 * DAY}
        clockOffset={2 * DAY}
      />,
    )
    expect(button()).toHaveAccessibleName('Tokens today: 1.5M')
  })

  it('shows for a Codex account alone, and not without tokens or accounts', () => {
    const { rerender } = render(
      <OverviewUsageButton accounts={[ACCOUNT]} now={NOW} clockOffset={0} />,
    )
    expect(button()).toHaveAccessibleName('Tokens today: 0')
    fireEvent.click(button())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // The account goes: the button and its panel with it
    act(() => {
      rerender(<OverviewUsageButton accounts={[]} now={NOW} clockOffset={0} />)
    })
    expect(screen.queryByRole('button')).toBeNull()
    rerender(
      <OverviewUsageButton
        summary={{ ...SUMMARY, buckets: [] }}
        accounts={[]}
        now={NOW}
        clockOffset={0}
      />,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the tokens alone without a cost, and what has no price', () => {
    const summary = {
      ...SUMMARY,
      truncated: true,
      buckets: [
        // Only before today: no cost today, a dash in its place
        {
          t: at(3 * DAY),
          agent: 'claude' as const,
          tokens: 800_000,
          costUsd: 1,
        },
        { t: at(0), agent: 'claude' as const, tokens: 1000 },
        // No price for its model
        { t: at(0), agent: 'codex' as const, tokens: 500, unpricedTokens: 500 },
        // OpenCode records its own cost: none recorded, its tokens alone
        { t: at(0), agent: 'opencode' as const, tokens: 2000 },
      ],
    }
    const { rerender } = render(
      <OverviewUsageButton
        summary={summary}
        accounts={[]}
        now={NOW}
        clockOffset={0}
      />,
    )
    fireEvent.click(button())
    const totals = screen.getByRole('region', { name: 'Agent tokens' })
    const row = (a: string) => totals.querySelector(`[data-agent="${a}"]`)
    expect(row('codex')).toHaveTextContent('Codexno priceno pricetokens500500')
    expect(row('opencode')).toHaveTextContent('OpenCode2.0k2.0k')
    expect(totals).toHaveTextContent(
      'Only the newest 5000 files (OpenCode: sessions) of each agent are counted',
    )
    expect(totals.getAttribute('title')).toMatch(/Estimated at API list prices/)
    expect(totals.getAttribute('title')).toMatch(/Some models have no price/)
    writeSettingsPatch({ showCost: false })
    rerender(
      <OverviewUsageButton
        summary={summary}
        accounts={[]}
        now={NOW}
        clockOffset={0}
      />,
    )
    expect(row('claude')).toHaveTextContent('Claude Code1.0k801k')
    expect(totals).not.toHaveAttribute('title')
  })

  it('shows a dash for a day with tokens but no cost beside one with', () => {
    render(
      <OverviewUsageButton
        summary={{
          ...SUMMARY,
          buckets: [
            {
              t: at(3 * DAY),
              agent: 'claude' as const,
              tokens: 800_000,
              costUsd: 1,
            },
            { t: at(0), agent: 'codex' as const, tokens: 10, costUsd: 0.01 },
          ],
        }}
        accounts={[]}
        now={NOW}
        clockOffset={0}
      />,
    )
    fireEvent.click(button())
    expect(
      screen
        .getByRole('region', { name: 'Agent tokens' })
        .querySelector('[data-agent="claude"]'),
    ).toHaveTextContent('Claude Code—~$1.00tokens0800k')
  })
})
