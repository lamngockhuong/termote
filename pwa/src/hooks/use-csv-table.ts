import { useEffect, useMemo, useRef, useState } from 'react'
import { type CsvTable, type Delimiter, parseCsv } from '../utils/csv-parse'
import { CSV_WORKER_MIN, CsvClient } from '../utils/csv-parse-client'
import { computeView, type ViewOptions, viewCache } from '../utils/csv-view'

// The parse of one text: `text` and `delimiter` say which, so a caller can
// tell a table that no longer matches the text it shows.
export type CsvTableState =
  | { status: 'parsing' }
  | {
      status: 'ready'
      text: string
      delimiter: Delimiter
      table: CsvTable
      // What the worker calls this parse (0: parsed here)
      parseId: number
    }
  | { status: 'error'; text: string; delimiter: Delimiter; line: number }

function stateOf(
  text: string,
  delimiter: Delimiter,
  parseId: number,
  res: ReturnType<typeof parseCsv>,
): CsvTableState {
  return res.ok
    ? { status: 'ready', text, delimiter, table: res.table, parseId }
    : { status: 'error', text, delimiter, line: res.line }
}

const PARSING: CsvTableState = { status: 'parsing' }

// text parsed with delimiter: here for a small text (ready at once), in a
// worker past CSV_WORKER_MIN. The worker lives as long as the component.
export function useCsvTable(text: string, delimiter: Delimiter) {
  const large = text.length > CSV_WORKER_MIN
  const client = useRef<CsvClient>(undefined)
  const here = useMemo(
    () =>
      large
        ? undefined
        : stateOf(text, delimiter, 0, parseCsv(text, delimiter)),
    [large, text, delimiter],
  )
  const [async, setAsync] = useState(PARSING)

  useEffect(() => {
    if (!large) return
    client.current ??= new CsvClient()
    const ac = new AbortController()
    setAsync(PARSING)
    client.current.parse(text, delimiter, ac.signal).then((res) => {
      if (res) setAsync(stateOf(text, delimiter, res.id, res.result))
    })
    return () => ac.abort()
  }, [large, text, delimiter])

  useEffect(
    () => () => {
      client.current?.terminate()
      client.current = undefined
    },
    [],
  )

  // Until the effect runs, the last answer is another text's
  const current =
    async.status !== 'parsing' &&
    async.text === text &&
    async.delimiter === delimiter
      ? async
      : PARSING
  return { parsed: here ?? current, client }
}

// The rows a view shows (file row indices), or undefined while the worker
// works them out.
export function useCsvRows(
  parsed: CsvTableState,
  client: { current: CsvClient | undefined },
  sort: ViewOptions['sort'],
  filter: string,
  header: boolean,
): Int32Array | undefined {
  const cache = useMemo(
    () =>
      parsed.status === 'ready'
        ? viewCache(parsed.text, parsed.table)
        : undefined,
    [parsed],
  )
  const key = JSON.stringify([sort, filter, header])
  // No sort and no filter: every row, with no work to send away
  const plain = useMemo(() => {
    if (!cache || sort || filter) return undefined
    return computeView(cache, { sort: null, filter: '', header })
  }, [cache, sort, filter, header])
  const inWorker = !!cache && !plain && cache.text.length > CSV_WORKER_MIN
  const here = useMemo(
    () =>
      cache && !plain && !inWorker
        ? computeView(cache, { sort, filter, header })
        : undefined,
    [cache, plain, inWorker, sort, filter, header],
  )
  const [async, setAsync] = useState<{
    cache: unknown
    key: string
    rows: Int32Array
  }>()

  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for sort, filter and header
  useEffect(() => {
    if (!inWorker || !cache || parsed.status !== 'ready') return
    const opts = { sort, filter, header }
    const ac = new AbortController()
    client.current ??= new CsvClient()
    client.current
      .view(parsed.parseId, opts, () => computeView(cache, opts), ac.signal)
      .then((rows) => rows && setAsync({ cache, key, rows }))
    return () => ac.abort()
  }, [inWorker, cache, key])

  if (plain || here) return plain ?? here
  return async && async.cache === cache && async.key === key
    ? async.rows
    : undefined
}
