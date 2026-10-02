import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canHighlight,
  HIGHLIGHT_CONCURRENCY,
  HIGHLIGHT_LOAD_TIMEOUT,
  HIGHLIGHT_MAX_BYTES,
  HIGHLIGHT_MAX_LINE,
  HIGHLIGHT_MAX_LINES,
  HIGHLIGHT_TIMEOUT,
  highlight,
  highlightLang,
  resetHighlighter,
} from './highlight'

// Stands in for the module worker: records requests, replies on demand.
class FakeWorker {
  static all: FakeWorker[] = []
  onmessage?: (e: MessageEvent) => void
  onerror?: () => void
  posted: { id: number; lang: string; theme: string }[] = []
  terminated = false
  constructor(
    readonly url: URL,
    readonly opts: WorkerOptions,
  ) {
    FakeWorker.all.push(this)
  }
  postMessage(req: { id: number; lang: string; theme: string }) {
    this.posted.push(req)
  }
  start(id: number) {
    this.onmessage?.(
      new MessageEvent('message', { data: { id, started: true } }),
    )
  }
  reply(id: number, lines: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: { id, lines } }))
  }
  terminate() {
    this.terminated = true
  }
}

describe('canHighlight', () => {
  it('takes ordinary code', () => {
    expect(canHighlight('const a = 1\nconst b = 2\n')).toBe(true)
  })

  it.each([
    ['too many bytes', 'x'.repeat(HIGHLIGHT_MAX_BYTES + 1)],
    ['too many lines', '\n'.repeat(HIGHLIGHT_MAX_LINES)],
    ['a line too long', `a\n${'x'.repeat(HIGHLIGHT_MAX_LINE + 1)}`],
  ])('refuses %s', (_, text) => {
    expect(canHighlight(text)).toBe(false)
  })
})

describe('highlight', () => {
  beforeEach(() => {
    FakeWorker.all = []
    vi.stubGlobal('Worker', FakeWorker)
    vi.useFakeTimers()
  })
  afterEach(() => {
    resetHighlighter()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('tokenizes in one module worker, reused for the next file', async () => {
    const a = highlight('a', 'x.ts', 'dark')
    const b = highlight('b', 'y.go', 'light')
    expect(FakeWorker.all).toHaveLength(1)
    const w = FakeWorker.all[0]
    expect(w.opts).toEqual({ type: 'module' })
    expect(w.posted).toMatchObject([
      { id: 1, lang: 'typescript', theme: 'dark', text: 'a' },
      { id: 2, lang: 'go', theme: 'light', text: 'b' },
    ])
    w.reply(2, [[['b']]])
    w.reply(1, null)
    // A reply for nothing pending is ignored
    w.reply(9, [])
    expect(await b).toEqual([[['b']]])
    expect(await a).toBeNull()
  })

  // Fills every slot of the worker: the next file waits its turn
  const fill = () =>
    Array.from({ length: HIGHLIGHT_CONCURRENCY }, (_, i) =>
      highlightLang(`busy${i}`, 'typescript', 'dark'),
    )

  it('sends a file once the worker has room', async () => {
    const busy = fill()
    const next = highlightLang('next', 'go', 'dark')
    const w = FakeWorker.all[0]
    expect(w.posted).toHaveLength(HIGHLIGHT_CONCURRENCY)
    w.reply(2, [])
    expect(await busy[1]).toEqual([])
    expect(w.posted[w.posted.length - 1]).toMatchObject({
      text: 'next',
      lang: 'go',
    })
    w.reply(HIGHLIGHT_CONCURRENCY + 1, [[['next']]])
    expect(await next).toEqual([[['next']]])
  })

  it('never sends a file whose block is gone before its turn', async () => {
    fill()
    const ac = new AbortController()
    const gone = highlightLang('gone', 'go', 'dark', ac.signal)
    const after = highlightLang('after', 'go', 'dark')
    ac.abort()
    expect(await gone).toBeNull()
    const w = FakeWorker.all[0]
    w.reply(1, [])
    // gone is skipped: after goes next
    expect(w.posted.map((r) => r.id)).toEqual([
      ...Array.from({ length: HIGHLIGHT_CONCURRENCY }, (_, i) => i + 1),
      HIGHLIGHT_CONCURRENCY + 2,
    ])
    w.reply(HIGHLIGHT_CONCURRENCY + 2, [[['after']]])
    expect(await after).toEqual([[['after']]])
  })

  it('answers null at once for a block gone while it is tokenized', async () => {
    const ac = new AbortController()
    const a = highlightLang('a', 'typescript', 'dark', ac.signal)
    ac.abort()
    expect(await a).toBeNull()
    // The worker still finishes it; its answer changes nothing
    FakeWorker.all[0].reply(1, [[['a']]])
    expect(await a).toBeNull()
  })

  it('lets go of the signal once the answer is in', async () => {
    const ac = new AbortController()
    const remove = vi.spyOn(ac.signal, 'removeEventListener')
    const a = highlightLang('a', 'typescript', 'dark', ac.signal)
    FakeWorker.all[0].reply(1, [[['a']]])
    expect(await a).toEqual([[['a']]])
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    // Aborted afterwards: nothing to drop
    ac.abort()
  })

  it('sends nothing for a block already gone', async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await highlightLang('a', 'typescript', 'dark', ac.signal)).toBeNull()
    expect(FakeWorker.all[0].posted).toEqual([])
  })

  it('counts the download timeout from when the file is sent', async () => {
    const busy = fill()
    const next = highlightLang('next', 'go', 'dark')
    const w = FakeWorker.all[0]
    vi.advanceTimersByTime(HIGHLIGHT_LOAD_TIMEOUT - 1)
    for (let id = 1; id <= HIGHLIGHT_CONCURRENCY; id++) w.reply(id, [])
    await Promise.all(busy)
    // next waited for room: its own download time starts now
    vi.advanceTimersByTime(HIGHLIGHT_LOAD_TIMEOUT - 1)
    expect(w.terminated).toBe(false)
    vi.advanceTimersByTime(1)
    expect(w.terminated).toBe(true)
    expect(await next).toBeNull()
  })

  it('shows plain every file waiting when the worker is ended', async () => {
    fill()
    const next = highlightLang('next', 'go', 'dark')
    FakeWorker.all[0].onerror!()
    expect(await next).toBeNull()
  })

  it('does not start the worker for plain text or a file too big', async () => {
    expect(await highlight('a', 'notes.txt', 'dark')).toBeNull()
    expect(
      await highlight('x'.repeat(HIGHLIGHT_MAX_BYTES + 1), 'a.ts', 'dark'),
    ).toBeNull()
    expect(FakeWorker.all).toHaveLength(0)
  })

  it('shows plain where workers do not exist', async () => {
    vi.stubGlobal('Worker', undefined)
    expect(await highlight('a', 'a.ts', 'dark')).toBeNull()
  })

  it('counts the timeout from the start of tokenizing, not the download', async () => {
    const a = highlight('a', 'a.ts', 'dark')
    // A slow download of the worker and grammar is not a stuck grammar
    vi.advanceTimersByTime(HIGHLIGHT_TIMEOUT * 3)
    const w = FakeWorker.all[0]
    expect(w.terminated).toBe(false)
    w.start(1)
    // Started for nothing pending: ignored
    w.start(9)
    vi.advanceTimersByTime(HIGHLIGHT_TIMEOUT - 1)
    expect(w.terminated).toBe(false)
    vi.advanceTimersByTime(1)
    expect(w.terminated).toBe(true)
    expect(await a).toBeNull()
  })

  it('gives up on a download that never ends', async () => {
    const a = highlight('a', 'a.ts', 'dark')
    vi.advanceTimersByTime(HIGHLIGHT_LOAD_TIMEOUT)
    expect(await a).toBeNull()
    expect(FakeWorker.all[0].terminated).toBe(true)
  })

  it('gives up after the timeout and ends the stuck worker', async () => {
    const a = highlight('a', 'a.ts', 'dark')
    const b = highlight('b', 'b.ts', 'dark')
    FakeWorker.all[0].start(1)
    vi.advanceTimersByTime(HIGHLIGHT_TIMEOUT)
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    expect(FakeWorker.all[0].terminated).toBe(true)
    // The next file starts a new worker
    highlight('c', 'c.ts', 'dark')
    expect(FakeWorker.all).toHaveLength(2)
  })

  it('a worker that fails to load shows every pending file plain', async () => {
    const a = highlight('a', 'a.ts', 'dark')
    FakeWorker.all[0].onerror!()
    expect(await a).toBeNull()
  })
})
