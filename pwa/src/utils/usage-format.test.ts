import { describe, expect, it } from 'vitest'
import {
  percentLabel,
  resetLabel,
  usageLevel,
  windowLabel,
  windowRunning,
} from './usage-format'

describe('windowRunning', () => {
  it('runs until its reset, or always without one', () => {
    const now = Date.parse('2026-10-14T09:00:00Z')
    expect(windowRunning('2026-10-14T09:01:00Z', now)).toBe(true)
    expect(windowRunning('2026-10-14T09:00:00Z', now)).toBe(false)
    expect(windowRunning(undefined, now)).toBe(true)
    expect(windowRunning('soon', now)).toBe(true)
  })
})

describe('usageLevel', () => {
  it.each([
    [0, 'normal'],
    [69.9, 'normal'],
    [70, 'warning'],
    [89.9, 'warning'],
    [90, 'danger'],
    [100, 'danger'],
  ])('%d%% is %s', (pct, level) => {
    expect(usageLevel(pct)).toBe(level)
  })
})

describe('percentLabel', () => {
  it('rounds, and marks an assumed share', () => {
    expect(percentLabel(15.5)).toBe('16%')
    expect(percentLabel(72.4, true)).toBe('72%')
    expect(percentLabel(72.4, false)).toBe('~72%')
  })
})

describe('windowLabel', () => {
  it.each([
    [300, '5h'],
    [60, '1h'],
    [10080, '7d'],
    [43200, '30d'],
    [1440, '1d'],
    [90, '90m'],
    [45, '45m'],
    [1500, '25h'],
  ])('%d min is %s', (min, label) => {
    expect(windowLabel(min)).toBe(label)
  })
})

describe('resetLabel', () => {
  // Local time, so the labels do not depend on the zone the tests run in
  const now = new Date(2026, 9, 14, 9, 0).getTime() // Wed 14 Oct
  const at = (...a: [number, number, number, number, number]) =>
    new Date(...a).toISOString()

  it('names the time today, the day this week, the date further', () => {
    expect(resetLabel(at(2026, 9, 14, 14, 30), now)).toBe('resets 14:30')
    expect(resetLabel(at(2026, 9, 19, 9, 5), now)).toBe('resets Mon 09:05')
    expect(resetLabel(at(2026, 9, 28, 9, 0), now)).toBe('resets 28/10')
  })

  it('says now for a time passed, nothing for none', () => {
    expect(resetLabel(at(2026, 9, 14, 8, 0), now)).toBe('resets now')
    expect(resetLabel(undefined, now)).toBeUndefined()
    expect(resetLabel('soon', now)).toBeUndefined()
  })
})
