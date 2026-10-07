import { describe, expect, it } from 'vitest'
import { formatRunning, uniqueNames } from './running-commands'

describe('uniqueNames', () => {
  it('keeps the first of each name, in order, and skips empty ones', () => {
    expect(uniqueNames(['bash', undefined, 'vim', '', 'bash', 'npm'])).toEqual([
      'bash',
      'vim',
      'npm',
    ])
  })

  it('is empty without names', () => {
    expect(uniqueNames([])).toEqual([])
    expect(uniqueNames([undefined])).toEqual([])
  })
})

describe('formatRunning', () => {
  it('names one or several commands', () => {
    expect(formatRunning(['vim'])).toBe('Running: vim.')
    expect(formatRunning(['vim', 'npm'])).toBe('Running: vim, npm.')
  })

  it('says nothing without commands', () => {
    expect(formatRunning([])).toBe('')
  })
})
