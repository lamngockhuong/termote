import { describe, expect, it } from 'vitest'
import {
  compileFind,
  type FindOptions,
  findMatches,
  MAX_FIND,
  type Matcher,
  matchFrom,
} from './csv-find'
import { parseCsv } from './csv-parse'
import { computeView, type ViewOptions, viewCache } from './csv-view'

const opts = (query: string, over: Partial<FindOptions> = {}): FindOptions => ({
  query,
  matchCase: false,
  wholeCell: false,
  regex: false,
  ...over,
})

const matcher = (o: FindOptions) => compileFind(o) as Matcher

// The cells that match in text, as [file row, column] in the order found
function found(
  text: string,
  o: FindOptions,
  view: ViewOptions = { sort: null, filter: '', header: true },
  cols?: number[],
) {
  const p = parseCsv(text, ',')
  if (!p.ok) throw new Error('parse')
  const cache = viewCache(text, p.table)
  const rows = computeView(cache, view)
  const shown = cols ?? Array.from({ length: p.table.columnCount }, (_, c) => c)
  const m = findMatches(cache, rows, shown, matcher(o))
  const out: [number, number][] = []
  for (let k = 0; k < m.length; k += 2) out.push([rows[m[k]], shown[m[k + 1]]])
  return out
}

const fruit = 'name,note\nBeta,beta\nalpha,"x\nbeta"\nGamma,"say ""beta"""\n'

describe('compileFind', () => {
  it('finds nothing for no query, and says a bad regex is invalid', () => {
    expect(compileFind(opts(''))).toBeNull()
    expect(compileFind(opts('(a', { regex: true }))).toBe('invalid')
    // Wrapped for a whole cell it would compile; alone it does not
    expect(compileFind(opts('a)(b', { regex: true, wholeCell: true }))).toBe(
      'invalid',
    )
  })

  it.each([
    [opts('BET'), ['Beta', 'xbetay'], ['bat']],
    [opts('Bet', { matchCase: true }), ['Beta'], ['beta']],
    [opts('beta', { wholeCell: true }), ['BETA'], ['betas']],
    [opts('Beta', { matchCase: true, wholeCell: true }), ['Beta'], ['beta']],
    [opts('^b.t', { regex: true }), ['BETA'], ['abet']],
    [opts('^b.t', { regex: true, matchCase: true }), ['beta'], ['Beta']],
    [opts('b.t|x', { regex: true, wholeCell: true }), ['bat', 'x'], ['bats']],
    // u: one code point, not two halves of it
    [opts('^.$', { regex: true }), ['😀'], ['ab']],
  ])('%o', (o, yes, no) => {
    const m = matcher(o)
    for (const v of yes) expect(m(v)).toBe(true)
    for (const v of no) expect(m(v)).toBe(false)
  })
})

describe('findMatches', () => {
  it('goes row by row in the order shown, then along the columns', () => {
    expect(found(fruit, opts('beta'))).toEqual([
      [1, 0],
      [1, 1],
      [2, 1],
      [3, 1],
    ])
    // Sorted by name, descending: Gamma, Beta, alpha
    expect(
      found(fruit, opts('beta'), {
        sort: { col: 0, dir: 'desc' },
        filter: '',
        header: true,
      }),
    ).toEqual([
      [3, 1],
      [1, 0],
      [1, 1],
      [2, 1],
    ])
  })

  it('finds the value itself: quotes undone, line breaks kept', () => {
    expect(found(fruit, opts('"beta"'))).toEqual([[3, 1]])
    expect(found(fruit, opts('x\nbeta', { wholeCell: true }))).toEqual([[2, 1]])
  })

  it('leaves out the header row and the columns not shown', () => {
    expect(found(fruit, opts('name'))).toEqual([])
    expect(
      found(fruit, opts('name'), { sort: null, filter: '', header: false }),
    ).toEqual([[0, 0]])
    expect(found(fruit, opts('beta'), undefined, [1])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ])
  })

  it('finds a hidden character typed as it is', () => {
    const text = 'a\n‮0001\n0001\n'
    expect(found(text, opts('‮'))).toEqual([[1, 0]])
  })

  it('stops one past MAX_FIND', () => {
    const text = `a\n${'x\n'.repeat(MAX_FIND + 5)}`
    const p = parseCsv(text, ',')
    if (!p.ok) throw new Error('parse')
    const cache = viewCache(text, p.table)
    const rows = computeView(cache, { sort: null, filter: '', header: true })
    const m = findMatches(cache, rows, [0], matcher(opts('x')))
    expect(m.length).toBe(2 * (MAX_FIND + 1))
  })
})

describe('matchFrom', () => {
  const m = Int32Array.from([0, 1, 2, 0, 2, 3, 5, 1])
  it.each([
    [0, 0, 0],
    [0, 1, 0],
    [0, 2, 1],
    [2, 0, 1],
    [2, 1, 2],
    [2, 3, 2],
    [3, 0, 3],
    [5, 1, 3],
    [5, 2, 4],
  ])('(%i, %i) is at %i', (pos, at, k) => {
    expect(matchFrom(m, pos, at)).toBe(k)
  })
})
