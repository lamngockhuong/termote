import { describe, expect, it } from 'vitest'
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelative,
  formatTime,
} from './format'

const when = new Date(2026, 9, 28, 14, 5)

describe('format', () => {
  it('formats a date and time in each locale', () => {
    expect(formatDateTime(when, 'en')).toContain('Oct 28, 2026')
    expect(formatDateTime(when, 'en')).toContain('2:05')
    expect(formatDate(when, 'vi')).toContain('2026')
    expect(formatDate(when, 'vi')).not.toContain('Oct')
    expect(formatTime(when, 'vi')).toBe('14:05')
  })

  it('formats a number in each locale', () => {
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5')
    expect(formatNumber(1234.5, 'vi')).toBe('1.234,5')
  })

  it('says how long ago in the largest whole unit', () => {
    const now = when.getTime()
    expect(formatRelative(now - 5 * 60_000, 'en', now)).toBe('5 minutes ago')
    expect(formatRelative(now - 2 * 3_600_000, 'en', now)).toBe('2 hours ago')
    expect(formatRelative(now + 86_400_000, 'en', now)).toBe('tomorrow')
    expect(formatRelative(now - 10_000, 'en', now)).toBe('10 seconds ago')
    expect(formatRelative(now - 5 * 60_000, 'vi', now)).toBe('5 phút trước')
  })

  it('counts from now by default', () => {
    expect(formatRelative(Date.now(), 'en')).toBe('now')
  })
})
