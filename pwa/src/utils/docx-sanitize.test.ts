import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import {
  DOC_LIMITS,
  type DocChild,
  type DocNode,
  isDocTag,
  safeHref,
  sanitizeTree,
  type XNode,
} from './docx-sanitize'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

function clean(html: string, limits = DOC_LIMITS) {
  const doc = new DOMParser().parseFromString(
    `<root>${html}</root>`,
    'text/xml',
  )
  return sanitizeTree(doc.documentElement as unknown as XNode, limits)
}

// Every tag and attribute anywhere in the tree
function walk(
  tree: DocChild[],
  seen = { tags: new Set<string>(), attrs: new Set<string>() },
) {
  for (const n of tree) {
    if (typeof n === 'string') continue
    seen.tags.add(n.t)
    for (const k of Object.keys(n.a ?? {})) seen.attrs.add(k)
    walk(n.c ?? [], seen)
  }
  return seen
}

const text = (tree: DocChild[]): string =>
  tree.map((n) => (typeof n === 'string' ? n : text(n.c ?? []))).join('')

describe('sanitizeTree', () => {
  it('keeps what mammoth makes of a document', () => {
    const { tree, truncated } = clean(
      '<h1>Title</h1><p>a <strong>b</strong> <em>c</em> <u>u</u> <s>s</s> x<sup>2</sup><sub>i</sub><br />d</p>' +
        '<ul><li>one<ol><li>nested</li></ol></li></ul>' +
        '<table><tr><td colspan="2" rowspan="3">m</td><th colspan="1">h</th></tr></table>' +
        `<p><a href="https://example.com/x?y=1">link</a><img src="${PNG}" alt="logo" /><img src="${PNG}" /></p>` +
        '<blockquote>q</blockquote><pre><code>x &lt; y</code></pre>',
    )
    expect(truncated).toBe(false)
    expect(tree[0]).toEqual({ t: 'h1', c: ['Title'] })
    expect(tree[3]).toEqual({
      t: 'table',
      c: [
        {
          t: 'tr',
          c: [
            { t: 'td', a: { colspan: 2, rowspan: 3 }, c: ['m'] },
            { t: 'th', c: ['h'] },
          ],
        },
      ],
    })
    expect(tree[4]).toEqual({
      t: 'p',
      c: [
        { t: 'a', a: { href: 'https://example.com/x?y=1' }, c: ['link'] },
        { t: 'img', a: { src: PNG, alt: 'logo' } },
        { t: 'img', a: { src: PNG } },
      ],
    })
    expect(text(tree)).toContain('x < y')
    expect(
      (tree[1] as DocNode).c?.some(
        (n) => typeof n !== 'string' && n.t === 'br',
      ),
    ).toBe(true)
  })

  it.each([
    ['<img src="x" onerror="alert(1)" />', '[image omitted]'],
    ['<a href="javascript:alert(1)">x</a>', 'x'],
    ['<a href=" JaVaScript:alert(1)">x</a>', 'x'],
    ['<a href="data:text/html,<b>x</b>">x</a>', 'x'],
    ['<a href="#root">to the root</a>', 'to the root'],
    ['<a href="/relative">rel</a>', 'rel'],
    ['<a>none</a>', 'none'],
    [`<img src="data:image/svg+xml;base64,PHN2Zz4=" />`, '[image omitted]'],
    [`<img src="${PNG}&quot; onload=&quot;x" />`, '[image omitted]'],
    ['<svg><script>alert(1)</script><text>hidden</text></svg>after', 'after'],
    ['<math><mi>x</mi></math>', ''],
    ['<style>p{color:red}</style>s', 's'],
    ['<script>alert(1)</script>', ''],
    ['<iframe src="https://x">f</iframe>', ''],
    [
      '<div id="a" class="b" style="c" onclick="d"><span>kept text</span></div>',
      'kept text',
    ],
  ])('%s', (html, want) => {
    const { tree } = clean(html)
    const { tags, attrs } = walk(tree)
    for (const t of tags) expect(isDocTag(t)).toBe(true)
    for (const a of attrs)
      expect(['colspan', 'rowspan', 'href', 'src', 'alt']).toContain(a)
    expect(tags.has('a') && !attrs.has('href')).toBe(false)
    expect(text(tree)).toBe(want)
  })

  it('keeps no id, class, style, event handler or target', () => {
    const { tree } = clean(
      '<p id="x" class="y" style="z" onclick="w"><a id="n" target="_self" href="https://a.b">l</a><td colspan="1e9">c</td><td rowspan="0">c</td><td colspan="1001">c</td><td colspan="x">c</td></p>',
    )
    expect(tree).toEqual([
      {
        t: 'p',
        c: [
          { t: 'a', a: { href: 'https://a.b/' }, c: ['l'] },
          { t: 'td', c: ['c'] },
          { t: 'td', c: ['c'] },
          { t: 'td', c: ['c'] },
          { t: 'td', c: ['c'] },
        ],
      },
    ])
  })

  it('cuts at the depth limit', () => {
    const deep = `${'<blockquote>'.repeat(10_000)}deep${'</blockquote>'.repeat(10_000)}`
    const r = clean(`<p>before</p>${deep}`)
    expect(r.truncated).toBe(true)
    let d = 0
    let n: DocChild | undefined = r.tree[1]
    while (n && typeof n !== 'string') {
      d++
      n = n.c?.[0]
    }
    expect(d).toBeLessThanOrEqual(DOC_LIMITS.depth)
    expect(text(r.tree)).toBe('before')
  })

  it('cuts at the node and text limits', () => {
    const many = clean('<p>a</p><p>b</p><p>c</p>', { ...DOC_LIMITS, nodes: 2 })
    expect(many).toEqual({
      tree: [
        { t: 'p', c: ['a'] },
        { t: 'p', c: ['b'] },
      ],
      truncated: true,
    })
    const long = clean('<p>abcdef</p><p>never</p>', { ...DOC_LIMITS, text: 4 })
    expect(long).toEqual({ tree: [{ t: 'p', c: ['abcd'] }], truncated: true })
  })

  it('keeps CDATA as text, and skips comments and empty text', () => {
    const doc = new DOMParser().parseFromString(
      '<root><p><![CDATA[a < b]]><!-- note --></p><p></p></root>',
      'text/xml',
    )
    expect(sanitizeTree(doc.documentElement as unknown as XNode).tree).toEqual([
      { t: 'p', c: ['a < b'] },
      { t: 'p' },
    ])
  })

  it('takes nodes without getAttribute or a value', () => {
    const el = (nodeName: string, childNodes: XNode[] = []): XNode => ({
      nodeType: 1,
      nodeName,
      nodeValue: null,
      childNodes,
    })
    const blank: XNode = {
      nodeType: 3,
      nodeName: '#text',
      nodeValue: null,
      childNodes: [],
    }
    expect(
      sanitizeTree(el('root', [el('A'), el('IMG'), el('TD', [blank])])).tree,
    ).toEqual(['[image omitted]', { t: 'td' }])
  })
})

describe('safeHref', () => {
  it.each([
    ['https://a.b/c', 'https://a.b/c'],
    ['  http://a.b  ', 'http://a.b/'],
    ['mailto:x@y.z', 'mailto:x@y.z'],
    ['javascript:x', undefined],
    ['vbscript:x', undefined],
    ['file:///etc/passwd', undefined],
    ['//a.b', undefined],
    ['', undefined],
    [null, undefined],
  ])('%s', (raw, want) => {
    expect(safeHref(raw)).toBe(want)
  })
})
