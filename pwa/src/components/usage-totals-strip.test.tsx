import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { writeSettingsPatch } from '../hooks/use-settings'
import { SessionUsageLine } from './session-usage-line'
import { UsageTotalsStrip } from './usage-totals-strip'

const NOW = Date.now()
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const SUMMARY = {
  buckets: [
    { t: at(0), agent: 'claude' as const, tokens: 1_200_000, costUsd: 3.4 },
    {
      t: at(3 * 86_400_000),
      agent: 'claude' as const,
      tokens: 800_000,
      costUsd: 1,
    },
    { t: at(0), agent: 'codex' as const, tokens: 500, unpricedTokens: 500 },
  ],
  since: at(8 * 86_400_000),
  truncated: true,
  pricesUpdated: '2026-11-15',
}

afterEach(() => {
  cleanup()
  writeSettingsPatch({ showCost: true })
})

describe('UsageTotalsStrip', () => {
  it("shows each agent's today and 7 days, cost unless turned off", () => {
    const { rerender } = render(
      <UsageTotalsStrip summary={SUMMARY} now={NOW} />,
    )
    const strip = screen.getByRole('region', { name: 'Agent tokens' })
    const claude = strip.querySelector('[data-agent="claude"]')
    expect(claude).toHaveTextContent(
      'Claude CodeToday 1.2M tokens · ~$3.407 days 2.0M tokens · ~$4.40',
    )
    expect(strip.querySelector('[data-agent="codex"]')).toHaveTextContent(
      'CodexToday 500 tokens · no price7 days 500 tokens · no price',
    )
    expect(strip).toHaveAttribute(
      'title',
      'Estimated at API list prices of Nov 15, 2026; a subscription is not billed by the token\nSome models have no price: their tokens are not in the cost',
    )
    expect(strip).toHaveTextContent(
      'Only the newest 5000 files (OpenCode: sessions) of each agent are counted',
    )

    writeSettingsPatch({ showCost: false })
    rerender(<UsageTotalsStrip summary={SUMMARY} now={NOW} />)
    expect(strip.querySelector('[data-agent="claude"]')).toHaveTextContent(
      'Claude CodeToday 1.2M tokens7 days 2.0M tokens',
    )
    expect(strip).not.toHaveAttribute('title')
  })

  it('marks a cost + when some tokens have no price; 0 tokens plain', () => {
    render(
      <UsageTotalsStrip
        summary={{
          ...SUMMARY,
          truncated: false,
          buckets: [
            {
              t: at(2 * 86_400_000),
              agent: 'claude',
              tokens: 10,
              costUsd: 1,
              unpricedTokens: 4,
            },
          ],
        }}
        now={NOW}
      />,
    )
    const claude = screen.getByTestId('usage-totals').firstElementChild
    expect(claude).toHaveTextContent(
      'Claude CodeToday 0 tokens7 days 10 tokens · ~$1.00+',
    )
    expect(screen.getByTestId('usage-totals')).not.toHaveTextContent(
      '5000 files',
    )
  })

  it("shows OpenCode's own cost, its tokens alone when it recorded none", () => {
    const { rerender } = render(
      <UsageTotalsStrip
        summary={{
          ...SUMMARY,
          truncated: false,
          buckets: [
            { t: at(0), agent: 'opencode', tokens: 2000, costUsd: 0.5 },
            { t: at(2 * 86_400_000), agent: 'opencode', tokens: 300 },
          ],
        }}
        now={NOW}
      />,
    )
    const strip = screen.getByTestId('usage-totals')
    expect(strip.querySelector('[data-agent="opencode"]')).toHaveTextContent(
      'OpenCodeToday 2.0k tokens · ~$0.507 days 2.3k tokens · ~$0.50',
    )
    expect(strip).toHaveAttribute(
      'title',
      "OpenCode's cost as it recorded it, at your provider's prices; a model without a price shows its tokens only",
    )
    rerender(
      <UsageTotalsStrip
        summary={{
          ...SUMMARY,
          truncated: false,
          buckets: [
            { t: at(0), agent: 'opencode', tokens: 300 },
            { t: at(0), agent: 'claude', tokens: 10, costUsd: 1 },
          ],
        }}
        now={NOW}
      />,
    )
    expect(strip.querySelector('[data-agent="opencode"]')).toHaveTextContent(
      'OpenCodeToday 300 tokens7 days 300 tokens',
    )
    expect(strip.title).toContain('Estimated at API list prices')
    expect(strip.title).toContain("OpenCode's cost as it recorded it")
  })

  it('shows nothing before a read or without tokens in the 7 days', () => {
    const { container, rerender } = render(<UsageTotalsStrip now={NOW} />)
    expect(container).toBeEmptyDOMElement()
    rerender(
      <UsageTotalsStrip
        summary={{
          ...SUMMARY,
          buckets: [{ ...SUMMARY.buckets[0], t: at(9 * 86_400_000) }],
        }}
        now={NOW}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('SessionUsageLine', () => {
  it("shows OpenCode's own cost, and its tokens alone without one", () => {
    const { rerender } = render(
      <SessionUsageLine
        tokens={2000}
        costUsd={0.25}
        subTokens={500}
        pricesUpdated="2026-11-15"
        history
        reported
      />,
    )
    const line = screen.getByTestId('session-usage')
    expect(line).toHaveTextContent(
      'Tokens used by this session: 2.0k tokens · ~$0.25incl. subagents 500 tokens',
    )
    // No price table, and an OpenCode fork counts nothing it copied.
    expect(line).toHaveAttribute(
      'title',
      "OpenCode's cost as it recorded it, at your provider's prices; a model without a price shows its tokens only",
    )
    rerender(
      <SessionUsageLine tokens={2000} pricesUpdated="2026-11-15" reported />,
    )
    expect(line).toHaveTextContent('2.0k tokens')
    expect(line).not.toHaveTextContent('price')
  })

  it("shows the session's tokens, cost and subagents' share", () => {
    const { rerender } = render(
      <SessionUsageLine
        tokens={1_200_000}
        costUsd={3.4}
        unpricedTokens={5}
        unpricedModels={['mystery​']}
        subTokens={300_000}
        subCostUsd={0.8}
        pricesUpdated="2026-11-15"
      />,
    )
    const line = screen.getByTestId('session-usage')
    expect(line).toHaveTextContent(
      'Tokens used by this session: 1.2M tokens · ~$3.40+incl. subagents 300k tokens · ~$0.80',
    )
    expect(line).toHaveAttribute(
      'title',
      'Estimated at API list prices of Nov 15, 2026; a subscription is not billed by the token\nNo price for mystery⟨U+200B⟩',
    )

    // No price at all, unnamed models, an old session; no subagent tokens.
    rerender(
      <SessionUsageLine
        tokens={20}
        unpricedTokens={20}
        subTokens={0}
        pricesUpdated="2026-11-15"
        history
      />,
    )
    expect(line).toHaveTextContent('20 tokens · no price')
    expect(line).not.toHaveTextContent('subagents')
    expect(line.title).toContain(
      'Some models have no price: their tokens are not in the cost',
    )
    expect(line.title).toContain('A forked session counts')

    // Turned off: tokens only; an old session still says what it counts.
    writeSettingsPatch({ showCost: false })
    rerender(
      <SessionUsageLine
        tokens={20}
        costUsd={1}
        pricesUpdated="2026-11-15"
        history
      />,
    )
    expect(line).toHaveTextContent(/^Tokens used by this session: 20 tokens$/)
    expect(line.title).toBe(
      'A forked session counts the messages it copied from the one it was forked from',
    )
    rerender(<SessionUsageLine tokens={0} pricesUpdated="2026-11-15" />)
    expect(line).not.toHaveAttribute('title')
    expect(line).toHaveTextContent('0 tokens')
  })
})
