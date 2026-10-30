import { describe, expect, it } from 'vitest'
import { tFor } from '../i18n/i18n-context'
import { formatAgo } from './format-ago'

describe('formatAgo', () => {
  it('rounds down to minutes, then hours', () => {
    expect(formatAgo(30_000, tFor('en'))).toBe('just now')
    expect(formatAgo(5 * 60_000, tFor('en'))).toBe('5 min ago')
    expect(formatAgo(3 * 3_600_000, tFor('en'))).toBe('3 h ago')
  })
})
