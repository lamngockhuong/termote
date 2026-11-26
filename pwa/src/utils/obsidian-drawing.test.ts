import { compressToBase64 } from 'lz-string'
import { describe, expect, it } from 'vitest'
import { readObsidianDrawing, writeObsidianDrawing } from './obsidian-drawing'

const SCENE = JSON.stringify({ type: 'excalidraw', version: 2, elements: [] })

function md(block: string, texts = 'Hello ^abc\n\n') {
  return [
    '---',
    'excalidraw-plugin: parsed',
    'tags: [excalidraw]',
    '---',
    '==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==',
    '',
    '# Excalidraw Data',
    '',
    '## Text Elements',
    texts,
    '%%',
    '## Drawing',
    block,
    '%%',
    '',
  ].join('\n')
}

const compressed = (json: string) => {
  const c = compressToBase64(json)
  return `\`\`\`compressed-json\n${c.slice(0, 10)}\n\n${c.slice(10)}\n\n\`\`\``
}

describe('readObsidianDrawing', () => {
  it('reads a compressed scene cut into lines', () => {
    const d = readObsidianDrawing(md(compressed(SCENE)))
    expect(d?.json).toBe(SCENE)
    expect(d?.compressed).toBe(true)
  })

  it('reads a scene written as plain JSON', () => {
    const d = readObsidianDrawing(md(`\`\`\`json\n${SCENE}\n\`\`\``))
    expect(d?.json).toBe(SCENE)
    expect(d?.compressed).toBe(false)
  })

  it('finds no scene without the heading, the block or its end', () => {
    expect(readObsidianDrawing('# Notes\n```json\n{}\n```\n')).toBeUndefined()
    expect(readObsidianDrawing('## Drawing\nnothing here\n')).toBeUndefined()
    expect(readObsidianDrawing('## Drawing\n```json\n{}\n')).toBeUndefined()
  })

  it('finds no scene in a block that does not decompress', () => {
    expect(
      readObsidianDrawing('## Drawing\n```compressed-json\n\n```\n'),
    ).toBeUndefined()
  })
})

describe('writeObsidianDrawing', () => {
  const next = JSON.stringify({ type: 'excalidraw', version: 2, elements: [1] })
  const texts = [
    { id: 'a1', text: 'One' },
    { id: 'b2', text: 'Two\nlines' },
  ]

  it('compresses the scene again, in lines, and lists the texts', () => {
    const before = md(compressed(SCENE))
    const after = writeObsidianDrawing(
      before,
      readObsidianDrawing(before)!,
      next,
      texts,
    )
    expect(readObsidianDrawing(after)?.json).toBe(next)
    expect(after).toContain('## Text Elements\nOne ^a1\n\nTwo\nlines ^b2\n\n%%')
    expect(after).not.toContain('Hello ^abc')
    // What is around the scene stays as it was
    expect(after.startsWith(before.slice(0, before.indexOf('## Text')))).toBe(
      true,
    )
    expect(after.endsWith('```\n%%\n')).toBe(true)
  })

  it('cuts a long scene in lines of 256', () => {
    // Varied text: a repeated one compresses to a few characters
    const long = JSON.stringify({
      text: Array.from({ length: 400 }, (_, i) => (i * 7919) % 1000).join(),
    })
    const before = md(compressed(SCENE))
    const after = writeObsidianDrawing(
      before,
      readObsidianDrawing(before)!,
      long,
      [],
    )
    const body = after.slice(after.indexOf('```compressed-json\n') + 19)
    const lines = body.slice(0, body.indexOf('```')).split('\n\n')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0].length).toBe(256)
    expect(readObsidianDrawing(after)?.json).toBe(long)
  })

  it('writes plain JSON where the scene was plain', () => {
    const before = md(`\`\`\`json\n${SCENE}\n\`\`\``)
    const after = writeObsidianDrawing(
      before,
      readObsidianDrawing(before)!,
      next,
      [],
    )
    expect(after).toContain(`\`\`\`json\n${next}\n\`\`\``)
    expect(after).toContain('## Text Elements\n%%')
  })

  it('adds no Text Elements section where there is none', () => {
    const before = `# Excalidraw Data\n## Drawing\n\`\`\`json\n${SCENE}\n\`\`\`\n`
    const after = writeObsidianDrawing(
      before,
      readObsidianDrawing(before)!,
      next,
      texts,
    )
    expect(after).toBe(
      `# Excalidraw Data\n## Drawing\n\`\`\`json\n${next}\n\`\`\`\n`,
    )
  })

  it('ends the section at the Drawing heading when nothing else ends it', () => {
    const before = `## Text Elements\nOld ^x\n## Drawing\n\`\`\`json\n${SCENE}\n\`\`\`\n`
    const after = writeObsidianDrawing(
      before,
      readObsidianDrawing(before)!,
      SCENE,
      [{ id: 'y', text: 'New' }],
    )
    expect(after).toBe(
      `## Text Elements\nNew ^y\n\n## Drawing\n\`\`\`json\n${SCENE}\n\`\`\`\n`,
    )
  })
})

describe('the Text Elements section', () => {
  const scene = (texts: Record<string, string>) =>
    JSON.stringify({
      elements: Object.entries(texts).map(([id, t]) => ({
        id,
        type: 'text',
        originalText: t,
      })),
    })
  const file = (section: string, json: string) =>
    `# Notes\n## Text Elements\n${section}%%\n## Drawing\n\`\`\`json\n${json}\n\`\`\`\n%%\n`

  it('keeps the line of a text left as it was: its links stay', () => {
    const before = file(
      'See [[Note]] ^a\n\n![[Note#Part]] ^b\n\nGone ^c\n\n',
      scene({ a: 'See Note', b: 'Part shown', c: 'Gone' }),
    )
    const read = readObsidianDrawing(before)!
    expect(read.raw).toEqual({
      a: 'See [[Note]]',
      b: '![[Note#Part]]',
      c: 'Gone',
    })
    const after = writeObsidianDrawing(before, read, '{}', [
      { id: 'a', text: 'See Note' },
      { id: 'b', text: 'Changed' },
      { id: 'd', text: 'New' },
    ])
    expect(after).toContain(
      '## Text Elements\nSee [[Note]] ^a\n\nChanged ^b\n\nNew ^d\n\n%%',
    )
  })

  it('takes a line of a text that starts with # as the text', () => {
    const before = file('Title\n# Big ^a\n\n', scene({ a: 'Title\n# Big' }))
    const read = readObsidianDrawing(before)!
    expect(read.raw).toEqual({ a: 'Title\n# Big' })
    const after = writeObsidianDrawing(before, read, '{}', [
      { id: 'a', text: 'Title\n# Big' },
    ])
    expect(after).toBe(file('Title\n# Big ^a\n\n', '{}'))
  })

  it('reads the scene of the last Drawing heading, not a note above it', () => {
    const md = `## Drawing\nMy own notes\n\`\`\`json\n{"mine":1}\n\`\`\`\n${file('', '{"elements":[]}')}`
    expect(readObsidianDrawing(md)?.json).toBe('{"elements":[]}')
  })

  it('knows no shown text of a scene it cannot read', () => {
    expect(readObsidianDrawing(file('', 'not json'))?.shown).toEqual({})
    expect(readObsidianDrawing(file('', '{"elements":3}'))?.shown).toEqual({})
    expect(
      readObsidianDrawing(file('', '{"elements":[null,{"type":"text"}]}'))
        ?.shown,
    ).toEqual({})
    expect(
      readObsidianDrawing(file('', '{"elements":[{"type":"text","id":"x"}]}'))
        ?.shown,
    ).toEqual({ x: '' })
  })
})
