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

// Text that is not part of what was written: a button's label, an icon, a
// mark drawn beside the text ("$ " before a command, a diff's sign)
const SKIP = 'button, svg, script, style, .select-none'

// Elements whose own whitespace between children is only layout
const LAYOUT = new Set(['OL', 'UL', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR'])

// Whitespace kept as written: a code block, a message shown line by line
const KEEPS_SPACE = 'pre, [class*="whitespace-pre"]'

class Out {
  s = ''
  // The range's end was reached: the blocks around it end without a line
  // after them (what a selection's start has above it is counted on this)
  done = false
  // Starts a new line, unless one just started
  line() {
    if (this.s && !this.s.endsWith('\n')) this.s += '\n'
  }
  text(t: string, keepSpace: boolean) {
    if (!keepSpace) {
      t = t.replace(/[ \t\n\r\f]+/g, ' ')
      if (this.s === '' || /[ \n]$/.test(this.s)) t = t.replace(/^ /, '')
    }
    this.s += t
  }
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
    const textNode = node as Text
    let d = textNode.data
    if (node === range.endContainer) {
      d = d.slice(0, range.endOffset)
      out.done = true
    }
    if (node === range.startContainer) d = d.slice(range.startOffset)
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
    out.s += '  '.repeat(depth(el, root)) + marker(el)
  }
  if (
    (el.tagName === 'TD' || el.tagName === 'TH') &&
    el.previousElementSibling &&
    range.intersectsNode(el.previousElementSibling)
  ) {
    out.s += ' | '
  }
  for (const child of el.childNodes) walk(child, range, root, out)
  if (el === range.endContainer) out.done = true
  if (block && !out.done) out.line()
}

// A capped block shown folded (data-quote-clip: the lines it shows): only
// the lines on screen, then "…" when more were selected
function clipped(
  el: Element,
  shown: number,
  range: Range,
  root: Element,
  out: Out,
) {
  const inner = new Out()
  for (const child of el.childNodes) walk(child, range, root, inner)
  // The block's lines above the selection's start
  let above = 0
  if (el.contains(range.startContainer) && el !== range.startContainer) {
    const before = document.createRange()
    before.setStart(el, 0)
    before.setEnd(range.startContainer, range.startOffset)
    const head = new Out()
    for (const child of el.childNodes) walk(child, before, root, head)
    above = head.s.split('\n').length - 1
  }
  const room = shown - above
  if (room <= 0) {
    out.done = inner.done
    return
  }
  const lines = inner.s.replace(/\n$/, '').split('\n')
  const kept = lines.slice(0, room)
  if (lines.length > room) kept.push('…')
  out.line()
  out.s += kept.join('\n')
  out.done = inner.done
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
