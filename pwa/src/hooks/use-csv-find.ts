import { useEffect, useMemo, useRef, useState } from 'react'
import { compileFind, type FindOptions, findMatches } from '../utils/csv-find'
import { FindClient, type FindResult } from '../utils/csv-find-client'
import type { CsvTable, Delimiter } from '../utils/csv-parse'
import { CSV_WORKER_MIN } from '../utils/csv-parse-client'
import { viewCache } from '../utils/csv-view'

export type FindStatus =
  | 'ready'
  | 'busy'
  | 'invalid'
  | 'timeout'
  | 'failed'
  | 'unavailable'

export interface FindState {
  // Pairs (place in rows, place in cols), as findMatches gives them
  matches: Int32Array
  status: FindStatus
}

const NONE = new Int32Array()

// The cells of the rows shown (rows, undefined while worked out) that match
// opts: here for a small text and no regex, in a search worker of its own
// (living as long as the component) for any other. A query '' searches
// nothing. text is the one table was parsed from.
export function useCsvFind(
  text: string,
  delimiter: Delimiter,
  table: CsvTable | undefined,
  rows: Int32Array | undefined,
  cols: number[],
  opts: FindOptions,
): FindState {
  const client = useRef<FindClient>(undefined)
  const match = useMemo(() => compileFind(opts), [opts])
  // A regex may run for ever: never here
  const away = opts.regex || text.length > CSV_WORKER_MIN
  const cache = useMemo(
    () => (table && !away ? viewCache(text, table) : undefined),
    [text, table, away],
  )
  const here = useMemo(
    () =>
      typeof match === 'function' && cache && rows
        ? findMatches(cache, rows, cols, match)
        : undefined,
    [match, cache, rows, cols],
  )
  const wanted = typeof match === 'function' && away && !!table && !!rows
  const [async, setAsync] = useState<{
    key: unknown[]
    result: FindResult
  }>()
  // What a search was asked with: an answer for anything else is old
  const asked = (): unknown[] => [text, delimiter, rows, cols, opts]

  // biome-ignore lint/correctness/useExhaustiveDependencies: asked() reads text, delimiter, rows, cols and opts
  useEffect(() => {
    if (!wanted) return
    client.current ??= new FindClient()
    const ac = new AbortController()
    const key = asked()
    client.current
      .find(text, delimiter, rows as Int32Array, cols, opts, ac.signal)
      .then((result) => result && setAsync({ key, result }))
    return () => ac.abort()
  }, [wanted, text, delimiter, rows, cols, opts])

  useEffect(
    () => () => {
      client.current?.terminate()
      client.current = undefined
    },
    [],
  )

  if (match === null) return { matches: NONE, status: 'ready' }
  if (match === 'invalid') return { matches: NONE, status: 'invalid' }
  if (here) return { matches: here, status: 'ready' }
  const key = asked()
  const result = async?.key.every((k, i) => k === key[i])
    ? async.result
    : undefined
  if (!result) return { matches: NONE, status: 'busy' }
  return typeof result === 'string'
    ? { matches: NONE, status: result }
    : { matches: result, status: 'ready' }
}
