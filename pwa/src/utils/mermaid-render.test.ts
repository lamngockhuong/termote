import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MERMAID_LOAD_TIMEOUT,
  MERMAID_MAX_BYTES,
  MERMAID_READY_WAIT,
  MERMAID_SANDBOX_URL,
  MERMAID_TIMEOUT,
  peekMermaid,
  renderMermaid,
  resetMermaid,
  svgToDataUrl,
} from './mermaid-render'

// The sandboxed iframe as the page sees it: requests posted to its window,
// replies that seem to come from it (jsdom loads no page in it).
type Req = { id: number; source: string; fontFamily: string }
function frames(): HTMLIFrameElement[] {
  return [...document.querySelectorAll('iframe')]
}
function frame(): HTMLIFrameElement {
  const all = frames()
  return all[all.length - 1]
}
const posted = new WeakMap<HTMLIFrameElement, Req[]>()
function requests(f = frame()): Req[] {
  return posted.get(f) ?? []
}
// Starts recording what is posted to the newest frame
function watch(f = frame()) {
  if (posted.has(f)) return
  const list: Req[] = []
  posted.set(f, list)
  vi.spyOn(f.contentWindow as Window, 'postMessage').mockImplementation(
    (data: unknown) => {
      list.push(data as Req)
    },
  )
}
function send(data: unknown, f = frame()) {
  window.dispatchEvent(
    new MessageEvent('message', { data, source: f.contentWindow }),
  )
}
const ready = (f = frame()) => {
  watch(f)
  send({ ready: true }, f)
}
const start = (id: number, f = frame()) => send({ id, started: true }, f)
const draw = (id: number, svg = SVG, f = frame()) => send({ id, svg }, f)
const failWith = (id: number, error: string, f = frame()) =>
  send({ id, error }, f)

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" class="pele" viewBox="0 0 120.5 40" width="121" height="40" style="max-width:100%;height:auto;--_bg:var(--pele-bg,#fff);color:var(--_fg)"><g><text>A&nbsp;B</text></g></svg>'

function decode(url: string) {
  return decodeURIComponent(
    url.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''),
  )
}

const signal = () => new AbortController().signal
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  resetMermaid()
  document.body.style.fontFamily = 'Inter, sans-serif'
})

afterEach(() => {
  resetMermaid()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('renderMermaid', () => {
  it('draws in one hidden sandboxed iframe as a data: URL, with the page font', async () => {
    const p = renderMermaid('graph TD; A-->B', 'light', signal())
    const f = frame()
    expect(frames()).toHaveLength(1)
    expect(f.getAttribute('sandbox')).toBe('allow-scripts')
    expect(f.getAttribute('src')).toBe(MERMAID_SANDBOX_URL)
    expect(f.hidden).toBe(true)
    expect(f.getAttribute('aria-hidden')).toBe('true')
    expect(f.tabIndex).toBe(-1)
    // Nothing is sent before the sandbox says it is ready
    watch(f)
    expect(requests(f)).toEqual([])
    send({ ready: true }, f)
    expect(requests(f)).toEqual([
      { id: 1, source: 'graph TD; A-->B', fontFamily: 'Inter, sans-serif' },
    ])
    expect(
      vi.mocked(f.contentWindow?.postMessage as Window['postMessage']).mock
        .calls[0][1],
    ).toBe('*')
    start(1)
    draw(1)
    const r = await p
    expect(r).toMatchObject({ ok: true, width: 121, height: 40 })
    // Nothing of the diagram in the document
    expect(document.body.querySelector('svg')).toBeNull()
  })

  it('reuses the sandbox, one diagram at a time', async () => {
    const a = renderMermaid('graph TD; A', 'light', signal())
    const b = renderMermaid('graph TD; B', 'light', signal())
    ready()
    expect(requests().map((r) => r.id)).toEqual([1])
    draw(1)
    await a
    expect(requests().map((r) => r.id)).toEqual([1, 2])
    draw(2)
    expect((await b).ok).toBe(true)
    expect(frames()).toHaveLength(1)
  })

  it('answers from the cache next time, then peekMermaid does too', async () => {
    const p = renderMermaid('graph TD; A-->B', 'dark', signal())
    ready()
    draw(1)
    const first = await p
    expect(await renderMermaid('graph TD; A-->B', 'dark', signal())).toEqual(
      first,
    )
    expect(peekMermaid('graph TD; A-->B', 'dark')).toEqual(first)
    expect(peekMermaid('graph TD; A-->B', 'light')).toBeUndefined()
    expect(requests()).toHaveLength(1)
  })

  it('keeps the 50 most recently used diagrams', async () => {
    for (let i = 0; i < 51; i++) {
      const p = renderMermaid(`graph TD; N${i}`, 'light', signal())
      if (i === 0) ready()
      draw(i + 1)
      await p
    }
    expect(peekMermaid('graph TD; N0', 'light')).toBeUndefined()
    expect(peekMermaid('graph TD; N1', 'light')).toBeDefined()
    expect(peekMermaid('graph TD; N50', 'light')).toBeDefined()
  })

  it('never starts the sandbox for a source over the cap', async () => {
    const big = `graph TD;${'é'.repeat(MERMAID_MAX_BYTES / 2)}`
    expect(await renderMermaid(big, 'light', signal())).toEqual({
      ok: false,
      reason: 'too_large',
    })
    expect(frames()).toHaveLength(0)
  })

  it.each(['syntax', 'too_large', 'unsupported', 'render_failed'])(
    'reports %s from the sandbox and caches nothing',
    async (error) => {
      const p = renderMermaid('graph', 'light', signal())
      ready()
      failWith(1, error)
      expect(await p).toEqual({ ok: false, reason: error })
      expect(peekMermaid('graph', 'light')).toBeUndefined()
      expect(frames()).toHaveLength(1)
    },
  )

  it('takes an unknown error for render_failed', async () => {
    const p = renderMermaid('graph', 'light', signal())
    ready()
    failWith(1, '<b>made up</b>')
    expect(await p).toEqual({ ok: false, reason: 'render_failed' })
  })

  it('reports render_failed for an SVG without a viewBox', async () => {
    const p = renderMermaid('graph', 'light', signal())
    ready()
    draw(1, '<svg width="10"></svg>')
    expect(await p).toEqual({ ok: false, reason: 'render_failed' })
  })

  it('ignores what is not the sandbox, or not about the diagram it holds', async () => {
    const p = renderMermaid('graph', 'light', signal())
    const f = frame()
    ready(f)
    // Another window, or the page itself
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: 1, svg: SVG },
        source: window,
      }),
    )
    // Not an object, or a reply for another diagram, or no reply at all
    for (const data of [
      null,
      'svg',
      7,
      { id: 7, svg: SVG },
      { id: 1 },
      { id: 1, svg: 3 },
    ])
      send(data, f)
    start(7)
    await flush()
    let settled = false
    void p.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    draw(1)
    expect((await p).ok).toBe(true)
  })

  it('drops a diagram aborted before its turn', async () => {
    const first = renderMermaid('graph TD; A', 'light', signal())
    const ac = new AbortController()
    const second = renderMermaid('graph TD; B', 'light', ac.signal)
    ac.abort(new Error('gone'))
    await expect(second).rejects.toThrow('gone')
    ready()
    draw(1)
    await first
    expect(requests()).toHaveLength(1)
  })

  it('rejects a diagram aborted already', async () => {
    const ac = new AbortController()
    ac.abort(new Error('gone'))
    await expect(renderMermaid('graph', 'light', ac.signal)).rejects.toThrow(
      'gone',
    )
    expect(frames()).toHaveLength(0)
  })

  it('runs an aborted diagram already in the sandbox to its end', async () => {
    const ac = new AbortController()
    const p = renderMermaid('graph', 'light', ac.signal)
    ready()
    ac.abort(new Error('gone'))
    draw(1)
    expect((await p).ok).toBe(true)
  })

  it('answers a second request for the same diagram from the first render', async () => {
    const a = renderMermaid('graph', 'light', signal())
    const b = renderMermaid('graph', 'light', signal())
    ready()
    draw(1)
    expect(await b).toEqual(await a)
    expect(requests()).toHaveLength(1)
  })

  it('removes the sandbox past the timeout from the start of drawing', async () => {
    vi.useFakeTimers()
    const p = renderMermaid('graph TD; slow', 'light', signal())
    const next = renderMermaid('graph TD; next', 'light', signal())
    const f = frame()
    ready(f)
    // Loading does not count against the drawing timeout
    await vi.advanceTimersByTimeAsync(MERMAID_TIMEOUT * 2)
    start(1, f)
    await vi.advanceTimersByTimeAsync(MERMAID_TIMEOUT - 1)
    expect(f.isConnected).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toEqual({ ok: false, reason: 'timeout' })
    expect(f.isConnected).toBe(false)
    // The next diagram gets a new sandbox; the old one is no longer heard
    expect(frames()).toHaveLength(1)
    expect(frame()).not.toBe(f)
    draw(2, SVG, f)
    ready()
    draw(2)
    expect((await next).ok).toBe(true)
  })

  it('removes the sandbox when loading takes too long', async () => {
    vi.useFakeTimers()
    const p = renderMermaid('graph', 'light', signal())
    const f = frame()
    await vi.advanceTimersByTimeAsync(MERMAID_LOAD_TIMEOUT)
    expect(await p).toEqual({ ok: false, reason: 'load_failed' })
    expect(f.isConnected).toBe(false)
  })

  it('gives a page that loaded but never said ready a moment, then falls back', async () => {
    vi.useFakeTimers()
    const p = renderMermaid('graph', 'light', signal())
    const f = frame()
    f.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(MERMAID_READY_WAIT - 1)
    expect(f.isConnected).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toEqual({ ok: false, reason: 'load_failed' })
    expect(f.isConnected).toBe(false)
  })

  it('waits for a ready that comes after the load event', async () => {
    vi.useFakeTimers()
    const p = renderMermaid('graph', 'light', signal())
    const f = frame()
    f.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(MERMAID_READY_WAIT - 1)
    ready(f)
    await vi.advanceTimersByTimeAsync(MERMAID_READY_WAIT)
    expect(f.isConnected).toBe(true)
    // A load event once ready, or of a sandbox already removed, starts nothing
    f.dispatchEvent(new Event('load'))
    draw(1)
    expect((await p).ok).toBe(true)
    resetMermaid()
    f.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(MERMAID_READY_WAIT)
  })

  it('reports load_failed when the sandbox breaks, then starts a new one', async () => {
    const p = renderMermaid('graph TD; A', 'light', signal())
    const f = frame()
    send({ broken: true }, f)
    expect(await p).toEqual({ ok: false, reason: 'load_failed' })
    expect(f.isConnected).toBe(false)
    const q = renderMermaid('graph TD; B', 'light', signal())
    expect(frame()).not.toBe(f)
    ready()
    draw(2)
    expect((await q).ok).toBe(true)
  })

  it('starts a new sandbox after its worker failed to load', async () => {
    const p = renderMermaid('graph TD; A', 'light', signal())
    const q = renderMermaid('graph TD; B', 'light', signal())
    const first = frame()
    ready(first)
    failWith(1, 'load_failed', first)
    expect(await p).toEqual({ ok: false, reason: 'load_failed' })
    expect(first.isConnected).toBe(false)
    expect(frame()).not.toBe(first)
    ready()
    draw(2)
    expect((await q).ok).toBe(true)
  })

  it('a broken sandbox with nothing running is only removed', async () => {
    const p = renderMermaid('graph', 'light', signal())
    const f = frame()
    ready(f)
    draw(1)
    await p
    send({ broken: true }, f)
    await flush()
    expect(f.isConnected).toBe(false)
    expect(frames()).toHaveLength(0)
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

  it('names the background the diagram is drawn on, by theme', () => {
    expect(svgToDataUrl(SVG, 'dark')).toMatchObject({ background: '#1a1a1d' })
    expect(svgToDataUrl(SVG, 'light')).toMatchObject({ background: '#fff' })
    expect(svgToDataUrl(SVG)).toMatchObject({ background: '#fff' })
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
