import { cutBytes } from './pane-selection'
import { MAX_QUOTE_BYTES, quoteLines } from './review-message'
import { revealHidden } from './task-failure-message'

// Text selected in the Chat transcript, put back in the composer as a
// Markdown quote to answer under. The transcript shows what the agent and
// its tools wrote (a web page, a file), so the quote is untrusted text the
// user sends as their own: what hides or changes text shows (revealHidden),
// an "[Image #n]" in it never names an image of the draft, and only what
// the user saw is taken (a capped block's hidden lines, button labels and
// unselectable marks stay out).

// Elements that start a line of their own
const BLOCKS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TFOOT',
  'THEAD',
  'TR',
  'UL',
])

// Text that is not part of what was written: a button's label (not a path
// the agent wrote, drawn as a button that opens it), an icon, a mark drawn
// beside the text ("$ " before a command, a diff's sign), words only a
// screen reader hears
const SKIP =
  'button:not([data-file-ref]), svg, script, style, .select-none, .sr-only'

// Elements whose own whitespace between children is only layout
const LAYOUT = new Set(['OL', 'UL', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR'])

// Whitespace kept as written: a code block, a message shown line by line
const KEEPS_SPACE = 'pre, [class*="whitespace-pre"]'

class Out {
  s = ''
  // Stop walking: the range's end was reached (the blocks around it end
  // without a line after them), or a folded block's hidden part
  done = false
  // Written before the next text only: a list item's number, a cell's
  // " | " (a selection ending where one starts leaves none behind)
  prefix = ''
  // In a folded block on screen: text below this (client) y is hidden
  bottom?: number
  hidden = false
  // Starts a new line, unless one just started
  line() {
    if (this.s && !this.s.endsWith('\n')) this.s += '\n'
  }
  text(t: string, keepSpace: boolean) {
    if (!keepSpace) {
      t = t.replace(/[ \t\n\r\f]+/g, ' ')
      if (this.s === '' || /[ \n]$/.test(this.s)) t = t.replace(/^ /, '')
    }
    if (!t) return
    this.s += this.prefix + t
    this.prefix = ''
  }
}

// The offset of the first character of node in [from, to) not drawn whole
// above bottom (a line cut by the block's edge is hidden), or to when none is
function firstHidden(node: Text, from: number, to: number, bottom: number) {
  const r = document.createRange()
  const below = (k: number) => {
    r.setStart(node, k)
    r.setEnd(node, k + 1)
    return r.getBoundingClientRect().bottom > bottom + 1
  }
  let lo = from
  let hi = to
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (below(mid)) hi = mid
    else lo = mid + 1
  }
  return lo
}

// The position of li in its list: "3. " in an ordered one (from its start),
// "- " otherwise
function marker(li: Element): string {
  const list = li.parentElement
  if (list?.tagName !== 'OL') return '- '
  let n = Number.parseInt(list.getAttribute('start') ?? '', 10)
  if (Number.isNaN(n)) n = 1
  for (let s = li.previousElementSibling; s; s = s.previousElementSibling) n++
  return `${n}. `
}

// How deep li is in lists under root (0 for a list of its own)
function depth(li: Element, root: Element): number {
  let d = 0
  for (let e = li.parentElement; e && e !== root; e = e.parentElement) {
    if (e.tagName === 'LI') d++
  }
  return d
}

function walk(node: Node, range: Range, root: Element, out: Out) {
  if (out.done || !range.intersectsNode(node)) return
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text
    const from = node === range.startContainer ? range.startOffset : 0
    let to = node === range.endContainer ? range.endOffset : text.length
    if (node === range.endContainer) out.done = true
    if (out.bottom !== undefined && from < to) {
      const cut = firstHidden(text, from, to, out.bottom)
      if (cut < to) {
        to = cut
        out.hidden = out.done = true
      }
    }
    const d = text.data.slice(from, to)
    const parent = node.parentElement as Element
    if (LAYOUT.has(parent.tagName) && !d.trim()) return
    out.text(d, !!parent.closest(KEEPS_SPACE))
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as Element
  if (el.matches(SKIP)) return
  if (el.tagName === 'BR') {
    out.s += '\n'
    return
  }
  const clip = el.getAttribute('data-quote-clip')
  if (clip !== null) {
    clipped(el, Number(clip), range, root, out)
    return
  }
  const block = BLOCKS.has(el.tagName)
  if (block) out.line()
  if (el.tagName === 'LI') {
    out.prefix = '  '.repeat(depth(el, root)) + marker(el)
  }
  if (
    (el.tagName === 'TD' || el.tagName === 'TH') &&
    el.previousElementSibling &&
    range.intersectsNode(el.previousElementSibling)
  ) {
    out.prefix = ' | '
  }
  // A closed disclosure (thinking, a compacted summary) shows its summary
  const children =
    el.tagName === 'DETAILS' && !el.hasAttribute('open')
      ? [...el.children].filter((c) => c.tagName === 'SUMMARY')
      : el.childNodes
  for (const child of children) walk(child, range, root, out)
  if (el === range.endContainer) out.done = true
  if (block && !out.done) out.line()
}

// A capped block shown folded: only what is on screen, then "…" when more
// was selected. Where the page is laid out, what is drawn below the block's
// bottom is hidden; without a layout, the first lines it shows
// (data-quote-clip) are.
function clipped(
  el: Element,
  shown: number,
  range: Range,
  root: Element,
  out: Out,
) {
  const ends = el === range.endContainer || el.contains(range.endContainer)
  const inner = new Out()
  const box = el.getBoundingClientRect()
  if (box.height > 0) inner.bottom = box.bottom
  for (const child of el.childNodes) walk(child, range, root, inner)
  let kept = inner.s.replace(/\n$/, '').split('\n')
  let more = inner.hidden
  if (inner.bottom === undefined) {
    // The block's lines above the selection's start
    let above = 0
    if (el.contains(range.startContainer)) {
      const before = document.createRange()
      before.setStart(el, 0)
      before.setEnd(range.startContainer, range.startOffset)
      const head = new Out()
      for (const child of el.childNodes) walk(child, before, root, head)
      above = head.s.split('\n').length - 1
    }
    const room = Math.max(0, shown - above)
    more = kept.length > room
    kept = kept.slice(0, room)
  }
  out.done = ends
  if (!kept.join('')) return
  if (more) kept.push('…')
  out.line()
  out.s += kept.join('\n')
  if (!out.done) out.line()
}

// The text of range as the transcript shows it under root: a line per
// paragraph, list item (with its number) and table row (cells parted by
// " | "), code as written.
export function selectionText(range: Range, root: Element): string {
  const out = new Out()
  walk(root, range, root, out)
  return out.s
}

// text as a Markdown quote ("> " before each line), cut to what one quote
// holds; '' when there is nothing but whitespace.
export function quoteBlock(text: string): string {
  const lines = revealHidden(text.replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    // Not an image of the draft: the server pastes one for each token
    .replace(/\[Image #(\d+)\]/g, '[Image $1]')
    .split('\n')
    .map((l) => cutBytes(l, MAX_QUOTE_BYTES))
  if (!lines.some((l) => l.trim())) return ''
  return quoteLines(lines)
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n')
}
