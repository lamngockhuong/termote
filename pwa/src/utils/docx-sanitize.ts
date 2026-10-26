// Turns the HTML mammoth makes of a .docx (parsed by xmldom, in the worker)
// into a small tree of allowed elements, which the page maps to React
// elements: never HTML. Anything not allowed goes, its text kept, except the
// elements whose content is not text (script, style, svg, ...), which go
// whole. No id and no "#" link is kept: a link to an anchor would change the
// page's location.hash, which routes the app.

export const DOC_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'sup',
  'sub',
  'br',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'img',
  'blockquote',
  'pre',
  'code',
] as const

export type DocTag = (typeof DOC_TAGS)[number]

export interface DocAttrs {
  colspan?: number
  rowspan?: number
  href?: string
  src?: string
  alt?: string
}

export interface DocNode {
  t: DocTag
  a?: DocAttrs
  c?: DocChild[]
}

export type DocChild = DocNode | string

// Dropped with everything in them
const DROP = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'noscript',
  'head',
  'title',
  'link',
  'meta',
  'form',
  'textarea',
  'select',
])

const ALLOWED = new Set<string>(DOC_TAGS)

export const IMAGE_SRC =
  /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/

export interface DocLimits {
  // UTF-16 units of text
  text: number
  nodes: number
  depth: number
}

export const DOC_LIMITS: DocLimits = {
  text: 5 << 20,
  nodes: 50_000,
  depth: 64,
}

// What xmldom (and the DOM) give: an element, text, CDATA or anything else
export interface XNode {
  nodeType: number
  nodeName: string
  nodeValue: string | null
  childNodes: ArrayLike<XNode>
  getAttribute?: (name: string) => string | null
}

const ELEMENT = 1
const TEXT = 3
const CDATA = 4

export function isDocTag(tag: string): tag is DocTag {
  return ALLOWED.has(tag)
}

// An http(s) or mailto link, as the URL parser reads it; else none
export function safeHref(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  return ['http:', 'https:', 'mailto:'].includes(url.protocol)
    ? url.href
    : undefined
}

function span(raw: string | null | undefined): number | undefined {
  if (!raw || !/^\d{1,4}$/.test(raw.trim())) return undefined
  const n = Number(raw.trim())
  return n >= 1 && n <= 1000 ? n : undefined
}

// The attributes kept of an allowed element; undefined: the element itself
// goes (a link without a safe target, an image without a safe source)
function attrsOf(tag: DocTag, el: XNode): { attrs?: DocAttrs; keep: boolean } {
  const get = (n: string) => el.getAttribute?.(n)
  if (tag === 'a') {
    const href = safeHref(get('href'))
    return href ? { attrs: { href }, keep: true } : { keep: false }
  }
  if (tag === 'img') {
    const src = get('src') ?? ''
    if (!IMAGE_SRC.test(src)) return { keep: false }
    const alt = get('alt')
    return { attrs: alt ? { src, alt } : { src }, keep: true }
  }
  if (tag === 'td' || tag === 'th') {
    const colspan = span(get('colspan'))
    const rowspan = span(get('rowspan'))
    const attrs: DocAttrs = {}
    if (colspan && colspan > 1) attrs.colspan = colspan
    if (rowspan && rowspan > 1) attrs.rowspan = rowspan
    return { attrs: Object.keys(attrs).length ? attrs : undefined, keep: true }
  }
  return { keep: true }
}

export interface Sanitized {
  tree: DocChild[]
  // Cut at a limit: text, nodes or depth
  truncated: boolean
}

// The children of root as allowed nodes, within limits
export function sanitizeTree(
  root: XNode,
  limits: DocLimits = DOC_LIMITS,
): Sanitized {
  let text = 0
  let nodes = 0
  let truncated = false

  const children = (parent: XNode, depth: number): DocChild[] => {
    const out: DocChild[] = []
    for (let i = 0; i < parent.childNodes.length; i++) {
      if (truncated) break
      const n = parent.childNodes[i]
      if (n.nodeType === TEXT || n.nodeType === CDATA) {
        const v = n.nodeValue ?? ''
        if (!v) continue
        if (text + v.length > limits.text) {
          out.push(v.slice(0, limits.text - text))
          text = limits.text
          truncated = true
          break
        }
        text += v.length
        out.push(v)
        continue
      }
      if (n.nodeType !== ELEMENT) continue
      const tag = n.nodeName.toLowerCase()
      if (DROP.has(tag)) continue
      if (depth >= limits.depth || ++nodes > limits.nodes) {
        truncated = true
        break
      }
      const kept = isDocTag(tag) ? attrsOf(tag, n) : { keep: false }
      if (!kept.keep) {
        // An image that cannot be shown says so; anything else keeps its text
        if (tag === 'img') out.push('[image omitted]')
        else out.push(...children(n, depth + 1))
        continue
      }
      const node: DocNode = { t: tag as DocTag }
      if (kept.attrs) node.a = kept.attrs
      if (tag !== 'img' && tag !== 'br') {
        const c = children(n, depth + 1)
        if (c.length) node.c = c
      }
      out.push(node)
    }
    return out
  }

  const tree = children(root, 0)
  return { tree, truncated }
}
