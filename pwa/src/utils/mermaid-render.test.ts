import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MERMAID_LOAD_TIMEOUT,
  MERMAID_MAX_BYTES,
  MERMAID_TIMEOUT,
  peekMermaid,
  renderMermaid,
  resetMermaid,
  svgToDataUrl,
} from './mermaid-render'

// Stands in for the module worker: records requests, replies on demand.
class FakeWorker {
  static all: FakeWorker[] = []
  onmessage?: (e: MessageEvent) => void
  onerror?: () => void
  posted: { id: number; source: string; fontFamily: string }[] = []
  terminated = false
  constructor(
    readonly url: URL,
    readonly opts: WorkerOptions,
  ) {
    FakeWorker.all.push(this)
  }
  postMessage(req: { id: number; source: string; fontFamily: string }) {
    this.posted.push(req)
  }
  send(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
  start(id: number) {
    this.send({ id, started: true })
  }
  draw(id: number, svg = SVG) {
    this.send({ id, svg })
  }
  fail(id: number, error: string) {
    this.send({ id, error })
  }
  terminate() {
    this.terminated = true
  }
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" class="pele" viewBox="0 0 120.5 40" width="121" height="40" style="max-width:100%;height:auto;--_bg:var(--pele-bg,#fff);color:var(--_fg)"><g><text>A&nbsp;B</text></g></svg>'

function decode(url: string) {
  return decodeURIComponent(
    url.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''),
  )
}

const signal = () => new AbortController().signal
const flush = () => new Promise((r) => setTimeout(r, 0))
const last = () => FakeWorker.all[FakeWorker.all.length - 1]

beforeEach(() => {
  resetMermaid()
  FakeWorker.all = []
  vi.stubGlobal('Worker', FakeWorker)
  document.body.style.fontFamily = 'Inter, sans-serif'
})

afterEach(() => {
  resetMermaid()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('renderMermaid', () => {
  it('draws in one module worker as a data: URL, with the page font', async () => {
    const p = renderMermaid('graph TD; A-->B', 'light', signal())
    const w = last()
    expect(FakeWorker.all).toHaveLength(1)
    expect(w.opts).toEqual({ type: 'module' })
    expect(w.posted).toEqual([
      { id: 1, source: 'graph TD; A-->B', fontFamily: 'Inter, sans-serif' },
    ])
    w.start(1)
    w.draw(1)
    const r = await p
    expect(r).toMatchObject({ ok: true, width: 121, height: 40 })
    // Nothing of the diagram in the document
    expect(document.body.querySelector('svg')).toBeNull()
  })

  it('reuses the worker, one diagram at a time', async () => {
    const a = renderMermaid('graph TD; A', 'light', signal())
    const b = renderMermaid('graph TD; B', 'light', signal())
    const w = last()
    expect(w.posted.map((r) => r.id)).toEqual([1])
    w.draw(1)
    await a
    expect(w.posted.map((r) => r.id)).toEqual([1, 2])
    w.draw(2)
    expect((await b).ok).toBe(true)
    expect(FakeWorker.all).toHaveLength(1)
  })

  it('answers from the cache next time, then peekMermaid does too', async () => {
    const p = renderMermaid('graph TD; A-->B', 'dark', signal())
    last().draw(1)
    const first = await p
    expect(await renderMermaid('graph TD; A-->B', 'dark', signal())).toEqual(
      first,
    )
    expect(peekMermaid('graph TD; A-->B', 'dark')).toEqual(first)
    expect(peekMermaid('graph TD; A-->B', 'light')).toBeUndefined()
    expect(last().posted).toHaveLength(1)
  })

  it('keeps the 50 most recently used diagrams', async () => {
    for (let i = 0; i < 51; i++) {
      const p = renderMermaid(`graph TD; N${i}`, 'light', signal())
      last().draw(i + 1)
      await p
    }
    expect(peekMermaid('graph TD; N0', 'light')).toBeUndefined()
    expect(peekMermaid('graph TD; N1', 'light')).toBeDefined()
    expect(peekMermaid('graph TD; N50', 'light')).toBeDefined()
  })

  it('never starts the worker for a source over the cap', async () => {
    const big = `graph TD;${'é'.repeat(MERMAID_MAX_BYTES / 2)}`
    expect(await renderMermaid(big, 'light', signal())).toEqual({
      ok: false,
      reason: 'too_large',
    })
    expect(FakeWorker.all).toHaveLength(0)
  })

  it.each([
    'syntax',
    'too_large',
    'unsupported',
    'render_failed',
    'load_failed',
  ])('reports %s from the worker and caches nothing', async (error) => {
    const p = renderMermaid('graph', 'light', signal())
    last().fail(1, error)
    expect(await p).toEqual({ ok: false, reason: error })
    expect(peekMermaid('graph', 'light')).toBeUndefined()
  })

  it('reports render_failed for an SVG without a viewBox', async () => {
    const p = renderMermaid('graph', 'light', signal())
    last().draw(1, '<svg width="10"></svg>')
    expect(await p).toEqual({ ok: false, reason: 'render_failed' })
  })

  it('ignores a reply that is not for the diagram it holds', async () => {
    const p = renderMermaid('graph', 'light', signal())
    const w = last()
    w.draw(7)
    w.start(7)
    w.draw(1)
    expect((await p).ok).toBe(true)
  })

  it('reports load_failed without workers', async () => {
    vi.stubGlobal('Worker', undefined)
    expect(await renderMermaid('graph', 'light', signal())).toEqual({
      ok: false,
      reason: 'load_failed',
    })
  })

  it('drops a diagram aborted before its turn', async () => {
    const first = renderMermaid('graph TD; A', 'light', signal())
    const ac = new AbortController()
    const second = renderMermaid('graph TD; B', 'light', ac.signal)
    ac.abort(new Error('gone'))
    await expect(second).rejects.toThrow('gone')
    last().draw(1)
    await first
    expect(last().posted).toHaveLength(1)
  })

  it('rejects a diagram aborted already', async () => {
    const ac = new AbortController()
    ac.abort(new Error('gone'))
    await expect(renderMermaid('graph', 'light', ac.signal)).rejects.toThrow(
      'gone',
    )
    expect(FakeWorker.all).toHaveLength(0)
  })

  it('runs an aborted diagram already in the worker to its end', async () => {
    const ac = new AbortController()
    const p = renderMermaid('graph', 'light', ac.signal)
    ac.abort(new Error('gone'))
    last().draw(1)
    expect((await p).ok).toBe(true)
  })

  it('answers a second request for the same diagram from the first render', async () => {
    const a = renderMermaid('graph', 'light', signal())
    const b = renderMermaid('graph', 'light', signal())
    last().draw(1)
    expect(await b).toEqual(await a)
    expect(last().posted).toHaveLength(1)
  })

  it('ends the worker past the timeout from the start of drawing', async () => {
    vi.useFakeTimers()
    const p = renderMermaid('graph TD; slow', 'light', signal())
    const next = renderMermaid('graph TD; next', 'light', signal())
    const w = last()
    // Loading does not count against the drawing timeout
    await vi.advanceTimersByTimeAsync(MERMAID_TIMEOUT * 2)
    w.start(1)
    await vi.advanceTimersByTimeAsync(MERMAID_TIMEOUT - 1)
    expect(w.terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toEqual({ ok: false, reason: 'timeout' })
    expect(w.terminated).toBe(true)
    // The next diagram gets a new worker
    expect(FakeWorker.all).toHaveLength(2)
    last().draw(2)
    expect((await next).ok).toBe(true)
  })

  it('ends the worker when loading takes too long', async () => {
    vi.useFakeTimers()
    const p = renderMermaid('graph', 'light', signal())
    await vi.advanceTimersByTimeAsync(MERMAID_LOAD_TIMEOUT)
    expect(await p).toEqual({ ok: false, reason: 'load_failed' })
    expect(FakeWorker.all[0].terminated).toBe(true)
  })

  it('reports load_failed when the worker fails, then starts a new one', async () => {
    const p = renderMermaid('graph TD; A', 'light', signal())
    FakeWorker.all[0].onerror?.()
    expect(await p).toEqual({ ok: false, reason: 'load_failed' })
    expect(FakeWorker.all[0].terminated).toBe(true)
    const q = renderMermaid('graph TD; B', 'light', signal())
    expect(FakeWorker.all).toHaveLength(2)
    last().draw(2)
    expect((await q).ok).toBe(true)
  })

  it('ends the worker after a chunk failed to load in it', async () => {
    const p = renderMermaid('graph TD; A', 'light', signal())
    const q = renderMermaid('graph TD; B', 'light', signal())
    const first = last()
    first.fail(1, 'load_failed')
    expect(await p).toEqual({ ok: false, reason: 'load_failed' })
    expect(first.terminated).toBe(true)
    expect(FakeWorker.all).toHaveLength(2)
    last().draw(2)
    expect((await q).ok).toBe(true)
  })

  it('ignores a late error of a worker already ended', async () => {
    vi.useFakeTimers()
    const p = renderMermaid('graph TD; A', 'light', signal())
    const old = last()
    old.start(1)
    await vi.advanceTimersByTimeAsync(MERMAID_TIMEOUT)
    await p
    const q = renderMermaid('graph TD; B', 'light', signal())
    const fresh = last()
    old.onerror?.()
    expect(fresh.terminated).toBe(false)
    fresh.draw(2)
    expect((await q).ok).toBe(true)
  })

  it('a worker error with nothing running only ends the worker', async () => {
    const p = renderMermaid('graph', 'light', signal())
    const w = last()
    w.draw(1)
    await p
    w.onerror?.()
    await flush()
    expect(w.terminated).toBe(true)
  })
})

describe('svgToDataUrl', () => {
  it('sizes the SVG by its viewBox, fixes its size and makes it valid XML', () => {
    const r = svgToDataUrl(
      '<svg id="m" width="100%" height="5" style="max-width:100%;height:auto;--_bg:var(--pele-bg,#fff)" viewBox="-8 -8 200.2 99.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><text>a&nbsp;b<br>c</text><use xlink:href="#x"/></svg>',
    )
    expect(r).toMatchObject({ width: 201, height: 100 })
    const xml = decode(r?.url ?? '')
    expect(xml).toBe(
      '<svg id="m" viewBox="-8 -8 200.2 99.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="--_bg:var(--pele-bg,#fff)" width="201" height="100"><text>a&#160;b<br/>c</text><use xlink:href="#x"/></svg>',
    )
    expect(
      new DOMParser()
        .parseFromString(xml, 'image/svg+xml')
        .querySelector('parsererror'),
    ).toBeNull()
  })

  it('puts the dark palette before the variables that read it', () => {
    const xml = decode(svgToDataUrl(SVG, 'dark')?.url ?? '')
    const style = /style="([^"]*)"/.exec(xml)?.[1] ?? ''
    expect(style.startsWith('--pele-bg:#1a1a1d;')).toBe(true)
    expect(style).toContain(';--_bg:var(--pele-bg,#fff);color:var(--_fg)')
    expect(style).not.toContain('max-width')
    expect(decode(svgToDataUrl(SVG, 'light')?.url ?? '')).not.toContain(
      '--pele-bg:',
    )
  })

  it('keeps a single-quoted style holding double quotes', () => {
    const xml = decode(
      svgToDataUrl(
        `<svg viewBox="0 0 1 1" style='font-family:"A B",sans-serif'></svg>`,
        'dark',
      )?.url ?? '',
    )
    expect(xml).toContain('font-family:&quot;A B&quot;,sans-serif')
    const doc = new DOMParser().parseFromString(xml, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.documentElement.getAttribute('style')).toContain(
      'font-family:"A B",sans-serif',
    )
  })

  it('a dark SVG without a style gets one', () => {
    expect(
      decode(svgToDataUrl('<svg viewBox="0 0 1 1"></svg>', 'dark')?.url ?? ''),
    ).toMatch(/^<svg viewBox="0 0 1 1" style="--pele-bg:#1a1a1d;[^"]*" xmlns=/)
  })

  it('adds the namespaces an <img> needs', () => {
    const xml = decode(
      svgToDataUrl('<svg viewBox="0 0 10 10"><use xlink:href="#a"></use></svg>')
        ?.url ?? '',
    )
    expect(xml).toBe(
      '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><use xlink:href="#a"></use></svg>',
    )
    expect(
      decode(svgToDataUrl("<svg viewBox='0,0,4,3'><g/></svg>")?.url ?? ''),
    ).toBe(
      '<svg viewBox=\'0,0,4,3\' xmlns="http://www.w3.org/2000/svg" width="4" height="3"><g/></svg>',
    )
  })

  it.each([
    ['no <svg>', '<div viewBox="0 0 1 1"></div>'],
    ['no viewBox', '<svg width="10"></svg>'],
    ['an empty viewBox', '<svg viewBox="0 0 0 10"></svg>'],
    ['a viewBox that is no number', '<svg viewBox="0 0 1e 10"></svg>'],
  ])('refuses %s', (_, svg) => {
    expect(svgToDataUrl(svg)).toBeNull()
  })
})
