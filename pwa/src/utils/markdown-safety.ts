// What makes untrusted markdown safe to render (agent text in the Chat view,
// files in the Files view): raw HTML is shown as the text it is, and only
// http(s) URLs may leave the app. The Files view also folds <details> blocks
// into disclosures built from markdown nodes, never from the HTML itself.

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

// A remark plugin: raw HTML in the markdown is shown as the text it is.
export function htmlAsText() {
  const walk = (node: MdNode) => {
    if (node.type === 'html') node.type = 'text'
    node.children?.forEach(walk)
  }
  return walk
}

// The URL when it is http(s), else null.
export function safeUrl(url: unknown): URL | null {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

// Block parents, where a <details> line can start a disclosure; never inside
// a paragraph, a heading or a table cell.
const FLOW = new Set([
  'root',
  'blockquote',
  'listItem',
  'footnoteDefinition',
  'details',
])
// Disclosures nested deeper than this stay text: each level is one more pass
// over its body, and the tree is walked recursively.
const MAX_DEPTH = 32
const OPEN =
  /^<details(\s[^>]*)?>\s*(?:<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>)?$/i
const WHOLE =
  /^<details(\s[^>]*)?>\s*(?:<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>)?([\s\S]*?)<\/details>$/i
const SUMMARY = /^<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>$/i
const CLOSE = /^<\/details>$/i
const TAG_LINE = [OPEN, WHOLE, SUMMARY, CLOSE]

const htmlValue = (n: MdNode | undefined) =>
  // An html node always has its value
  n?.type === 'html' ? (n.value as string).trim() : ''

// A <details> element built from markdown nodes. Only `open` is kept of its
// attributes; the summary is plain text, with its inline tags dropped.
function disclosure(
  attrs: string | undefined,
  summary: string | undefined,
  body: MdNode[],
): MdNode {
  // Quoted values first, so title="a open b" does not count
  const names = (attrs ?? '').replace(/"[^"]*"|'[^']*'/g, '')
  const open = /(?:^|\s)open(?:[\s=]|$)/i.test(names)
  const children: MdNode[] = []
  if (summary !== undefined) {
    children.push({
      type: 'detailsSummary',
      data: { hName: 'summary' },
      children: [
        { type: 'text', value: summary.replace(/<[^>]*>/g, '').trim() },
      ],
    })
  }
  return {
    type: 'details',
    data: { hName: 'details', hProperties: open ? { open: true } : {} },
    children: [...children, ...body],
  }
}

// An HTML block runs to the next blank line, so one node can hold several
// tags, "</details>\n<p>after</p>" say: each tag line of a disclosure becomes
// its own node, the lines between stay together as they were.
function splitTags(nodes: MdNode[]): MdNode[] {
  return nodes.flatMap((n) => {
    const lines = htmlValue(n).split('\n')
    const isTag = (l: string) => TAG_LINE.some((re) => re.test(l.trim()))
    if (lines.length < 2 || !lines.some(isTag)) return [n]
    const out: MdNode[] = []
    let rest: string[] = []
    const flush = () => {
      if (rest.length) out.push({ type: 'html', value: rest.join('\n') })
      rest = []
    }
    for (const l of lines) {
      if (!isTag(l)) {
        rest.push(l)
        continue
      }
      flush()
      out.push({ type: 'html', value: l.trim() })
    }
    flush()
    return out
  })
}

// For each opening tag, the index of its </details>, found in one pass
function pairs(nodes: MdNode[]): Map<number, number> {
  const ends = new Map<number, number>()
  const stack: number[] = []
  nodes.forEach((n, i) => {
    const v = htmlValue(n)
    if (OPEN.test(v)) stack.push(i)
    else if (CLOSE.test(v) && stack.length) ends.set(stack.pop() as number, i)
  })
  return ends
}

function fold(parent: MdNode, depth: number) {
  if (!parent.children) return
  const flow = FLOW.has(parent.type) && depth < MAX_DEPTH
  const nodes = flow ? splitTags(parent.children) : parent.children
  const ends = flow ? pairs(nodes) : new Map<number, number>()
  const out: MdNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const v = flow ? htmlValue(nodes[i]) : ''
    const whole = WHOLE.exec(v)
    if (whole) {
      const text = whole[3].trim()
      out.push(
        disclosure(
          whole[1],
          whole[2],
          text
            ? [{ type: 'paragraph', children: [{ type: 'text', value: text }] }]
            : [],
        ),
      )
      continue
    }
    const end = ends.get(i)
    if (end !== undefined) {
      const open = OPEN.exec(v) as RegExpExecArray
      let body = nodes.slice(i + 1, end)
      let summary = open[2]
      const s = summary === undefined && SUMMARY.exec(htmlValue(body[0]))
      if (s) {
        summary = s[1]
        body = body.slice(1)
      }
      const node = disclosure(open[1], summary, body)
      fold(node, depth + 1)
      out.push(node)
      i = end
      continue
    }
    fold(nodes[i], depth)
    out.push(nodes[i])
  }
  parent.children = out
}

// A remark plugin, run before htmlAsText: a <details> block, with its
// optional <summary>, up to its </details> becomes a disclosure whose body is
// still markdown. Any other HTML, an unclosed <details> included, stays raw
// and is shown as text.
export function detailsBlocks() {
  return (tree: MdNode) => fold(tree, 0)
}
