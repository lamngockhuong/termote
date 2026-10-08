import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv-parse'
import { computeView, type ViewOptions, viewCache } from './csv-view'

function cacheOf(text: string) {
  const res = parseCsv(text, ',')
  if (!res.ok) throw new Error('parse error')
  return viewCache(text, res.table)
}

const all: ViewOptions = { sort: null, filter: '', header: false }
const text = 'name,size\nb10,3\nB2,\na1,1\nzz,20\n'

describe('computeView', () => {
  it('lists every row, or all but the header', () => {
    const c = cacheOf(text)
    expect(Array.from(computeView(c, all))).toEqual([0, 1, 2, 3, 4])
    expect(Array.from(computeView(c, { ...all, header: true }))).toEqual([
      1, 2, 3, 4,
    ])
  })

  it('filters on any cell, any case, never the header', () => {
    const c = cacheOf(text)
    const opts = { ...all, header: true, filter: 'B' }
    expect(Array.from(computeView(c, opts))).toEqual([1, 2])
    // The same cache answers a second filter
    expect(Array.from(computeView(c, { ...opts, filter: '20' }))).toEqual([4])
    // "name" is only in the header
    expect(Array.from(computeView(c, { ...opts, filter: 'name' }))).toEqual([])
  })

  it('sorts numerically, both ways, with empty cells last', () => {
    const c = cacheOf(text)
    const asc = computeView(c, {
      ...all,
      header: true,
      sort: { col: 1, dir: 'asc' },
    })
    expect(Array.from(asc)).toEqual([3, 1, 4, 2])
    const desc = computeView(c, {
      ...all,
      header: true,
      sort: { col: 1, dir: 'desc' },
    })
    expect(Array.from(desc)).toEqual([4, 1, 3, 2])
  })

  it('compares text without case and numbers by value', () => {
    const c = cacheOf(text)
    const rows = computeView(c, {
      ...all,
      header: true,
      sort: { col: 0, dir: 'asc' },
    })
    expect(Array.from(rows)).toEqual([3, 2, 1, 4])
  })

  it('sorts a column a short row lacks as empty', () => {
    const c = cacheOf('a,b\nx\ny,1\n')
    const rows = computeView(c, { ...all, sort: { col: 1, dir: 'asc' } })
    expect(Array.from(rows)).toEqual([2, 0, 1])
  })
})
