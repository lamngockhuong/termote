import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FindOptions } from '../utils/csv-find'
import type { FindRequest } from '../utils/csv-find-worker'
import { type CsvTable, parseCsv } from '../utils/csv-parse'
import { CSV_LOAD_TIMEOUT, CSV_WORKER_MIN } from '../utils/csv-parse-client'
import { useCsvFind } from './use-csv-find'

// Stands in for the search worker: answers through the real handler, when
// told to
class FakeWorker {
  static all: FakeWorker[] = []
  onmessage?: (e: MessageEvent) => void
  onerror?: () => void
  pending: FindRequest[] = []
  terminated = false
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(req: FindRequest) {
    this.pending.push(req)
  }
  async flush() {
    const { handleFind } = await import('../utils/csv-find-worker')
    for (const req of this.pending.splice(0)) {
      const [data] = handleFind(req)
      this.onmessage?.(new MessageEvent('message', { data }))
    }
  }
  terminate() {
    this.terminated = true
  }
}

const opts = (query: string, over: Partial<FindOptions> = {}): FindOptions => ({
  query,
  matchCase: false,
  wholeCell: false,
  regex: false,
  ...over,
})

function tableOf(text: string): CsvTable {
  const p = parseCsv(text, ',')
  if (!p.ok) throw new Error('parse')
  return p.table
}

const small = 'a,b\nbeta,x\ny,beta\n'
const rows = Int32Array.from([1, 2])
const cols = [0, 1]

interface Props {
  text: string
  table?: CsvTable
  rows?: Int32Array
  opts: FindOptions
}

function setup(props: Props) {
  return renderHook(
    (p: Props) => useCsvFind(p.text, ',', p.table, p.rows, cols, p.opts),
    { initialProps: props },
  )
}

describe('useCsvFind', () => {
  beforeEach(() => {
    FakeWorker.all = []
    vi.stubGlobal('Worker', FakeWorker)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('finds nothing for no query, and says a bad regex is invalid', () => {
    const table = tableOf(small)
    const { result, rerender } = setup({
      text: small,
      table,
      rows,
      opts: opts(''),
    })
    expect(result.current).toEqual({
      matches: new Int32Array(),
      status: 'ready',
    })
    rerender({ text: small, table, rows, opts: opts('(', { regex: true }) })
    expect(result.current.status).toBe('invalid')
    expect(FakeWorker.all).toHaveLength(0)
  })

  it('finds in a small text here, without a worker', () => {
    const { result } = setup({
      text: small,
      table: tableOf(small),
      rows,
      opts: opts('beta'),
    })
    expect(result.current).toEqual({
      matches: Int32Array.from([0, 0, 1, 1]),
      status: 'ready',
    })
    expect(FakeWorker.all).toHaveLength(0)
  })

  it('is busy while the rows are worked out', () => {
    const { result } = setup({
      text: small,
      table: undefined,
      rows: undefined,
      opts: opts('beta'),
    })
    expect(result.current.status).toBe('busy')
  })

  it('finds with a regex in the worker, and drops an answer of an older search', async () => {
    const table = tableOf(small)
    const { result, rerender, unmount } = setup({
      text: small,
      table,
      rows,
      opts: opts('^b', { regex: true }),
    })
    expect(result.current.status).toBe('busy')
    const w = FakeWorker.all[0]
    await act(() => w.flush())
    expect(result.current).toEqual({
      matches: Int32Array.from([0, 0, 1, 1]),
      status: 'ready',
    })
    // Other rows: busy until their answer, never the old one
    const fewer = Int32Array.from([2])
    rerender({
      text: small,
      table,
      rows: fewer,
      opts: opts('^b', { regex: true }),
    })
    expect(result.current.status).toBe('busy')
    await act(() => FakeWorker.all.at(-1)?.flush())
    expect(result.current.matches).toEqual(Int32Array.from([0, 1]))
    unmount()
    expect(FakeWorker.all.at(-1)?.terminated).toBe(true)
  })

  it('finds in a large text in the worker, even with no regex', async () => {
    const big = `a\n${'beta\n'.repeat(CSV_WORKER_MIN / 4)}`
    const { result } = setup({
      text: big,
      table: tableOf(big),
      rows: Int32Array.from([1, 2]),
      opts: opts('beta'),
    })
    expect(result.current.status).toBe('busy')
    await act(() => FakeWorker.all[0].flush())
    expect(result.current.matches).toEqual(Int32Array.from([0, 0, 1, 0]))
  })

  it('says a search took too long, and that the worker is unavailable', async () => {
    vi.useFakeTimers()
    const table = tableOf(small)
    const { result, rerender } = setup({
      text: small,
      table,
      rows,
      opts: opts('(a+)+$', { regex: true }),
    })
    await act(async () => vi.advanceTimersByTime(CSV_LOAD_TIMEOUT))
    expect(result.current.status).toBe('timeout')
    rerender({ text: small, table, rows, opts: opts('b', { regex: true }) })
    await act(async () => FakeWorker.all.at(-1)?.onerror?.())
    expect(result.current.status).toBe('unavailable')
  })
})
