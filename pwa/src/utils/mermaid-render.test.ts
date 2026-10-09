import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isLoadError,
  MERMAID_MAX_BYTES,
  MERMAID_MAX_EDGES,
  MERMAID_TIMEOUT,
  mermaidConfig,
  peekMermaid,
  renderMermaid,
  resetMermaid,
  svgToDataUrl,
} from './mermaid-render'

const LOAD_ERROR = 'Failed to fetch dynamically imported module: /assets/x.js'

const h = vi.hoisted(() => {
  const fns = { initialize: vi.fn(), parse: vi.fn(), render: vi.fn() }
  const mermaid = {
    initialize: fns.initialize,
    render: fns.render,
    mermaidAPI: { getDiagramFromText: fns.parse },
  }
  return { ...fns, fakeMermaid: () => ({ default: mermaid }) }
})

vi.mock('mermaid', h.fakeMermaid)

const SVG = (id: string) =>
  `<svg id="${id}" width="100%" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="max-width: 120.5px;" viewBox="0 0 120.5 40"><g><text>A&nbsp;B</text></g></svg>`

// What Mermaid does: draws into the stage, adds its own nodes to <body>
function drawLikeMermaid(id: string, _src: string, stage: HTMLElement) {
  const wrap = document.createElement('div')
  wrap.id = `d${id}`
  stage.append(wrap)
  const cy = document.createElement('div')
  cy.id = 'cy'
  const tip = document.createElement('div')
  tip.className = 'mermaidTooltip'
  const measure = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const outer = document.createElement('div')
  outer.id = `i${id}`
  document.body.append(cy, tip, measure, outer)
  return Promise.resolve({ svg: SVG(id) })
}

function decode(url: string) {
  return decodeURIComponent(
    url.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''),
  )
}

const signal = () => new AbortController().signal

beforeEach(() => {
  resetMermaid()
  h.initialize.mockReset()
  h.parse.mockReset().mockResolvedValue({ db: {} })
  h.render.mockReset().mockImplementation(drawLikeMermaid)
  document.body.innerHTML = '<div id="root"></div>'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('mermaidConfig', () => {
  it('locks labels, layout, security and the font', () => {
    document.body.style.fontFamily = 'Inter, sans-serif'
    const config = mermaidConfig('dark')
    expect(config).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      layout: 'dagre',
      suppressErrorRendering: true,
      theme: 'dark',
      maxTextSize: MERMAID_MAX_BYTES,
      maxEdges: MERMAID_MAX_EDGES,
      fontFamily: 'Inter, sans-serif',
    })
    expect(config.secure).toEqual(
      expect.arrayContaining([
        'secure',
        'securityLevel',
        'htmlLabels',
        'flowchart',
        'theme',
        'themeVariables',
        'themeCSS',
        'fontFamily',
        'layout',
        'dompurifyConfig',
      ]),
    )
    expect(mermaidConfig('light').theme).toBe('default')
  })
})

describe('renderMermaid', () => {
  it('draws a diagram as a data: URL and leaves nothing in the document', async () => {
    const r = await renderMermaid('flowchart LR\n A-->B', 'light', signal())
    expect(r).toMatchObject({ ok: true, width: 121, height: 40 })
    if (!r.ok) throw new Error('not ok')
    expect(r.url).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(h.initialize).toHaveBeenCalledWith(mermaidConfig('light'))
    expect(h.render).toHaveBeenCalledWith(
      'termote-mmd-1',
      'flowchart LR\n A-->B',
      expect.any(HTMLDivElement),
    )
    const stage = h.render.mock.calls[0][2] as HTMLDivElement
    expect(stage.getAttribute('aria-hidden')).toBe('true')
    expect(stage.style.opacity).toBe('0')
    expect(stage.style.width).toBe('1200px')
    expect(document.body.innerHTML).toBe('<div id="root"></div>')
  })

  it('keeps a node the app added to <body> meanwhile', async () => {
    h.render.mockImplementation((id, src, stage) => {
      const toast = document.createElement('div')
      toast.id = 'toast'
      document.body.append(toast)
      return drawLikeMermaid(id, src, stage)
    })
    await renderMermaid('flowchart LR\n A-->B', 'light', signal())
    expect(document.body.innerHTML).toBe(
      '<div id="root"></div><div id="toast"></div>',
    )
  })

  it('answers from the cache next time, then peekMermaid does too', async () => {
    await renderMermaid('graph TD\n A', 'dark', signal())
    expect(peekMermaid('graph TD\n A', 'dark')).toMatchObject({ ok: true })
    expect(peekMermaid('graph TD\n A', 'light')).toBeUndefined()
    const again = await renderMermaid('graph TD\n A', 'dark', signal())
    expect(again.ok).toBe(true)
    expect(h.render).toHaveBeenCalledTimes(1)
  })

  it('keeps the 50 most recently used diagrams', async () => {
    for (let i = 0; i < 51; i++) {
      await renderMermaid(`graph TD\n A${i}`, 'light', signal())
      // Used again: the oldest is then A1, not A0
      if (i === 1) peekMermaid('graph TD\n A0', 'light')
    }
    expect(peekMermaid('graph TD\n A0', 'light')).toBeDefined()
    expect(peekMermaid('graph TD\n A1', 'light')).toBeUndefined()
    expect(peekMermaid('graph TD\n A50', 'light')).toBeDefined()
  })

  it('never loads Mermaid for a source over the cap', async () => {
    // 2 bytes each in UTF-8: over the cap in bytes, not in characters
    const big = 'é'.repeat(MERMAID_MAX_BYTES / 2 + 1)
    expect(await renderMermaid(big, 'light', signal())).toEqual({
      ok: false,
      reason: 'too_large',
    })
    expect(h.initialize).not.toHaveBeenCalled()
  })

  it.each([
    'flowchart LR\n A@{ img: "/api/mux/snapshot", h: 60 }',
    'flowchart LR\n A@{ shape: rect, icon: "fa:user" }',
    'flowchart LR\n A@{ "img": "https://example.com/x.png" }',
  ])('never loads Mermaid for a shape that fetches: %s', async (src) => {
    expect(await renderMermaid(src, 'light', signal())).toEqual({
      ok: false,
      reason: 'unsupported',
    })
    expect(h.initialize).not.toHaveBeenCalled()
  })

  it('reports a syntax error from parse', async () => {
    h.parse.mockRejectedValue(new Error('Parse error on line 1'))
    expect(await renderMermaid('nope', 'light', signal())).toEqual({
      ok: false,
      reason: 'syntax',
    })
    expect(h.render).not.toHaveBeenCalled()
  })

  it.each([
    ['a Map', new Map([['A', { img: '/x.png' }]])],
    ['an object', { A: { id: 'A' }, B: { icon: 'fa:user' } }],
  ])('refuses a parsed node with an image or icon (%s)', async (_, nodes) => {
    h.parse.mockResolvedValue({ db: { getVertices: () => nodes } })
    expect(await renderMermaid('flowchart LR\n A', 'light', signal())).toEqual({
      ok: false,
      reason: 'unsupported',
    })
    expect(h.render).not.toHaveBeenCalled()
  })

  it('draws a diagram whose nodes fetch nothing', async () => {
    h.parse.mockResolvedValue({
      db: { getVertices: () => new Map([['A', { id: 'A' }]]) },
    })
    expect(
      (await renderMermaid('flowchart LR\n A', 'light', signal())).ok,
    ).toBe(true)
    h.parse.mockResolvedValue({ db: { getVertices: () => undefined } })
    expect(
      (await renderMermaid('flowchart LR\n B', 'light', signal())).ok,
    ).toBe(true)
  })

  it('reports a diagram chunk that failed to load from parse', async () => {
    h.parse.mockRejectedValue(new TypeError(LOAD_ERROR))
    expect(await renderMermaid('mindmap\n a', 'light', signal())).toEqual({
      ok: false,
      reason: 'load_failed',
    })
  })

  it.each([
    ['render_failed', new Error('Cannot read properties of undefined')],
    ['load_failed', new TypeError('Importing a module script failed.')],
  ])('reports %s from render and still cleans up', async (reason, error) => {
    h.render.mockImplementation(async (id, src, stage) => {
      await drawLikeMermaid(id, src, stage)
      throw error
    })
    expect(await renderMermaid('graph TD\n A', 'light', signal())).toEqual({
      ok: false,
      reason,
    })
    expect(document.body.innerHTML).toBe('<div id="root"></div>')
  })

  it('reports render_failed when initialize throws', async () => {
    h.initialize.mockImplementation(() => {
      throw new Error('bad config')
    })
    expect(await renderMermaid('graph TD\n A', 'light', signal())).toEqual({
      ok: false,
      reason: 'render_failed',
    })
  })

  it('reports render_failed for an SVG without a viewBox', async () => {
    h.render.mockResolvedValue({ svg: '<svg width="10"></svg>' })
    expect(await renderMermaid('graph TD\n A', 'light', signal())).toEqual({
      ok: false,
      reason: 'render_failed',
    })
    expect(peekMermaid('graph TD\n A', 'light')).toBeUndefined()
  })

  it('drops a diagram aborted before its turn', async () => {
    let finish: (v: { svg: string }) => void = () => {}
    h.render.mockImplementationOnce(
      () => new Promise<{ svg: string }>((r) => (finish = r)),
    )
    const first = renderMermaid('graph TD\n A', 'light', signal())
    const ac = new AbortController()
    const second = renderMermaid('graph TD\n B', 'light', ac.signal)
    ac.abort()
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledTimes(1))
    finish({ svg: SVG('termote-mmd-1') })
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect((await first).ok).toBe(true)
    expect(h.render).toHaveBeenCalledTimes(1)
  })

  it('answers a second request for the same diagram from the first render', async () => {
    const a = renderMermaid('graph TD\n A', 'light', signal())
    const b = renderMermaid('graph TD\n A', 'light', signal())
    expect(await a).toMatchObject({ ok: true })
    expect(await b).toEqual(await a)
    expect(h.render).toHaveBeenCalledTimes(1)
  })

  it('times out from the start of its own render, not while it waits', async () => {
    vi.useFakeTimers()
    const finishers: ((v: { svg: string }) => void)[] = []
    h.render.mockImplementation(
      (id: string) =>
        new Promise<{ svg: string }>((r) =>
          finishers.push(() => r({ svg: SVG(id) })),
        ),
    )
    const first = renderMermaid('graph TD\n A', 'light', signal())
    const second = renderMermaid('graph TD\n B', 'light', signal())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.render).toHaveBeenCalledTimes(1)

    // The first takes 9 s: under its limit
    await vi.advanceTimersByTimeAsync(9000)
    finishers[0]({ svg: '' })
    expect((await first).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.render).toHaveBeenCalledTimes(2)

    // The second waited 9 s in line: its own 10 s start only now
    let secondResult: unknown
    second.then((r) => (secondResult = r))
    await vi.advanceTimersByTimeAsync(MERMAID_TIMEOUT - 1)
    expect(secondResult).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(secondResult).toEqual({ ok: false, reason: 'timeout' })
  })

  it('starts the next diagram only once a timed out one has finished', async () => {
    vi.useFakeTimers()
    let finish: () => void = () => {}
    h.render.mockImplementationOnce(
      (id: string) =>
        new Promise<{ svg: string }>(
          (r) => (finish = () => r({ svg: SVG(id) })),
        ),
    )
    const first = renderMermaid('graph TD\n A', 'light', signal())
    const second = renderMermaid('graph TD\n B', 'light', signal())
    await vi.advanceTimersByTimeAsync(MERMAID_TIMEOUT)
    expect(await first).toEqual({ ok: false, reason: 'timeout' })
    expect(h.initialize).toHaveBeenCalledTimes(1)

    finish()
    expect((await second).ok).toBe(true)
    expect(h.initialize).toHaveBeenCalledTimes(2)
    // The slow one still finished and was kept
    expect(peekMermaid('graph TD\n A', 'light')).toBeDefined()
  })
})

describe('loading Mermaid', () => {
  it('reports load_failed, then imports again next time', async () => {
    vi.resetModules()
    vi.doMock('mermaid', () => {
      throw new TypeError(LOAD_ERROR)
    })
    expect(await renderMermaid('graph TD\n A', 'light', signal())).toEqual({
      ok: false,
      reason: 'load_failed',
    })
    vi.resetModules()
    vi.doMock('mermaid', h.fakeMermaid)
    expect((await renderMermaid('graph TD\n A', 'light', signal())).ok).toBe(
      true,
    )
  })
})

describe('isLoadError', () => {
  it.each([
    [new TypeError(LOAD_ERROR), true],
    [new TypeError('error loading dynamically imported module: x'), true],
    [new TypeError('Importing a module script failed.'), true],
    [new TypeError('x is not a function'), false],
    ['Failed to fetch dynamically imported module', false],
  ])('%s → %s', (e, expected) => {
    expect(isLoadError(e)).toBe(expected)
  })
})

describe('svgToDataUrl', () => {
  it('sizes the SVG by its viewBox and makes it valid XML', () => {
    const r = svgToDataUrl(
      '<svg id="m" width="100%" height="5" style="max-width: 9px;" viewBox="-8 -8 200.2 99.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><text>a&nbsp;b<br>c</text><use xlink:href="#x"/></svg>',
    )
    expect(r).toMatchObject({ width: 201, height: 100 })
    const xml = decode(r?.url ?? '')
    expect(xml).toBe(
      '<svg id="m" viewBox="-8 -8 200.2 99.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="201" height="100"><text>a&#160;b<br/>c</text><use xlink:href="#x"/></svg>',
    )
    expect(
      new DOMParser()
        .parseFromString(xml, 'image/svg+xml')
        .querySelector('parsererror'),
    ).toBeNull()
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
