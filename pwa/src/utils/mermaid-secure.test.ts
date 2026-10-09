// The real Mermaid, not a mock: a %%{init}%% directive or a frontmatter
// config: of the file must not change the keys mermaidConfig locks.
import mermaid from 'mermaid'
import { describe, expect, it } from 'vitest'
import { mermaidConfig, renderMermaid } from './mermaid-render'

const LOCKED = {
  htmlLabels: false,
  layout: 'dagre',
  securityLevel: 'strict',
  theme: 'dark',
  themeCSS: undefined,
  maxEdges: 500,
}

function lockedOf(config: object) {
  const values = config as Record<string, unknown>
  return Object.fromEntries(Object.keys(LOCKED).map((k) => [k, values[k]]))
}

describe('mermaid secure keys', () => {
  it.each([
    [
      'directive',
      '%%{init: {"htmlLabels": true, "layout": "elk", "securityLevel": "loose", "theme": "forest", "themeCSS": "svg{background:url(/api/mux/health)}", "maxEdges": 99999}}%%\nflowchart LR\n  A --> B',
    ],
    [
      'frontmatter',
      '---\nconfig:\n  htmlLabels: true\n  layout: elk\n  securityLevel: loose\n  theme: forest\n  themeCSS: "svg{background:url(/api/mux/health)}"\n  maxEdges: 99999\n---\nflowchart LR\n  A --> B',
    ],
  ])('a %s keeps the locked values', async (_, source) => {
    mermaid.initialize(mermaidConfig('dark'))
    await mermaid.parse(source)
    expect(lockedOf(mermaid.mermaidAPI.getConfig())).toEqual(LOCKED)
  })

  // Shows the cases above can fail: Mermaid's own secure list lets them through
  it('without the list a directive changes them', async () => {
    const { secure: _, ...open } = mermaidConfig('dark')
    mermaid.initialize(open)
    await mermaid.parse(
      '%%{init: {"htmlLabels": true, "layout": "elk", "theme": "forest"}}%%\nflowchart LR\n  A --> B',
    )
    expect(mermaid.mermaidAPI.getConfig()).toMatchObject({
      htmlLabels: true,
      layout: 'elk',
      theme: 'forest',
    })
  })

  // The YAML of a shape can hide its img: key from a pattern; both the
  // pattern and the parsed nodes catch it
  it.each([
    'flowchart LR\n  A@{ label: "}", img: "/x.png" }',
    'flowchart LR\n  A@{ "im\\x67": "/x.png" }',
  ])('refuses a shape that fetches, however written: %s', async (source) => {
    mermaid.initialize(mermaidConfig('light'))
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source)
    const db = diagram.db as unknown as {
      getVertices: () => Map<string, { img?: string }>
    }
    expect([...db.getVertices().values()].some((v) => v.img)).toBe(true)
    expect(
      await renderMermaid(source, 'light', new AbortController().signal),
    ).toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })

  it('a syntax error throws from getDiagramFromText', async () => {
    mermaid.initialize(mermaidConfig('light'))
    await expect(
      mermaid.mermaidAPI.getDiagramFromText('flowchart LR\n  A -->'),
    ).rejects.toThrow()
  })
})
