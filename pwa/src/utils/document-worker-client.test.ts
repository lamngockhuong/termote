import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DOC_LOAD_TIMEOUT,
  DOC_TIMEOUT,
  DocumentWorkerClient,
  type DocumentWorkerError,
  serveDocumentRequests,
} from './document-worker-client'

// Stands in for the module worker: records what is posted, replies on demand
class FakeWorker {
  onmessage?: (e: MessageEvent) => void
  onerror?: () => void
  onmessageerror?: () => void
  posted: { msg: { id: number; req: unknown }; transfer: Transferable[] }[] = []
  terminated = false
  postMessage(msg: { id: number; req: unknown }, transfer: Transferable[]) {
    this.posted.push({ msg, transfer })
  }
  send(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
  ready() {
    this.send({ ready: true })
  }
  answer(i: number, reply: unknown) {
    this.send({ id: this.posted[i].msg.id, reply })
  }
  terminate() {
    this.terminated = true
  }
}

let workers: FakeWorker[]
function client() {
  return new DocumentWorkerClient<string, string>(() => {
    const w = new FakeWorker()
    workers.push(w)
    return w as unknown as Worker
  })
}

// Settles in a microtask: lets a rejection be observed without a handler
const settled = <T>(p: Promise<T>) =>
  p.then(
    (v) => ({ ok: v }),
    (e: DocumentWorkerError) => ({ err: e.code }),
  )

describe('DocumentWorkerClient', () => {
  beforeEach(() => {
    workers = []
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends requests one at a time, in order, once the worker is ready', async () => {
    const c = client()
    const buf = new ArrayBuffer(4)
    const a = c.request('a', [buf])
    const b = c.request('b')
    const w = workers[0]
    expect(workers).toHaveLength(1)
    expect(w.posted).toHaveLength(0)
    w.ready()
    w.ready() // a second ready changes nothing
    expect(w.posted).toEqual([{ msg: { id: 1, req: 'a' }, transfer: [buf] }])
    w.answer(0, 'A')
    expect(await a).toBe('A')
    expect(w.posted[1].msg).toEqual({ id: 2, req: 'b' })
    // An answer to no running request is dropped
    w.send({ id: 99, reply: 'x' })
    w.answer(1, 'B')
    expect(await b).toBe('B')
    expect(c.dead).toBe(false)
  })

  it('a request that threw in the worker fails alone', async () => {
    const c = client()
    const a = settled(c.request('a'))
    workers[0].ready()
    workers[0].send({ id: 1, failed: true })
    expect(await a).toEqual({ err: 'failed' })
    expect(c.dead).toBe(false)
  })

  it('ends a worker that takes too long to load', async () => {
    const c = client()
    const a = settled(c.request('a'))
    vi.advanceTimersByTime(DOC_LOAD_TIMEOUT)
    expect(await a).toEqual({ err: 'timeout' })
    expect(workers[0].terminated).toBe(true)
    expect(c.dead).toBe(true)
    expect(await settled(c.request('b'))).toEqual({ err: 'dead' })
    expect(workers).toHaveLength(1)
  })

  it('ends a worker whose request takes too long, failing all waiting', async () => {
    const c = client()
    const a = settled(c.request('a'))
    const b = settled(c.request('b'))
    workers[0].ready()
    vi.advanceTimersByTime(DOC_TIMEOUT - 1)
    expect(workers[0].terminated).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await a).toEqual({ err: 'timeout' })
    expect(await b).toEqual({ err: 'timeout' })
    expect(workers[0].terminated).toBe(true)
  })

  it.each(['onerror', 'onmessageerror'] as const)(
    'a worker that breaks (%s) is dead',
    async (event) => {
      const c = client()
      const a = settled(c.request('a'))
      workers[0][event]?.()
      expect(await a).toEqual({ err: 'dead' })
      expect(c.dead).toBe(true)
    },
  )

  it('a worker that cannot be made is dead', async () => {
    const c = new DocumentWorkerClient<string, string>(() => {
      throw new Error('no worker')
    })
    expect(await settled(c.request('a'))).toEqual({ err: 'dead' })
    expect(c.dead).toBe(true)
  })

  it('terminate ends the worker and fails what waits', async () => {
    const c = client()
    const a = settled(c.request('a'))
    c.terminate()
    expect(await a).toEqual({ err: 'dead' })
    expect(workers[0].terminated).toBe(true)
    // Nothing made, nothing to end
    client().terminate()
  })

  it('an aborted request is never sent, or its answer dropped', async () => {
    const c = client()
    const done = new AbortController()
    done.abort()
    expect(await settled(c.request('x', [], done.signal))).toEqual({
      err: 'aborted',
    })
    expect(workers).toHaveLength(0)

    const ctl = new AbortController()
    const queued = new AbortController()
    const a = settled(c.request('a', [], ctl.signal))
    const b = settled(c.request('b', [], queued.signal))
    const d = c.request('d')
    const w = workers[0]
    w.ready()
    queued.abort()
    expect(await b).toEqual({ err: 'aborted' })
    ctl.abort()
    expect(await a).toEqual({ err: 'aborted' })
    // The running one still holds the worker until it answers
    expect(w.posted).toHaveLength(1)
    w.answer(0, 'late')
    expect(w.posted.map((p) => p.msg.req)).toEqual(['a', 'd'])
    w.answer(1, 'D')
    expect(await d).toBe('D')
  })
})

describe('serveDocumentRequests', () => {
  function scope() {
    const posted: { msg: unknown; transfer?: Transferable[] }[] = []
    const s = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage: (msg: unknown, options?: { transfer: Transferable[] }) =>
        posted.push({ msg, transfer: options?.transfer }),
    }
    return { s, posted }
  }

  it('says it is ready, then answers each request', async () => {
    const { s, posted } = scope()
    const out = new ArrayBuffer(2)
    serveDocumentRequests<string, string>(s, async (req) =>
      req === 'buf'
        ? { reply: 'B', transfer: [out] }
        : { reply: req.toUpperCase() },
    )
    expect(posted).toEqual([{ msg: { ready: true }, transfer: undefined }])
    // Its own messages come back to a page that loads it: never answered
    await s.onmessage?.(new MessageEvent('message', { data: { ready: true } }))
    await s.onmessage?.(new MessageEvent('message', { data: null }))
    await s.onmessage?.(
      new MessageEvent('message', { data: { id: 1, req: 'a' } }),
    )
    await s.onmessage?.(
      new MessageEvent('message', { data: { id: 2, req: 'buf' } }),
    )
    expect(posted.slice(1)).toEqual([
      { msg: { id: 1, reply: 'A' }, transfer: [] },
      { msg: { id: 2, reply: 'B' }, transfer: [out] },
    ])
  })

  it('answers a request that throws as failed, never with its error', async () => {
    const { s, posted } = scope()
    serveDocumentRequests<string, string>(s, () => {
      throw new Error('secret text of the file')
    })
    await s.onmessage?.(
      new MessageEvent('message', { data: { id: 7, req: 'a' } }),
    )
    expect(posted[1]).toEqual({
      msg: { id: 7, failed: true },
      transfer: undefined,
    })
  })
})
