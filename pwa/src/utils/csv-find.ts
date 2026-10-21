// Finding values in the table view: which cells of the rows shown match, in
// the order shown, never which rows show (csv-view.ts filters). Runs on the
// main thread for a small file and no regex, else in csv-find-worker.ts.
import { columnValues, type ViewCache } from './csv-view'

export interface FindOptions {
  query: string
  matchCase: boolean
  // The whole value is the query (or the regex matches all of it)
  wholeCell: boolean
  regex: boolean
}

// Matches kept at most; one more is kept to tell there are more
export const MAX_FIND = 100_000

export type Matcher = (value: string) => boolean

// What a value must be to match: null for no query, 'invalid' for a regex
// that does not compile
export function compileFind(opts: FindOptions): Matcher | 'invalid' | null {
  const { query, matchCase, wholeCell, regex } = opts
  if (!query) return null
  if (regex) {
    const flags = matchCase ? 'u' : 'iu'
    let re: RegExp
    try {
      // The query alone must compile: wrapped, `a)(b` would
      new RegExp(query, flags)
      re = new RegExp(wholeCell ? `^(?:${query})$` : query, flags)
    } catch {
      return 'invalid'
    }
    return (v) => re.test(v)
  }
  if (matchCase) {
    return wholeCell ? (v) => v === query : (v) => v.includes(query)
  }
  const q = query.toLowerCase()
  return wholeCell
    ? (v) => v.toLowerCase() === q
    : (v) => v.toLowerCase().includes(q)
}

// The cells that match, as pairs (place in rows, place in cols): row by row
// in the order shown, along the columns shown. At most MAX_FIND + 1 pairs.
export function findMatches(
  cache: ViewCache,
  rows: Int32Array,
  cols: number[],
  match: Matcher,
): Int32Array {
  const values = cols.map((c) => columnValues(cache, c))
  const out: number[] = []
  for (let p = 0; p < rows.length; p++) {
    const r = rows[p]
    for (let i = 0; i < cols.length; i++) {
      if (!match(values[i][r])) continue
      out.push(p, i)
      if (out.length > 2 * MAX_FIND) return Int32Array.from(out)
    }
  }
  return Int32Array.from(out)
}

// The index of the first match at or after (pos, at), in the order of
// matches; their count when none is
export function matchFrom(matches: Int32Array, pos: number, at: number) {
  let lo = 0
  let hi = matches.length >> 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const p = matches[2 * mid]
    if (p < pos || (p === pos && matches[2 * mid + 1] < at)) lo = mid + 1
    else hi = mid
  }
  return lo
}
