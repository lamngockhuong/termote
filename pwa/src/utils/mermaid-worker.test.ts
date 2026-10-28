import { PeleError } from 'pele'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type DrawReply,
  drawOptions,
  failureOf,
  handleRequest,
  MAX_CHARS,
  MAX_EDGES,
} from './mermaid-worker'

// jsdom has no canvas: Pele measures text with its own width table, as it
// does in a worker without OffscreenCanvas
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterAll(() => {
  vi.restoreAllMocks()
})

const draw = (source: string) =>
  handleRequest({ id: 1, source, fontFamily: 'sans-serif' })

function svgOf(reply: DrawReply): string {
  if (!('svg' in reply)) throw new Error(`no svg: ${reply.error}`)
  return reply.svg
}

describe('drawOptions', () => {
  it('turns links and images off and keeps the limits', () => {
    expect(drawOptions('Inter, sans-serif')).toEqual({
      fontFamily: 'Inter, sans-serif',
      links: false,
      images: false,
      limit: MAX_CHARS,
      maxEdges: MAX_EDGES,
    })
  })
})

describe('failureOf', () => {
  it.each([
    ['syntax', 'syntax'],
    ['semantic', 'syntax'],
    ['limit', 'too_large'],
    ['unsupported-diagram', 'unsupported'],
  ] as const)('maps %s to %s', (code, reason) => {
    expect(failureOf(new PeleError('x', code))).toBe(reason)
  })

  it('maps anything else to render_failed', () => {
    expect(failureOf(new PeleError('x', 'internal' as never))).toBe(
      'render_failed',
    )
    expect(failureOf(new Error('boom'))).toBe('render_failed')
    expect(failureOf('boom')).toBe('render_failed')
  })
})

describe('handleRequest', () => {
  it('draws a diagram, saying first that it started', async () => {
    const onStart = vi.fn()
    const reply = await handleRequest(
      { id: 3, source: 'flowchart LR\n  A --> B', fontFamily: 'sans-serif' },
      onStart,
    )
    expect(reply.id).toBe(3)
    expect(svgOf(reply)).toMatch(/^<svg[^>]*viewBox="/)
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a syntax error', 'flowchart LR\n  A -->', 'syntax'],
    ['an unknown diagram type', 'notADiagram\n  A', 'unsupported'],
  ])('reports %s by its code only', async (_, source, error) => {
    const reply = await draw(source)
    expect(reply).toEqual({ id: 1, error })
  })

  it('reports too many edges as too_large', async () => {
    const edges = Array.from(
      { length: MAX_EDGES + 1 },
      (_, i) => `  N${i} --> N${i + 1}`,
    )
    expect(await draw(`flowchart TD\n${edges.join('\n')}`)).toEqual({
      id: 1,
      error: 'too_large',
    })
  })
})

// Hostile diagrams: what reaches the SVG must run, load and link nothing
describe('a hostile diagram', () => {
  const LEAK = 'https://evil.example'
  const BAD =
    /evil\.example|javascript:|<script|\son\w+\s*=|<foreignObject|@import|<img\b|<image\b|<a\b|href=/i

  it.each([
    ['a click with a URL', `flowchart LR\n A-->B\n click A "${LEAK}" _blank`],
    ['a click with a callback', 'flowchart LR\n A-->B\n click A call alert(1)'],
    [
      'a click with javascript:',
      'flowchart LR\n A-->B\n click A href "javascript:alert(1)"',
    ],
    ['a shape with an image', `flowchart LR\n A@{ img: "${LEAK}/x.png" }`],
    [
      'a shape with an icon',
      'flowchart LR\n A@{ icon: "fa:user", form: "square", label: "x" }',
    ],
    [
      'HTML in labels',
      'flowchart LR\n A["<img src=x onerror=alert(1)>"]-->B["<script>alert(2)</script>"]',
    ],
    [
      'an init directive',
      `%%{init: {"themeCSS": "@import url(${LEAK}/c);", "securityLevel": "loose", "htmlLabels": true}}%%\nflowchart LR\n A["<b>x</b>"]-->B`,
    ],
    [
      'front matter config',
      `---\nconfig:\n  themeCSS: "* { background:url(${LEAK}/d) }"\n  htmlLabels: true\n---\nflowchart LR\n A-->B`,
    ],
    ['math in a label', 'flowchart LR\n A["$$x^2$$"]-->B'],
  ])('%s', async (_, source) => {
    expect(svgOf(await draw(source))).not.toMatch(BAD)
  })

  it('a style with a URL is refused', async () => {
    expect(
      await draw(`flowchart LR\n A-->B\n style A fill:url(${LEAK}/a)`),
    ).toEqual({ id: 1, error: 'syntax' })
  })
})

describe('the worker', () => {
  it('posts started, then the reply', async () => {
    const post = vi.spyOn(self, 'postMessage').mockImplementation(() => {})
    await self.onmessage?.(
      new MessageEvent('message', {
        data: { id: 9, source: 'pie\n "a": 1', fontFamily: 'sans-serif' },
      }),
    )
    expect(post.mock.calls[0][0]).toEqual({ id: 9, started: true })
    expect(post.mock.calls[1][0]).toMatchObject({ id: 9 })
    expect(svgOf(post.mock.calls[1][0] as DrawReply)).toContain('<svg')
    post.mockRestore()
  })
})
