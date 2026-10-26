import { describe, expect, it } from 'vitest'
import {
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

describe('rankByMatch', () => {
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
