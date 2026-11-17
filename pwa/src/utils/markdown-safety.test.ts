import { describe, expect, it } from 'vitest'
import {
  detailsBlocks,
  htmlAsText,
  safeUrl,
  tableCellTags,
} from './markdown-safety'

describe('safeUrl', () => {
  it('accepts http(s) URLs only', () => {
    expect(safeUrl('https://a.example/x')?.host).toBe('a.example')
    expect(safeUrl('http://a.example')).not.toBeNull()
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('not a url')).toBeNull()
    expect(safeUrl(undefined)).toBeNull()
  })
})

describe('htmlAsText', () => {
  it('turns html nodes into text, at any depth', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'html', value: '<b>' },
        { type: 'paragraph', children: [{ type: 'html', value: '<i>' }] },
      ],
    }
    htmlAsText()(tree)
    expect(tree.children[0].type).toBe('text')
    expect(tree.children[1].children?.[0].type).toBe('text')
  })
})

describe('detailsBlocks', () => {
  const html = (value: string) => ({ type: 'html', value })
  const para = (value: string) => ({
    type: 'paragraph',
    children: [{ type: 'text', value }],
  })

  it('takes a <summary> from the node after the opening one', () => {
    const tree = {
      type: 'root',
      children: [
        html('<details>'),
        html('<summary>Title</summary>'),
        para('Body'),
        html('</details>'),
      ],
    }
    detailsBlocks()(tree)
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]).toMatchObject({
      type: 'details',
      data: { hName: 'details', hProperties: {} },
      children: [
        { data: { hName: 'summary' }, children: [{ value: 'Title' }] },
        para('Body'),
      ],
    })
  })

  it('spans a disclosure from its opening tag to its closing one', () => {
    const at = (start: number, end = start) => ({
      position: { start: { line: start }, end: { line: end } },
    })
    const tree = {
      type: 'root',
      children: [
        { ...html('<details>'), ...at(3) },
        { ...para('Body'), ...at(5) },
        { ...html('</details>'), ...at(7) },
        { ...html('<details><summary>s</summary>x</details>'), ...at(9) },
      ],
    }
    detailsBlocks()(tree)
    expect(tree.children[0]).toMatchObject({ type: 'details', ...at(3, 7) })
    expect(tree.children[1]).toMatchObject({ type: 'details', ...at(9) })
  })

  it('keeps the lines of each tag split out of one HTML node', () => {
    const tree = {
      type: 'root',
      children: [
        {
          ...html('<details>\n<summary>s</summary>\n<p>a</p>\n<p>b</p>'),
          position: { start: { line: 10 }, end: { line: 13 } },
        },
        para('Body'),
        { ...html('</details>\n<p>after</p>') },
      ],
    }
    detailsBlocks()(tree)
    const [details, after] = tree.children as {
      type: string
      position?: unknown
      children?: { type: string; position?: unknown }[]
    }[]
    // The closing node had no position: neither has the disclosure
    expect(details.type).toBe('details')
    expect(details.position).toBeUndefined()
    // Its summary line came from line 11, the HTML after it from 12 to 13
    expect(details.children?.[1]).toMatchObject({
      type: 'html',
      position: {
        start: { line: 12, column: 1 },
        end: { line: 13, column: 9 },
      },
    })
    expect(after).toMatchObject({ type: 'html', value: '<p>after</p>' })
    expect(after.position).toBeUndefined()
  })

  it('never folds inside a paragraph, and drops the tags of a summary', () => {
    const inline = {
      type: 'paragraph',
      children: [html('<details>'), html('</details>')],
    }
    const tree = {
      type: 'root',
      children: [
        inline,
        html('<details><summary><b>x</b></summary></details>'),
      ],
    }
    detailsBlocks()(tree)
    expect(tree.children[0]).toBe(inline)
    expect(inline.children[0].type).toBe('html')
    expect(tree.children[1]).toMatchObject({
      type: 'details',
      children: [{ children: [{ type: 'text', value: 'x' }] }],
    })
  })

  it('reads open only as its own attribute', () => {
    const run = (open: string) => {
      const tree = { type: 'root', children: [html(open), html('</details>')] }
      detailsBlocks()(tree)
      return (tree.children[0] as unknown as { data: { hProperties: object } })
        .data.hProperties
    }
    expect(run('<details open>')).toEqual({ open: true })
    expect(run('<details open="">')).toEqual({ open: true })
    expect(run('<DETAILS data-x=1 OPEN>')).toEqual({ open: true })
    expect(run('<details class="open">')).toEqual({})
    expect(run(`<details title="a open b" data-x='open'>`)).toEqual({})
  })

  it('takes a summary with attributes, and one without a summary at all', () => {
    const tree = {
      type: 'root',
      children: [
        html('<details>\n<summary class="x">Title</summary>'),
        html('</details>'),
        html('<details>Body</details>'),
      ],
    }
    detailsBlocks()(tree)
    expect(tree.children).toMatchObject([
      { type: 'details', children: [{ children: [{ value: 'Title' }] }] },
      { type: 'details', children: [para('Body')] },
    ])
  })

  it('splits the tag lines out of an HTML block, keeping the rest together', () => {
    const tree = {
      type: 'root',
      children: [
        html('<details>'),
        para('Body'),
        html('</details>\n<p>after</p>\n<hr>'),
      ],
    }
    detailsBlocks()(tree)
    expect(tree.children).toMatchObject([
      { type: 'details', children: [para('Body')] },
      { type: 'html', value: '<p>after</p>\n<hr>' },
    ])
  })

  it('leaves disclosures nested past 32 levels as HTML', () => {
    const n = 40
    const tree = {
      type: 'root',
      children: [
        ...Array.from({ length: n }, () => html('<details>')),
        ...Array.from({ length: n }, () => html('</details>')),
      ],
    }
    detailsBlocks()(tree)
    let depth = 0
    let node = tree.children[0] as { type: string; children?: unknown[] }
    while (node.type === 'details') {
      depth++
      node = node.children?.[0] as typeof node
    }
    expect(depth).toBe(32)
    expect(node).toEqual(html('<details>'))
  })

  it('pairs tags in one pass: many unclosed ones stay fast', () => {
    const tree = {
      type: 'root',
      children: [html(Array(25_000).fill('<details>').join('\n'))],
    }
    const t = performance.now()
    detailsBlocks()(tree)
    expect(performance.now() - t).toBeLessThan(1000)
    expect(tree.children).toHaveLength(25_000)
    expect(tree.children.every((c) => c.type === 'html')).toBe(true)
  })
})

describe('tableCellTags', () => {
  const html = (value: string) => ({ type: 'html', value })
  const text = (value: string) => ({ type: 'text', value })
  const cell = (...children: { type: string }[]) => {
    const node = { type: 'tableCell', children }
    tableCellTags()({
      type: 'root',
      children: [
        { type: 'table', children: [{ type: 'tableRow', children: [node] }] },
      ],
    })
    return node.children as {
      type: string
      value?: string
      data?: object
      children?: unknown[]
    }[]
  }

  it('turns each spelling of <br> into a line break', () => {
    const out = cell(
      text('a'),
      html('<br>'),
      text('b'),
      html('<BR/>'),
      html('<br />'),
    )
    expect(out.map((n) => n.type)).toEqual([
      'text',
      'break',
      'text',
      'break',
      'break',
    ])
  })

  it('keeps a <br> with attributes, and any other tag, as html', () => {
    const out = cell(
      html('<br class="x">'),
      html('<b>'),
      text('a'),
      html('</b>'),
    )
    expect(out.map((n) => n.type)).toEqual(['html', 'html', 'text', 'html'])
  })

  it('rebuilds a list with the markdown of its items, dropping attributes', () => {
    const strong = { type: 'strong', children: [text('two')] }
    const out = cell(
      html('<ul class="x" onclick="alert(1)">'),
      html('<li>'),
      text('one'),
      html('<br>'),
      text('more'),
      html('</li>'),
      text(' '),
      html('<li>'),
      strong,
      html('</li>'),
      html('</ul>'),
    )
    expect(out).toEqual([
      {
        type: 'cellList',
        data: { hName: 'ul' },
        children: [
          {
            type: 'cellListItem',
            data: { hName: 'li' },
            children: [text('one'), { type: 'break' }, text('more')],
          },
          { type: 'cellListItem', data: { hName: 'li' }, children: [strong] },
        ],
      },
    ])
  })

  it('rebuilds a disclosure, its summary first, keeping only open', () => {
    const out = cell(
      html('<details open class="x">'),
      text(' '),
      html('<summary>'),
      text('More'),
      html('</summary>'),
      html('<ol>'),
      html('<li>'),
      text('a'),
      html('</li>'),
      html('</ol>'),
      html('</details>'),
    )
    expect(out).toMatchObject([
      {
        type: 'details',
        data: { hName: 'details', hProperties: { open: true } },
        children: [
          { data: { hName: 'summary' }, children: [text('More')] },
          { data: { hName: 'ol' }, children: [{ data: { hName: 'li' } }] },
        ],
      },
    ])
  })

  it.each([
    [
      'an unclosed list',
      [html('<ul>'), html('<li>'), text('a'), html('</li>')],
    ],
    [
      'a closing tag out of order',
      [html('<ul>'), html('<li>'), html('</ul>'), html('</li>')],
    ],
    ['an item outside a list', [html('<li>'), text('a'), html('</li>')]],
    ['text between items', [html('<ul>'), text('a'), html('</ul>')]],
    [
      'a summary after the body',
      [
        html('<details>'),
        text('a'),
        html('<summary>'),
        html('</summary>'),
        html('</details>'),
      ],
    ],
    [
      'a list in a summary',
      [
        html('<details>'),
        html('<summary>'),
        html('<ul>'),
        html('</ul>'),
        html('</summary>'),
        html('</details>'),
      ],
    ],
  ])('keeps the tags as html, breaking its lines still, for %s', (_, nodes) => {
    const out = cell(...nodes, html('<br>'))
    expect(out.slice(0, -1)).toEqual(nodes)
    expect(out.at(-1)?.type).toBe('break')
  })

  it('keeps lists nested deeper than the limit as html', () => {
    const deep = (n: number) => [
      ...Array.from({ length: n }, () => [html('<ul>'), html('<li>')]).flat(),
      ...Array.from({ length: n }, () => [html('</li>'), html('</ul>')]).flat(),
    ]
    expect(cell(...deep(15))[0].type).toBe('cellList')
    expect(cell(...deep(17))[0].type).toBe('html')
  })
})
