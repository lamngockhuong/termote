import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverviewAccount, OverviewPane } from '../hooks/use-mux-api'

const { mockFetchOverview } = vi.hoisted(() => ({ mockFetchOverview: vi.fn() }))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchOverview: (pane?: string) => mockFetchOverview(pane),
}))

import { OVERVIEW_POLL } from '../hooks/use-agent-overview'
import { HeaderUsageChip, UsageChip, usageParts } from './usage-chip'

const NOW = Date.parse('2026-10-14T01:05:00.000Z')
const ACCOUNT: OverviewAccount = {
  key: 'k1',
  agent: 'codex',
  windows: [
    { usedPercent: 40, windowMinutes: 300 },
    { usedPercent: 95, windowMinutes: 10080 },
  ],
  updatedAt: '2026-10-14T01:00:00.000Z',
}
const pane = (over: Partial<OverviewPane> = {}): OverviewPane => ({
  paneId: 'p1',
  key: 'p1',
  usage: {
    contextTokens: 144_000,
    contextWindow: 200_000,
    contextPercent: 72,
    exact: true,
  },
  ...over,
})

describe('usageParts', () => {
  it('takes the context share and the fullest window of the account', () => {
    expect(usageParts(pane({ accountKey: 'k1' }), [ACCOUNT], NOW)).toEqual([
      { name: 'ctx', spoken: 'context', percent: 72, exact: true },
      { name: '7d', spoken: 'Codex 7d limit', percent: 95, exact: true },
    ])
  })

  it('leaves out what is not known', () => {
    expect(usageParts(undefined, [ACCOUNT], NOW)).toEqual([])
    // A server that does not know the window; an account not read
    expect(
      usageParts(
        pane({ usage: { contextTokens: 5 }, accountKey: 'k2' }),
        [ACCOUNT],
        NOW,
      ),
    ).toEqual([])
    expect(
      usageParts(
        pane({
          usage: {
            contextTokens: 5,
            contextWindow: 200_000,
            contextPercent: 0,
          },
        }),
        [ACCOUNT],
        NOW,
      ),
    ).toEqual([{ name: 'ctx', spoken: 'context', percent: 0, exact: true }])
    expect(
      usageParts(
        pane({ usage: undefined, accountKey: 'k1' }),
        [{ ...ACCOUNT, windows: [] }],
        NOW,
      ),
    ).toEqual([])
  })
})

describe('usageParts limits', () => {
  const only = (account: OverviewAccount) =>
    usageParts(pane({ usage: undefined, accountKey: 'k1' }), [account], NOW)

  it('leaves out windows past their reset', () => {
    const passed = new Date(NOW - 60_000).toISOString()
    const ahead = new Date(NOW + 60_000).toISOString()
    expect(
      only({
        ...ACCOUNT,
        windows: [
          { usedPercent: 40, windowMinutes: 300, resetsAt: ahead },
          { usedPercent: 95, windowMinutes: 10080, resetsAt: passed },
        ],
      }),
    ).toEqual([
      { name: '5h', spoken: 'Codex 5h limit', percent: 40, exact: true },
    ])
  })

  it('takes the fullest window wherever it comes', () => {
    expect(
      only({ ...ACCOUNT, windows: [...ACCOUNT.windows].reverse() }),
    ).toEqual([
      { name: '7d', spoken: 'Codex 7d limit', percent: 95, exact: true },
    ])
  })

  it('leaves out limits recorded over half an hour ago', () => {
    expect(
      only({
        ...ACCOUNT,
        updatedAt: new Date(NOW - 31 * 60_000).toISOString(),
      }),
    ).toEqual([])
    expect(only({ ...ACCOUNT, updatedAt: 'yesterday' })).toEqual([])
  })
})

describe('UsageChip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows both parts on desktop, coloured by the fuller one', () => {
    const onOpen = vi.fn()
    render(
      <UsageChip
        pane={pane({ accountKey: 'k1' })}
        accounts={[ACCOUNT]}
        isMobile={false}
        onOpen={onOpen}
      />,
    )
    const chip = screen.getByRole('button', {
      name: 'Agent usage: context 72%, Codex 7d limit 95%. Open the agent overview',
    })
    expect(chip).toHaveTextContent('ctx 72% · 7d 95%')
    expect(chip).toHaveAttribute('data-level', 'danger')
    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('shows only the fuller part on mobile, ~ when assumed', () => {
    render(
      <UsageChip
        pane={pane({
          accountKey: 'k1',
          usage: {
            contextTokens: 150_000,
            contextWindow: 200_000,
            contextPercent: 75,
            exact: false,
          },
        })}
        accounts={[{ ...ACCOUNT, windows: [ACCOUNT.windows[0]] }]}
        isMobile
      />,
    )
    const chip = screen.getByRole('note', { name: 'Agent usage: context ~75%' })
    expect(chip).toHaveTextContent(/^ctx ~75%$/)
    expect(chip).toHaveAttribute('data-level', 'warning')
  })

  it('shows the limit on mobile when it is the fuller part', () => {
    render(
      <UsageChip
        pane={pane({ accountKey: 'k1' })}
        accounts={[ACCOUNT]}
        isMobile
      />,
    )
    expect(screen.getByRole('note')).toHaveTextContent(/^7d 95%$/)
  })

  it('shows nothing without usage', () => {
    const { container } = render(
      <UsageChip pane={undefined} accounts={[]} isMobile={false} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('HeaderUsageChip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
    mockFetchOverview.mockReset()
    mockFetchOverview.mockResolvedValue({
      serverNow: 'x',
      panes: [pane({ accountKey: 'k1' })],
      accounts: [ACCOUNT],
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const chip = (over: Partial<Parameters<typeof HeaderUsageChip>[0]> = {}) => (
    <HeaderUsageChip
      paneId="p1"
      hasAgent
      enabled
      pollInterval={OVERVIEW_POLL}
      isMobile={false}
      {...over}
    />
  )

  it('reads the overview and shows the open pane', async () => {
    render(chip())
    await act(async () => {})
    expect(mockFetchOverview).toHaveBeenCalledExactlyOnceWith('p1')
    expect(screen.getByRole('note')).toHaveTextContent('ctx 72% · 7d 95%')
  })

  it('shows nothing when the read has no such pane, or no accounts', async () => {
    mockFetchOverview.mockResolvedValue({ serverNow: 'x', panes: [] })
    const { container } = render(chip())
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['turned off', { enabled: false }],
    ['no agent in the pane', { hasAgent: false }],
    ['no pane', { paneId: undefined }],
  ])('reads nothing and shows nothing when %s', async (_, over) => {
    const { container } = render(chip(over))
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL * 2)
    })
    expect(mockFetchOverview).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })
})
