// What the Markdown preview of the Files view needs to know about a file:
// whether it is Markdown, where its links go, its front matter and the ids
// of its headings. No React, no markdown parser: these are plain functions.
import { safeUrl } from './markdown-safety'

export const isMarkdownPath = (path: string) =>
  /\.(md|markdown|mdx)$/i.test(path)

// A file (or directory) under the pane's root, and the heading to show
export interface LinkPath {
  path: string
  anchor?: string
}

export type LinkTarget =
  | { kind: 'external'; url: URL }
  // A heading of the same file
  | { kind: 'anchor'; anchor: string }
  | ({ kind: 'path' } & LinkPath)
  // Not followed: another scheme, or a path that leaves the root
  | { kind: 'none' }

const NONE: LinkTarget = { kind: 'none' }

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

// Where href goes, read from the Markdown file at from ("/"-separated, under
// the root): relative to its directory, or to the root with a leading "/".
// A path is never built that leaves the root, so it is never requested.
export function resolveLink(
  href: string | undefined,
  from: string,
): LinkTarget {
  if (!href) return NONE
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    const url = safeUrl(href)
    return url ? { kind: 'external', url } : NONE
  }
  // Another host without a scheme, or a Windows separator that could step
  // out of the root
  if (href.startsWith('//') || href.includes('\\')) return NONE
  const hash = href.indexOf('#')
  const rawAnchor = hash < 0 ? '' : href.slice(hash + 1)
  const anchor = rawAnchor ? (decode(rawAnchor) ?? rawAnchor) : undefined
  const rawPath = (hash < 0 ? href : href.slice(0, hash)).replace(/\?.*$/, '')
  if (!rawPath) return anchor ? { kind: 'anchor', anchor } : NONE
  const decoded = decode(rawPath)
  if (decoded === null || /[\\\0]/.test(decoded)) return NONE

  const parts = decoded.startsWith('/')
    ? []
    : from.split('/').slice(0, -1).filter(Boolean)
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return NONE
      parts.pop()
    } else {
      parts.push(seg)
    }
  }
  return { kind: 'path', path: parts.join('/'), anchor }
}

// Front matter: a "---" block at the very top, shown as code, not rendered
export function splitFrontMatter(text: string): {
  frontMatter?: string
  body: string
} {
  const m = text.match(
    /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/,
  )
  if (!m) return { body: text }
  return { frontMatter: m[1] ?? '', body: text.slice(m[0].length) }
}

// Heading ids as GitHub makes them: lower case, punctuation dropped, spaces
// as "-", and a repeated heading numbered ("intro", "intro-1").
export function slugger() {
  const seen = new Map<string, number>()
  return (text: string) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-')
    let slug = base
    while (seen.has(slug)) {
      const n = (seen.get(base) as number) + 1
      seen.set(base, n)
      slug = `${base}-${n}`
    }
    seen.set(slug, 0)
    return slug
  }
}

// The prefix react-markdown gives footnote ids, used for headings too: an id
// from a file never clashes with one of the app.
export const ID_PREFIX = 'user-content-'

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

export function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

// A rehype plugin: every heading without an id gets one from its text.
export function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const slug = slugger()
    const walk = (node: HastNode) => {
      if (node.tagName && /^h[1-6]$/.test(node.tagName)) {
        const props = node.properties ?? {}
        if (!props.id) props.id = ID_PREFIX + slug(textOf(node))
        node.properties = props
        return
      }
      node.children?.forEach(walk)
    }
    walk(tree)
  }
}

// The info string of a fenced block names Mermaid (```mermaid, any case)
export function isMermaidInfo(info: string): boolean {
  return info.trim().split(/[\s{]/, 1)[0].toLowerCase() === 'mermaid'
}

// A rehype plugin: the code of every Mermaid block gets its number in the
// file (1, 2, ...) as data-mermaid-index, so its image has a name of its own
// that is not text from the file.
export function rehypeMermaidIndex() {
  return (tree: HastNode) => {
    let n = 0
    const walk = (node: HastNode) => {
      const code = node.tagName === 'pre' ? node.children?.[0] : undefined
      const classes = (code?.properties?.className ?? []) as string[]
      if (
        code?.tagName === 'code' &&
        classes.some(
          (c) => c.startsWith('language-') && isMermaidInfo(c.slice(9)),
        )
      ) {
        code.properties = { ...code.properties, dataMermaidIndex: ++n }
        return
      }
      node.children?.forEach(walk)
    }
    walk(tree)
  }
}

// The element an anchor names inside container: a heading ("#intro"), or a
// footnote whose link already carries the prefix. Matched exactly, then in
// lower case.
export function findAnchor(
  container: ParentNode,
  anchor: string,
): Element | undefined {
  const els = Array.from(container.querySelectorAll('[id]'))
  for (const want of [anchor, anchor.toLowerCase()]) {
    const el = els.find((e) => e.id === ID_PREFIX + want || e.id === want)
    if (el) return el
  }
  return undefined
}
