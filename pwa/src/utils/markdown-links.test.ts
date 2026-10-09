import { describe, expect, it } from 'vitest'
import {
  findAnchor,
  isMarkdownPath,
  isMermaidInfo,
  rehypeHeadingIds,
  rehypeMermaidIndex,
  resolveLink,
  slugger,
  splitFrontMatter,
  textOf,
} from './markdown-links'

describe('isMarkdownPath', () => {
  it.each(['README.md', 'docs/a.MARKDOWN', 'x/page.mdx'])('%s', (p) => {
    expect(isMarkdownPath(p)).toBe(true)
  })
  it.each(['a.txt', 'md', 'a.md.bak', 'a.mdown'])('not %s', (p) => {
    expect(isMarkdownPath(p)).toBe(false)
  })
})

describe('resolveLink', () => {
  const from = 'docs/guide/intro.md'

  it.each([
    ['other.md', 'docs/guide/other.md'],
    ['./other.md', 'docs/guide/other.md'],
    ['../README.md', 'docs/README.md'],
    ['../../src/main.go', 'src/main.go'],
    ['/src/main.go', 'src/main.go'],
    ['sub/', 'docs/guide/sub'],
    ['..', 'docs'],
    ['../..', ''],
    ['/', ''],
    ['a//b/./c.md', 'docs/guide/a/b/c.md'],
    ['my%20file.md', 'docs/guide/my file.md'],
    ['a.md?plain=1', 'docs/guide/a.md'],
  ])('%s → %s', (href, path) => {
    expect(resolveLink(href, from)).toEqual({
      kind: 'path',
      path,
      anchor: undefined,
    })
  })

  it('resolves from a file at the root', () => {
    expect(resolveLink('docs/a.md', 'README.md')).toMatchObject({
      path: 'docs/a.md',
    })
  })

  it('keeps the anchor of a path', () => {
    expect(resolveLink('other.md#set-up', from)).toEqual({
      kind: 'path',
      path: 'docs/guide/other.md',
      anchor: 'set-up',
    })
  })

  it('an anchor alone is a heading of the same file, decoded', () => {
    expect(resolveLink('#usage', from)).toEqual({
      kind: 'anchor',
      anchor: 'usage',
    })
    expect(resolveLink('#c%C3%A0i-%C4%91%E1%BA%B7t', from)).toEqual({
      kind: 'anchor',
      anchor: 'cài-đặt',
    })
    // Not valid percent-encoding: kept as written
    expect(resolveLink('#100%', from)).toEqual({
      kind: 'anchor',
      anchor: '100%',
    })
  })

  it.each([
    undefined,
    '',
    '#',
    '../../../etc/passwd',
    '/../x',
    '..\\..\\x',
    '%2e%2e/%2e%2e/%2e%2e/x',
    'a%5C..%5Cb',
    'a%00b',
    '%E0%A4%A',
    '//evil.example/x',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,x',
    'mailto:a@b.c',
  ])('%s is not followed', (href) => {
    expect(resolveLink(href, from)).toEqual({ kind: 'none' })
  })

  it('http(s) is external', () => {
    const t = resolveLink('https://example.com/a', from)
    expect(t.kind).toBe('external')
    expect(t.kind === 'external' && t.url.host).toBe('example.com')
  })
})

describe('splitFrontMatter', () => {
  it('splits a --- block at the top', () => {
    expect(splitFrontMatter('---\ntitle: A\n---\n# Hi\n')).toEqual({
      frontMatter: 'title: A',
      body: '# Hi\n',
    })
    expect(splitFrontMatter('---\r\na: 1\r\nb: 2\r\n---')).toEqual({
      frontMatter: 'a: 1\r\nb: 2',
      body: '',
    })
  })

  it('an empty block is front matter too', () => {
    expect(splitFrontMatter('---\n---\nx')).toEqual({
      frontMatter: '',
      body: 'x',
    })
  })

  it('leaves text without one alone', () => {
    expect(splitFrontMatter('# A\n---\nb: 1\n---\n')).toEqual({
      body: '# A\n---\nb: 1\n---\n',
    })
    expect(splitFrontMatter('---\nnot closed')).toEqual({
      body: '---\nnot closed',
    })
  })
})

describe('slugger', () => {
  it('makes GitHub ids, numbering repeats', () => {
    const s = slugger()
    expect(s('Getting Started!')).toBe('getting-started')
    expect(s('Getting Started')).toBe('getting-started-1')
    expect(s('getting-started')).toBe('getting-started-2')
    expect(s('Cài đặt (v1.0)')).toBe('cài-đặt-v10')
    expect(s('snake_case & more')).toBe('snake_case--more')
    expect(s('')).toBe('')
    expect(s('')).toBe('-1')
  })
})

describe('rehypeHeadingIds', () => {
  it('gives headings ids from their text, keeps existing ids', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'h1',
          children: [
            { type: 'text', value: 'Intro ' },
            {
              type: 'element',
              tagName: 'code',
              children: [{ type: 'text', value: 'x' }],
            },
          ],
        },
        {
          type: 'element',
          tagName: 'section',
          properties: {},
          children: [
            {
              type: 'element',
              tagName: 'h2',
              properties: { id: 'footnote-label' },
              children: [{ type: 'text', value: 'Footnotes' }],
            },
          ],
        },
        { type: 'element', tagName: 'h3', properties: {}, children: [] },
        { type: 'text', value: 'x' },
      ],
    }
    rehypeHeadingIds()(tree)
    const [h1, section, h3] = tree.children as {
      properties?: Record<string, unknown>
      children?: { properties?: Record<string, unknown> }[]
    }[]
    expect(h1.properties?.id).toBe('user-content-intro-x')
    expect(section.children?.[0].properties?.id).toBe('footnote-label')
    expect(h3.properties?.id).toBe('user-content-')
  })

  it('numbers Mermaid blocks in file order, nested ones too', () => {
    const block = (lang?: string, props = true) => ({
      type: 'element',
      tagName: 'pre',
      children: [
        {
          type: 'element',
          tagName: 'code',
          ...(props
            ? { properties: { className: lang ? [`language-${lang}`] : [] } }
            : {}),
          children: [{ type: 'text', value: 'graph TD' }],
        },
      ],
    })
    const tree = {
      type: 'root',
      children: [
        block('mermaid'),
        block('ts'),
        block(),
        block(undefined, false),
        { type: 'element', tagName: 'pre', children: [] },
        {
          type: 'element',
          tagName: 'pre',
          children: [{ type: 'text', value: 'x' }],
        },
        {
          type: 'element',
          tagName: 'blockquote',
          children: [block('Mermaid')],
        },
      ],
    }
    rehypeMermaidIndex()(tree)
    const indexOf = (n: unknown) =>
      (n as { children: { properties?: Record<string, unknown> }[] })
        .children[0]?.properties?.dataMermaidIndex
    const [m1, ts, plain, bare, , , quote] = tree.children
    expect(indexOf(m1)).toBe(1)
    expect(indexOf(ts)).toBeUndefined()
    expect(indexOf(plain)).toBeUndefined()
    expect(indexOf(bare)).toBeUndefined()
    expect(indexOf((quote as { children: unknown[] }).children[0])).toBe(2)
  })

  it.each([
    ['mermaid', true],
    ['Mermaid', true],
    [' mermaid title', true],
    ['mermaid{x}', true],
    ['mermaidx', false],
    ['', false],
  ])('isMermaidInfo(%j) is %s', (info, expected) => {
    expect(isMermaidInfo(info)).toBe(expected)
  })

  it('textOf reads nested text', () => {
    expect(textOf({ type: 'text' })).toBe('')
    expect(textOf({ type: 'element' })).toBe('')
  })
})

describe('findAnchor', () => {
  it('finds a heading by its anchor, a prefixed id, or in lower case', () => {
    const div = document.createElement('div')
    div.innerHTML =
      '<h2 id="user-content-usage">Usage</h2><li id="user-content-fn-1"></li>'
    expect(findAnchor(div, 'usage')?.textContent).toBe('Usage')
    expect(findAnchor(div, 'Usage')?.textContent).toBe('Usage')
    expect(findAnchor(div, 'user-content-fn-1')?.tagName).toBe('LI')
    expect(findAnchor(div, 'missing')).toBeUndefined()
  })
})
