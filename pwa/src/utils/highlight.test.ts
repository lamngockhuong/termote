import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canHighlight,
  HIGHLIGHT_LOAD_TIMEOUT,
  HIGHLIGHT_MAX_BYTES,
  HIGHLIGHT_MAX_LINE,
  HIGHLIGHT_MAX_LINES,
  HIGHLIGHT_TIMEOUT,
  highlight,
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
