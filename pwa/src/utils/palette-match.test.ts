import { describe, expect, it } from 'vitest'
import {
  bestMatchScore,
  matchScore,
  parseLine,
  parsePrefix,
  prefixOf,
  rankByMatch,
} from './palette-match'

describe('parsePrefix', () => {
  it('reads the mode from the first character', () => {
    expect(parsePrefix('> toggle ')).toEqual({
      mode: 'commands',
      query: 'toggle',
    })
    expect(parsePrefix(':12:3')).toEqual({ mode: 'line', query: '12:3' })
    expect(parsePrefix('@main')).toEqual({ mode: 'sessions', query: 'main' })
    expect(parsePrefix(' app.ts')).toEqual({ mode: 'files', query: 'app.ts' })
  })

  it('round-trips with prefixOf', () => {
    for (const mode of ['files', 'commands', 'line', 'sessions'] as const)
      expect(parsePrefix(prefixOf(mode)).mode).toBe(mode)
  })
})

describe('matchScore', () => {
  it('matches a subsequence, ignoring case', () => {
    expect(matchScore('Toggle Files', 'tf')).toBeDefined()
    expect(matchScore('Toggle Files', 'TF')).toBeDefined()
    expect(matchScore('Toggle Files', 'ft')).toBeUndefined()
    expect(matchScore('abc', '')).toBe(0)
  })

  it('ranks word starts and runs above scattered letters', () => {
    const starts = matchScore('Toggle Files', 'tf') as number
    const scattered = matchScore('settings for', 'tf') as number
    expect(starts).toBeGreaterThan(scattered)
    const run = matchScore('app.tsx', 'app') as number
    const apart = matchScore('a-p-p.tsx', 'app') as number
    expect(run).toBeGreaterThan(apart)
    expect(matchScore('useFiles', 'uf')).toBeGreaterThan(
      matchScore('usefulness', 'uf') as number,
    )
  })

  it('prefers the shorter text among equals', () => {
    expect(matchScore('a.ts', 'a')).toBeGreaterThan(
      matchScore('a.tsx', 'a') as number,
    )
  })
})

describe('bestMatchScore', () => {
  it('takes the best of the texts, or nothing when none match', () => {
    const best = matchScore('Toggle Files', 'tf')
    expect(bestMatchScore(['Toggle Files', 'settings for'], 'tf')).toBe(best)
    expect(bestMatchScore(['settings for', 'Toggle Files'], 'tf')).toBe(best)
    expect(bestMatchScore(['nothing', 'Toggle Files'], 'tf')).toBe(best)
    expect(bestMatchScore('Toggle Files', 'tf')).toBe(best)
    expect(bestMatchScore(['nothing'], 'tf')).toBeUndefined()
  })
})

describe('rankByMatch', () => {
  it('finds an item by any of its texts', () => {
    const items = [
      ['Mở file', 'Go to file'],
      ['Tới dòng', 'Go to line'],
    ]
    expect(rankByMatch(items, 'go to file', (i) => i)).toEqual([items[0]])
    expect(rankByMatch(items, 'mở file', (i) => i)).toEqual([items[0]])
  })

  const items = ['settings for', 'Toggle Files', 'nothing', 'Toggle Fullscreen']
  it('keeps the matches, best first, ties in order', () => {
    expect(rankByMatch(items, 'tf', (s) => s)).toEqual([
      'Toggle Files',
      'Toggle Fullscreen',
      'settings for',
    ])
    expect(rankByMatch(items, '', (s) => s)).toBe(items)
    const same = [
      { id: 1, t: 'Open' },
      { id: 2, t: 'Open' },
    ]
    expect(rankByMatch(same, 'op', (x) => x.t).map((x) => x.id)).toEqual([1, 2])
  })
})

describe('parseLine', () => {
  it('reads a line and a column', () => {
    expect(parseLine('120')).toEqual({ line: 120, col: undefined })
    expect(parseLine(' 12:5 ')).toEqual({ line: 12, col: 5 })
  })

  it('is undefined for anything else', () => {
    expect(parseLine('')).toBeUndefined()
    expect(parseLine('x')).toBeUndefined()
    expect(parseLine('0')).toBeUndefined()
    expect(parseLine('3:0')).toBeUndefined()
    expect(parseLine('3:')).toBeUndefined()
  })
})
