import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  finishStarPrompt,
  isStarPromptPending,
  recordVersion,
  SEEN_VERSION_KEY,
  STAR_PROMPT_KEY,
} from './star-prompt'

describe('star prompt', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('keeps the version on a first visit without asking', () => {
    recordVersion('1.13.0')
    expect(localStorage.getItem(SEEN_VERSION_KEY)).toBe('1.13.0')
    expect(isStarPromptPending()).toBe(false)
  })

  it('asks after the version rose', () => {
    recordVersion('1.13.0')
    recordVersion('1.14.0')
    expect(localStorage.getItem(SEEN_VERSION_KEY)).toBe('1.14.0')
    expect(isStarPromptPending()).toBe(true)
  })

  it.each([
    ['the same version', '1.13.0', '1.13.0'],
    ['a downgrade', '1.14.0', '1.13.0'],
    ['a pre-release now', '1.13.0', '1.14.0-rc.1'],
    ['a pre-release before', '1.14.0-rc.1', '1.14.0'],
    ['a dev build', '0.0.0-x', '0.0.0'],
    ['an unknown version kept', 'garbage', '1.14.0'],
  ])('does not ask for %s', (_, seen, current) => {
    localStorage.setItem(SEEN_VERSION_KEY, seen)
    recordVersion(current)
    expect(localStorage.getItem(SEEN_VERSION_KEY)).toBe(current)
    expect(isStarPromptPending()).toBe(false)
  })

  it('never asks again once finished', () => {
    recordVersion('1.13.0')
    recordVersion('1.14.0')
    finishStarPrompt()
    expect(isStarPromptPending()).toBe(false)
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe('done')
    recordVersion('1.15.0')
    expect(isStarPromptPending()).toBe(false)
  })

  it('stays pending across later updates until finished', () => {
    recordVersion('1.13.0')
    recordVersion('1.14.0')
    recordVersion('1.15.0')
    expect(isStarPromptPending()).toBe(true)
  })

  it('asks nothing and throws nothing without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => recordVersion('1.14.0')).not.toThrow()
    expect(() => finishStarPrompt()).not.toThrow()
    expect(isStarPromptPending()).toBe(false)
  })
})
