import { describe, expect, it } from 'vitest'
import { formatAgo } from './format-ago'

describe('formatAgo', () => {
  it('rounds down to minutes, then hours', () => {
    expect(formatAgo(30_000)).toBe('just now')
    expect(formatAgo(5 * 60_000)).toBe('5 min ago')
    expect(formatAgo(3 * 3_600_000)).toBe('3 h ago')
  })
})
