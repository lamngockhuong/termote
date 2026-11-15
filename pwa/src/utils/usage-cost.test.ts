import { describe, expect, it } from 'vitest'
import type { UsageBucket } from '../hooks/use-mux-api'
import {
  foldBuckets,
  formatCost,
  formatPriceDate,
  formatTokenCount,
} from './usage-cost'

const b = (
  t: string,
  tokens: number,
  costUsd?: number,
  agent: UsageBucket['agent'] = 'claude',
  unpricedTokens?: number,
): UsageBucket => ({ t, agent, tokens, costUsd, unpricedTokens })

describe('foldBuckets', () => {
  it('splits today from the 7 days at local midnight', () => {
    // 2026-11-15 00:10 in Ho Chi Minh City (+07:00) is 11-14 17:10 UTC.
    const now = Date.parse('2026-11-14T17:10:00Z')
    const days = foldBuckets(
      [
        b('2026-11-14T16:45:00Z', 100, 1), // 23:45 the day before
        b('2026-11-14T17:00:00Z', 10, 0.5), // 00:00 today
        b('2026-11-08T17:00:00Z', 1000, 2), // 00:00 six days back
        b('2026-11-08T16:45:00Z', 5000, 9), // seven days back: out
        b('2026-11-14T17:15:00Z', 7, undefined, 'codex', 7), // no price
        b('2026-11-15T17:00:00Z', 9, 9), // tomorrow: out
        b('nope', 9, 9),
      ],
      now,
      'Asia/Ho_Chi_Minh',
    )
    expect(days.claude).toEqual({
      today: { tokens: 10, cost: 0.5, priced: true, unpriced: 0 },
      week: { tokens: 1110, cost: 3.5, priced: true, unpriced: 0 },
    })
    expect(days.codex?.today).toEqual({
      tokens: 7,
      cost: 0,
      priced: false,
      unpriced: 7,
    })
  })

  it('takes the device time zone, at 30 and 45 minutes and across DST', () => {
    const now = Date.parse('2026-11-15T12:00:00Z')
    // India +05:30: 18:30 UTC the day before is 00:00 today.
    expect(
      foldBuckets([b('2026-11-14T18:30:00Z', 1)], now, 'Asia/Kolkata').claude
        ?.today.tokens,
    ).toBe(1)
    expect(
      foldBuckets([b('2026-11-14T18:15:00Z', 1)], now, 'Asia/Kolkata').claude
        ?.today.tokens,
    ).toBe(0)
    // Nepal +05:45: 18:15 UTC is 00:00.
    expect(
      foldBuckets([b('2026-11-14T18:15:00Z', 1)], now, 'Asia/Kathmandu').claude
        ?.today.tokens,
    ).toBe(1)
    // New York left summer time on 11-01: 7 days back from 11-03 reaches
    // 10-28, whose midnight is 04:00 UTC (EDT).
    const ny = Date.parse('2026-11-03T15:00:00Z')
    const days = foldBuckets(
      [b('2026-10-28T04:00:00Z', 1), b('2026-10-28T03:45:00Z', 100)],
      ny,
      'America/New_York',
    )
    expect(days.claude?.week.tokens).toBe(1)
    // The device's own zone when none is given.
    expect(
      foldBuckets([b(new Date().toISOString(), 3)], Date.now()).claude,
    ).toBeDefined()
    expect(foldBuckets([], now)).toEqual({})
  })
})

describe('formatTokenCount', () => {
  it('shortens with the locale decimal mark', () => {
    expect(formatTokenCount(950, 'en')).toBe('950')
    expect(formatTokenCount(1234, 'en')).toBe('1.2k')
    expect(formatTokenCount(35_400, 'en')).toBe('35k')
    expect(formatTokenCount(1_234_567, 'en')).toBe('1.2M')
    expect(formatTokenCount(1_234_567, 'vi')).toBe('1,2M')
  })
})

describe('formatCost', () => {
  it('is an estimate, with a floor of a cent and + when partial', () => {
    expect(formatCost(3.4, 'en')).toBe('~$3.40')
    expect(formatCost(0.004, 'en')).toBe('<$0.01')
    expect(formatCost(0, 'en')).toBe('~$0.00')
    expect(formatCost(3.4, 'en', true)).toBe('~$3.40+')
    expect(formatCost(3.4, 'vi')).toMatch(/^~3,40\sUS\$$/)
  })
})

describe('formatPriceDate', () => {
  it('names the day in the locale, whatever the device zone', () => {
    expect(formatPriceDate('2026-11-15', 'en')).toBe('Nov 15, 2026')
    expect(formatPriceDate('soon', 'en')).toBe('soon')
  })
})
