import { describe, expect, it } from 'vitest'
import { tFor } from '../i18n/i18n-context'
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
    expect(formatRunning(['vim'], tFor('en'))).toBe('Running: vim.')
    expect(formatRunning(['vim', 'npm'], tFor('en'))).toBe('Running: vim, npm.')
  })

  it('shows the hidden characters of a command name', () => {
    expect(formatRunning(['vi\u202em', 'npm'], tFor('en'))).toBe(
      'Running: vi⟨U+202E⟩m, npm.',
    )
  })

  it('says nothing without commands', () => {
    expect(formatRunning([], tFor('en'))).toBe('')
  })
})
