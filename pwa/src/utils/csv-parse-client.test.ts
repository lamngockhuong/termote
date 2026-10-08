import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCsv } from './csv-parse'
import {
  CSV_LOAD_TIMEOUT,
  CSV_TIMEOUT,
  CSV_WORKER_MIN,
  CsvClient,
} from './csv-parse-client'
import type { CsvRequest } from './csv-parse-worker'

// Stands in for the module worker: records requests, replies on demand.
class FakeWorker {
  static all: FakeWorker[] = []
  onmessage?: (e: MessageEvent) => void
  onerror?: () => void
  onmessageerror?: () => void
  posted: CsvRequest[] = []
  terminated = false
  constructor(
    readonly url: URL,
    readonly opts: WorkerOptions,
  ) {
    FakeWorker.all.push(this)
  }
  postMessage(req: CsvRequest) {
    this.posted.push(req)
  }
  reply(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
  terminate() {
    this.terminated = true
  }
}

const big = `a,b\n${'1,2\n'.repeat(CSV_WORKER_MIN / 4 + 1)}`
const opts = { sort: null, filter: '', header: false }

describe('CsvClient', () => {
  beforeEach(() => {
    FakeWorker.all = []
    vi.stubGlobal('Worker', FakeWorker)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('parses small text here, without a worker', async () => {
    const c = new CsvClient()
    expect(await c.parse('a,b', ',')).toEqual({
      id: 1,
      result: parseCsv('a,b', ','),
    })
    expect(FakeWorker.all).toHaveLength(0)
  })

  it('parses large text in one module worker', async () => {
    const c = new CsvClient()
    const p = c.parse(big, ',')
    const w = FakeWorker.all[0]
    expect(w.opts).toEqual({ type: 'module' })
    expect(w.posted).toEqual([
      { type: 'parse', id: 1, text: big, delimiter: ',' },
    ])
    const result = { ok: false, line: 1, offset: 0 }
    w.reply({ type: 'parse', id: 1, result })
    // A reply for nothing pending is ignored
    w.reply({ type: 'parse', id: 9, result })
    expect(await p).toEqual({ id: 1, result })
  })

  it('answers null once aborted, and drops the late reply', async () => {
    const c = new CsvClient()
    const ac = new AbortController()
    const p = c.parse(big, ',', ac.signal)
    ac.abort()
    expect(await p).toBeNull()
    FakeWorker.all[0].reply({ type: 'parse', id: 1, result: {} })
    // Already aborted: nothing is sent
    expect(await c.parse(big, ',', ac.signal)).toBeNull()
    expect(FakeWorker.all[0].posted).toHaveLength(1)
  })

  it('lets go of the signal once the answer is in', async () => {
    const c = new CsvClient()
    const ac = new AbortController()
    const remove = vi.spyOn(ac.signal, 'removeEventListener')
    const p = c.parse(big, ',', ac.signal)
    FakeWorker.all[0].reply({ type: 'parse', id: 1, result: { ok: true } })
    await p
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it.each([
    ['fails to load', (w: FakeWorker) => w.onerror?.()],
    ['cannot read a message', (w: FakeWorker) => w.onmessageerror?.()],
    ['is slow to load', () => vi.advanceTimersByTime(CSV_LOAD_TIMEOUT)],
  ])('parses here when the worker %s, and from then on', async (_, fail) => {
    const c = new CsvClient()
    const p = c.parse(big, ',')
    const w = FakeWorker.all[0]
    fail(w)
    expect(w.terminated).toBe(true)
    expect((await p)?.result.ok).toBe(true)
    expect((await c.parse(big, ','))?.result.ok).toBe(true)
    expect(FakeWorker.all).toHaveLength(1)
  })

  it('gives a loaded worker the shorter timeout', async () => {
    const c = new CsvClient()
    const first = c.parse(big, ',')
    const w = FakeWorker.all[0]
    w.reply({ type: 'parse', id: 1, result: { ok: true } })
    await first
    const second = c.parse(big, ',')
    vi.advanceTimersByTime(CSV_TIMEOUT)
    expect(w.terminated).toBe(true)
    expect((await second)?.result.ok).toBe(true)
  })

  it('views in the worker, or here when it no longer holds the parse', async () => {
    const c = new CsvClient()
    const fallback = vi.fn(() => Int32Array.from([7]))
    const p = c.view(3, opts, fallback)
    const w = FakeWorker.all[0]
    expect(w.posted).toEqual([{ type: 'view', id: 1, parseId: 3, opts }])
    w.reply({ type: 'view', id: 1, rows: Int32Array.from([2, 1]) })
    expect(Array.from((await p) ?? [])).toEqual([2, 1])
    expect(fallback).not.toHaveBeenCalled()

    const q = c.view(3, opts, fallback)
    w.reply({ type: 'view', id: 2, rows: null })
    expect(Array.from((await q) ?? [])).toEqual([7])
  })

  it('sends one request at a time, never one given up while it waited', async () => {
    const c = new CsvClient()
    const first = c.parse(big, ',')
    const ac = new AbortController()
    const gone = c.view(1, opts, () => new Int32Array(), ac.signal)
    const next = c.view(1, opts, () => Int32Array.from([5]))
    const w = FakeWorker.all[0]
    expect(w.posted.map((r) => r.id)).toEqual([1])
    ac.abort()
    expect(await gone).toBeNull()
    w.reply({ type: 'parse', id: 1, result: { ok: true } })
    await first
    // The aborted view is skipped
    expect(w.posted.map((r) => r.id)).toEqual([1, 3])
    w.reply({ type: 'view', id: 3, rows: null })
    expect(Array.from((await next) ?? [])).toEqual([5])
  })

  it('times a request from when it is sent, after a dropped one ends', async () => {
    const c = new CsvClient()
    const first = c.parse(big, ',')
    const w = FakeWorker.all[0]
    w.reply({ type: 'parse', id: 1, result: { ok: true } })
    await first
    const ac = new AbortController()
    const dropped = c.parse(big, ',', ac.signal)
    const next = c.parse(big, ',')
    ac.abort()
    expect(await dropped).toBeNull()
    // The worker is still busy with the dropped parse: next waits, untimed
    vi.advanceTimersByTime(CSV_TIMEOUT - 1)
    w.reply({ type: 'parse', id: 2, result: { ok: true } })
    expect(w.posted.map((r) => r.id)).toEqual([1, 2, 3])
    vi.advanceTimersByTime(CSV_TIMEOUT - 1)
    expect(w.terminated).toBe(false)
    w.reply({ type: 'parse', id: 3, result: { ok: false, line: 2, offset: 0 } })
    expect((await next)?.result).toEqual({ ok: false, line: 2, offset: 0 })
  })

  it('answers null for an aborted view', async () => {
    const c = new CsvClient()
    const ac = new AbortController()
    const p = c.view(1, opts, () => new Int32Array(), ac.signal)
    ac.abort()
    expect(await p).toBeNull()
  })

  it('views here without a worker', async () => {
    vi.stubGlobal('Worker', undefined)
    const c = new CsvClient()
    const rows = await c.view(1, opts, () => Int32Array.from([1]))
    expect(Array.from(rows ?? [])).toEqual([1])
  })

  it('terminates its worker and finishes what is pending here', async () => {
    const c = new CsvClient()
    const p = c.parse(big, ',')
    c.terminate()
    expect(FakeWorker.all[0].terminated).toBe(true)
    expect((await p)?.result.ok).toBe(true)
    // Terminating twice, or with no worker, is harmless
    c.terminate()
    new CsvClient().terminate()
  })
})
