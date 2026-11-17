// What makes untrusted markdown safe to render (agent text in the Chat view,
// files in the Files view): raw HTML is shown as the text it is, and only
// http(s) URLs may leave the app. The Files view also folds <details> blocks
// into disclosures, and a table cell's <br>, lists and disclosures into
// nodes, all built from markdown nodes, never from the HTML itself.

interface Point {
  line: number
  column?: number
  offset?: number
}

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
  // Where in the file the node is: a disclosure spans its tags, so the
  // preview knows the line it starts on (rehypeSourceLines)
  position?: { start: Point; end: Point }
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
// its own node, the lines between stay together as they were. Each keeps the
// lines of the file it came from.
function splitTags(nodes: MdNode[]): MdNode[] {
  return nodes.flatMap((n) => {
    const lines = htmlValue(n).split('\n')
    const isTag = (l: string) => TAG_LINE.some((re) => re.test(l.trim()))
    if (lines.length < 2 || !lines.some(isTag)) return [n]
    // The value was trimmed: its first line is the node's. A point needs a
    // column too, or mdast-util-to-hast drops the position.
    const first = n.position?.start.line
    const at = (from: number, to: number) =>
      first === undefined
        ? {}
        : {
            position: {
              start: { line: first + from, column: 1 },
              end: { line: first + to, column: lines[to].length + 1 },
            },
          }
    const out: MdNode[] = []
    let rest: string[] = []
    let restFrom = 0
    const flush = (i: number) => {
      if (rest.length)
        out.push({
          type: 'html',
          value: rest.join('\n'),
          ...at(restFrom, i - 1),
        })
      rest = []
    }
    lines.forEach((l, i) => {
      if (!isTag(l)) {
        if (!rest.length) restFrom = i
        rest.push(l)
        return
      }
      flush(i)
      out.push({ type: 'html', value: l.trim(), ...at(i, i) })
    })
    flush(lines.length)
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
      out.push({
        ...disclosure(
          whole[1],
          whole[2],
          text
            ? [{ type: 'paragraph', children: [{ type: 'text', value: text }] }]
            : [],
        ),
        position: nodes[i].position,
      })
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
      const start = nodes[i].position?.start
      const stop = nodes[end].position?.end
      if (start && stop) node.position = { start, end: stop }
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

// A table cell is one line of the file, so a line break, a list or a
// disclosure in it can only be written as HTML: <br>, <ul>/<ol>/<li>,
// <details>/<summary>. Each tag is its own html node there; they are rebuilt
// from markdown nodes, never parsed, and no attribute is kept but a
// <details>' `open`.
const CELL_BREAK = /^<br\s*\/?>$/i
const CELL_OPEN = /^<(ul|ol|li|details|summary)(\s[^>]*)?>$/i
const CELL_CLOSE = /^<\/(ul|ol|li|details|summary)\s*>$/i
const CELL_LISTS = new Set(['ul', 'ol'])
// What each tag may be opened in ('cell': the cell itself). Nothing opens in
// a <summary>; it is first in its <details> (checked when it opens).
const CELL_PARENTS: Record<string, string[]> = {
  ul: ['cell', 'li', 'details'],
  ol: ['cell', 'li', 'details'],
  li: ['ul', 'ol'],
  details: ['cell', 'li', 'details'],
  summary: ['details'],
}

const lineBreak = (n: MdNode): MdNode =>
  CELL_BREAK.test(htmlValue(n)) ? { type: 'break', position: n.position } : n

const blank = (n: MdNode) => n.type === 'text' && !n.value?.trim()

function cellElement(tag: string, attrs: string | undefined): MdNode {
  if (tag === 'details') return disclosure(attrs, undefined, [])
  if (tag === 'summary')
    return { type: 'detailsSummary', data: { hName: 'summary' }, children: [] }
  // Not mdast's list nodes: those carry spread and checked marks of their own
  return {
    type: tag === 'li' ? 'cellListItem' : 'cellList',
    data: { hName: tag },
    children: [],
  }
}

// The cell's nodes with its tags rebuilt, or null when they do not pair up,
// open where they may not, nest past MAX_DEPTH, or a list holds anything but
// its items
function cellTree(nodes: MdNode[]): MdNode[] | null {
  const cell: MdNode = { type: 'cell', children: [] }
  const stack = [{ tag: 'cell', node: cell }]
  for (const n of nodes) {
    const top = stack[stack.length - 1]
    const kids = top.node.children as MdNode[]
    const v = htmlValue(n)
    const open = CELL_OPEN.exec(v)
    if (open) {
      const tag = open[1].toLowerCase()
      if (!CELL_PARENTS[tag].includes(top.tag) || stack.length > MAX_DEPTH)
        return null
      if (tag === 'summary') {
        if (!kids.every(blank)) return null
        kids.length = 0
      }
      const node = cellElement(tag, open[2])
      kids.push(node)
      stack.push({ tag, node })
      continue
    }
    const close = CELL_CLOSE.exec(v)
    if (close) {
      if (close[1].toLowerCase() !== top.tag) return null
      stack.pop()
      continue
    }
    if (CELL_LISTS.has(top.tag)) {
      if (blank(n)) continue
      return null
    }
    kids.push(lineBreak(n))
  }
  return stack.length === 1 ? (cell.children as MdNode[]) : null
}

// A remark plugin, run before htmlAsText: in every table cell, <br> becomes a
// line break, and lists and disclosures whose tags pair up are rebuilt with
// the cell's markdown inside. A cell whose tags do not pair up keeps them as
// text, its <br> still breaking the line; any other HTML stays text.
export function tableCellTags() {
  const walk = (node: MdNode) => {
    if (node.type === 'tableCell') {
      // A table cell always has its children
      const nodes = node.children as MdNode[]
      node.children = cellTree(nodes) ?? nodes.map(lineBreak)
      return
    }
    node.children?.forEach(walk)
  }
  return walk
}
