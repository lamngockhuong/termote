import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FindOptions } from './csv-find'
import { FindClient } from './csv-find-client'
import type { FindRequest } from './csv-find-worker'
import { CSV_LOAD_TIMEOUT, CSV_TIMEOUT } from './csv-parse-client'

// Stands in for the module worker: records requests, replies on demand.
class FakeWorker {
  static all: FakeWorker[] = []
  onmessage?: (e: MessageEvent) => void
  onerror?: () => void
  onmessageerror?: () => void
  posted: FindRequest[] = []
  terminated = false
  constructor(
    readonly url: URL,
    readonly opts: WorkerOptions,
  ) {
    FakeWorker.all.push(this)
  }
  postMessage(req: FindRequest) {
    this.posted.push(req)
  }
  reply(id: number, matches = Int32Array.from([0, 0]), failed?: boolean) {
    this.onmessage?.(
      new MessageEvent('message', { data: { id, matches, failed } }),
    )
  }
  terminate() {
    this.terminated = true
  }
}

const opts: FindOptions = {
  query: 'a',
  matchCase: false,
  wholeCell: false,
  regex: true,
}
const rows = Int32Array.from([1, 2])
const find = (c: FindClient, text = 'a\nb\n', signal?: AbortSignal) =>
  c.find(text, ',', rows, [0], opts, signal)

describe('FindClient', () => {
  beforeEach(() => {
    FakeWorker.all = []
    vi.stubGlobal('Worker', FakeWorker)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('sends the text once, then only what to find', async () => {
    const c = new FindClient()
    const first = find(c)
    const w = FakeWorker.all[0]
    expect(w.opts).toEqual({ type: 'module' })
    expect(w.url.pathname).toMatch(/csv-find-worker/)
    expect(w.posted[0]).toEqual({
      id: 1,
      load: { text: 'a\nb\n', delimiter: ',' },
      rows,
      cols: [0],
      opts,
    })
    // A reply for nothing running is ignored
    w.reply(9)
    w.reply(1)
    expect(await first).toEqual(Int32Array.from([0, 0]))
    const second = find(c)
    expect(w.posted[1].load).toBeUndefined()
    w.reply(2)
    await second
    // Another text, or another delimiter, is sent
    void find(c, 'b\n')
    expect(w.posted[2].load).toEqual({ text: 'b\n', delimiter: ',' })
    w.reply(3)
    void c.find('b\n', ';', rows, [0], opts)
    expect(w.posted[3].load).toEqual({ text: 'b\n', delimiter: ';' })
  })

  it('a newer search ends the worker busy with the last one, and starts another', async () => {
    const c = new FindClient()
    const first = find(c)
    const second = find(c)
    expect(await first).toBeNull()
    expect(FakeWorker.all[0].terminated).toBe(true)
    const w = FakeWorker.all[1]
    // A new worker holds no parse
    expect(w.posted[0].load).toBeDefined()
    w.reply(2)
    expect(await second).toEqual(Int32Array.from([0, 0]))
  })

  it('aborted, it ends the worker and answers null; aborted before, it sends nothing', async () => {
    const c = new FindClient()
    const ac = new AbortController()
    const p = find(c, undefined, ac.signal)
    ac.abort()
    expect(await p).toBeNull()
    expect(FakeWorker.all[0].terminated).toBe(true)
    expect(await find(c, undefined, ac.signal)).toBeNull()
    expect(FakeWorker.all).toHaveLength(1)
  })

  it('an abort after the answer changes nothing', async () => {
    const c = new FindClient()
    const ac = new AbortController()
    const p = find(c, undefined, ac.signal)
    FakeWorker.all[0].reply(1)
    await p
    const next = find(c)
    ac.abort()
    expect(FakeWorker.all[0].terminated).toBe(false)
    FakeWorker.all[0].reply(2)
    expect(await next).not.toBeNull()
  })

  it('a slow search ends the worker and says so, never searching here; the next one starts a new worker', async () => {
    const c = new FindClient()
    const p = find(c)
    vi.advanceTimersByTime(CSV_LOAD_TIMEOUT - 1)
    expect(FakeWorker.all[0].terminated).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await p).toBe('timeout')
    expect(FakeWorker.all[0].terminated).toBe(true)
    const next = find(c)
    const w = FakeWorker.all[1]
    expect(w.posted[0].load).toBeDefined()
    w.reply(2)
    expect(await next).not.toBeNull()
    // Loaded: the shorter timeout
    const slow = find(c)
    vi.advanceTimersByTime(CSV_TIMEOUT)
    expect(await slow).toBe('timeout')
  })

  it.each([
    ['fails to load', (w: FakeWorker) => w.onerror?.()],
    ['cannot read a message', (w: FakeWorker) => w.onmessageerror?.()],
  ])('is unavailable when the worker %s, and from then on', async (_, fail) => {
    const c = new FindClient()
    const p = find(c)
    fail(FakeWorker.all[0])
    expect(await p).toBe('unavailable')
    expect(FakeWorker.all[0].terminated).toBe(true)
    expect(await find(c)).toBe('unavailable')
    expect(FakeWorker.all).toHaveLength(1)
  })

  it('a search that failed says so; the worker stays', async () => {
    const c = new FindClient()
    const p = find(c)
    FakeWorker.all[0].reply(1, new Int32Array(), true)
    expect(await p).toBe('failed')
    expect(FakeWorker.all[0].terminated).toBe(false)
  })

  it('a worker that breaks after answering fails that search only', async () => {
    const c = new FindClient()
    const first = find(c)
    FakeWorker.all[0].reply(1)
    await first
    const p = find(c)
    FakeWorker.all[0].onerror?.()
    expect(await p).toBe('failed')
    expect(FakeWorker.all[0].terminated).toBe(true)
    const next = find(c)
    expect(FakeWorker.all).toHaveLength(2)
    FakeWorker.all[1].reply(3)
    expect(await next).toEqual(Int32Array.from([0, 0]))
  })

  it('is unavailable with no Worker', async () => {
    vi.stubGlobal('Worker', undefined)
    expect(await find(new FindClient())).toBe('unavailable')
  })

  it('terminate ends the search and the worker', async () => {
    const c = new FindClient()
    const p = find(c)
    c.terminate()
    expect(await p).toBeNull()
    expect(FakeWorker.all[0].terminated).toBe(true)
    // Nothing running: it still ends the worker
    c.terminate()
  })
})
