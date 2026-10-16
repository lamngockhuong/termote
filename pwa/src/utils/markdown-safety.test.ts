import { describe, expect, it } from 'vitest'
import { detailsBlocks, htmlAsText, safeUrl } from './markdown-safety'

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
