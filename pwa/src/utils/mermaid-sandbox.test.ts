import { afterEach, describe, expect, it, vi } from 'vitest'
import { relay, workerFromSource } from './mermaid-sandbox'

// A framed window: its parent records what it is told
function framed() {
  const parent = { postMessage: vi.fn() } as unknown as Window
  const listeners: ((e: MessageEvent) => void)[] = []
  const win = {
    parent,
    addEventListener: (_: string, fn: (e: MessageEvent) => void) => {
      listeners.push(fn)
    },
  } as unknown as Window
  const told = () =>
    vi.mocked(parent.postMessage).mock.calls.map((c) => [c[0], c[1]])
  const receive = (data: unknown, source: unknown = parent) => {
    for (const fn of listeners)
      fn(new MessageEvent('message', { data, source: source as Window }))
  }
  return { win, parent, told, receive, listeners }
}

class FakeWorker {
  onmessage?: (e: MessageEvent) => void
  onerror?: () => void
  posted: unknown[] = []
  postMessage(data: unknown) {
    this.posted.push(data)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('relay', () => {
  it('starts the worker, then says it is ready to the page that framed it', () => {
    const { win, told } = framed()
    const w = new FakeWorker()
    relay(win, () => w as unknown as Worker)
    expect(told()).toEqual([[{ ready: true }, '*']])
  })

  it('passes a well-formed request from the page to the worker, fields copied', () => {
    const { win, receive } = framed()
    const w = new FakeWorker()
    relay(win, () => w as unknown as Worker)
    receive({ id: 4, source: 'pie', fontFamily: 'Inter', extra: 'x' })
    expect(w.posted).toEqual([{ id: 4, source: 'pie', fontFamily: 'Inter' }])
  })

  it('drops a request from another window, or a malformed one', () => {
    const { win, receive } = framed()
    const w = new FakeWorker()
    relay(win, () => w as unknown as Worker)
    receive({ id: 4, source: 'pie', fontFamily: 'Inter' }, win)
    for (const data of [
      null,
      'pie',
      { id: '4', source: 'pie', fontFamily: 'Inter' },
      { id: 4, source: 1, fontFamily: 'Inter' },
      { id: 4, source: 'pie' },
    ])
      receive(data)
    expect(w.posted).toEqual([])
  })

  it('passes the replies of the worker back to the page', () => {
    const { win, told } = framed()
    const w = new FakeWorker()
    relay(win, () => w as unknown as Worker)
    w.onmessage?.(
      new MessageEvent('message', { data: { id: 4, svg: '<svg/>' } }),
    )
    expect(told()[1]).toEqual([{ id: 4, svg: '<svg/>' }, '*'])
  })

  it('says it is broken when the worker fails, or cannot start', () => {
    const a = framed()
    const w = new FakeWorker()
    relay(a.win, () => w as unknown as Worker)
    w.onerror?.()
    expect(a.told()[1]).toEqual([{ broken: true }, '*'])

    const b = framed()
    relay(b.win, () => {
      throw new Error('no workers here')
    })
    expect(b.told()).toEqual([[{ broken: true }, '*']])
    expect(b.listeners).toHaveLength(0)
  })

  it('does nothing in a window nobody framed', () => {
    const start = vi.fn()
    const win = { addEventListener: vi.fn() } as unknown as Window
    ;(win as { parent: Window }).parent = win
    relay(win, start)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('workerFromSource', () => {
  it('starts a classic worker from a blob: URL of the source', async () => {
    const made: { url: string; opts?: WorkerOptions }[] = []
    vi.stubGlobal(
      'Worker',
      class {
        constructor(url: string, opts?: WorkerOptions) {
          made.push({ url, opts })
        }
      },
    )
    let blob: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blob = b as Blob
      return 'blob:null/1'
    })
    workerFromSource('self.onmessage = null')
    expect(made).toEqual([{ url: 'blob:null/1', opts: undefined }])
    expect(blob?.type).toBe('text/javascript')
    expect(await blob?.text()).toBe('self.onmessage = null')
  })
})
