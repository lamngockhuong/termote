import { afterEach, describe, expect, it } from 'vitest'
import { quoteBlock, selectionText } from './chat-quote'
import { MAX_QUOTE_BYTES } from './review-message'
import { utf8Bytes } from './task-failure-message'

function mount(html: string): HTMLElement {
  const root = document.createElement('section')
  root.innerHTML = html
  document.body.append(root)
  return root
}

// The whole of root's content
function all(root: Element): Range {
  const r = document.createRange()
  r.selectNodeContents(root)
  return r
}

const textIn = (root: Element, selector: string) =>
  root.querySelector(selector)?.firstChild as Text

describe('selectionText', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('numbers an ordered list from its start, dashes a bulleted one', () => {
    const root = mount(
      '<p>Questions:</p><ol>\n<li>Which <strong>port</strong>?</li>\n<li>Which user?</li>\n</ol>' +
        '<ol start="7"><li>Seven</li><li>Eight</li></ol><ul><li>dot</li><li>dot<ul><li>inner</li></ul></li></ul>',
    )
    expect(selectionText(all(root), root)).toBe(
      'Questions:\n1. Which port?\n2. Which user?\n7. Seven\n8. Eight\n- dot\n- dot\n  - inner\n',
    )
  })

  it('an ordered list without a usable start counts from 1', () => {
    const root = mount('<ol start="x"><li>a</li></ol>')
    expect(selectionText(all(root), root)).toBe('1. a\n')
  })

  it('takes only the part of the text selected', () => {
    const root = mount(
      '<p id="a">first sentence here</p><p id="b">second one</p>',
    )
    const r = document.createRange()
    r.setStart(textIn(root, '#a'), 6)
    r.setEnd(textIn(root, '#b'), 6)
    expect(selectionText(r, root)).toBe('sentence here\nsecond')
    // Both ends in one text node
    const one = document.createRange()
    one.setStart(textIn(root, '#a'), 6)
    one.setEnd(textIn(root, '#a'), 14)
    expect(selectionText(one, root)).toBe('sentence')
  })

  it('parts table cells, keeps code as written, breaks at a br', () => {
    const root = mount(
      '<table><tbody>\n<tr>\n<td>a</td>\n<td>b</td></tr><tr><th>c</th><td>d</td></tr></tbody></table>' +
        '<pre><code>if x:\n    y()</code></pre><p class="whitespace-pre-wrap">two  spaces</p><p>one<br>two</p>',
    )
    expect(selectionText(all(root), root)).toBe(
      'a | b\nc | d\nif x:\n    y()\ntwo  spaces\none\ntwo\n',
    )
  })

  it('collapses layout whitespace outside code', () => {
    const root = mount('<p>  some\n   wrapped   text </p><p> <em>next</em></p>')
    expect(selectionText(all(root), root)).toBe('some wrapped text \nnext\n')
  })

  it('leaves out buttons, icons and unselectable marks', () => {
    const root = mount(
      '<div><button>Copy</button><svg><text>icon</text></svg><pre><span class="select-none">$ </span>ls -la</pre></div><!-- note -->',
    )
    expect(selectionText(all(root), root)).toBe('ls -la\n')
  })

  it('a folded capped block gives only the lines it shows', () => {
    const root = mount(
      '<p>before</p><div data-quote-clip="2"><pre>l1\nl2\nl3\nl4</pre></div><p>after</p>',
    )
    expect(selectionText(all(root), root)).toBe('before\nl1\nl2\n…\nafter\n')
    // Starting on the second line: one line left on screen
    const pre = textIn(root, 'pre')
    const r = document.createRange()
    r.setStart(pre, 4)
    r.setEnd(textIn(root, 'p:last-child'), 5)
    expect(selectionText(r, root)).toBe('2\n…\nafter')
    // Starting below what shows: nothing of it
    r.setStart(pre, 9)
    expect(selectionText(r, root)).toBe('after')
    // Ending inside it
    const end = document.createRange()
    end.setStart(textIn(root, 'p'), 0)
    end.setEnd(pre, 4)
    expect(selectionText(end, root)).toBe('before\nl1\nl')
    // All of it fits: no "…"
    const short = mount(
      '<div data-quote-clip="3"><div>a</div><div>b</div></div>',
    )
    expect(selectionText(all(short), short)).toBe('a\nb\n')
  })

  it('a selection starting on the block itself counts no line above', () => {
    const root = mount('<div data-quote-clip="1"><pre>l1\nl2</pre></div>')
    const block = root.firstChild as Element
    const r = document.createRange()
    r.setStart(block, 0)
    r.setEnd(block, 1)
    expect(selectionText(r, root)).toBe('l1\n…\n')
  })
})

describe('quoteBlock', () => {
  it('quotes each line, a blank one as ">"', () => {
    expect(quoteBlock('one line')).toBe('> one line')
    expect(quoteBlock('\n\na  \r\n\r\n\r\n\nb\n\n')).toBe('> a\n>\n> b')
  })

  it('nothing but whitespace gives nothing', () => {
    expect(quoteBlock(' \n\t\n')).toBe('')
  })

  it('shows what hides or changes text, and no image of the draft', () => {
    expect(quoteBlock('a\u202eb\u200bc\u{E0041}')).toBe(
      '> a⟨U+202E⟩b⟨U+200B⟩c⟨U+E0041⟩',
    )
    expect(quoteBlock('see [Image #1] and [Image #12]')).toBe(
      '> see [Image 1] and [Image 12]',
    )
  })

  it('keeps 60 lines, then counts the rest', () => {
    const text = Array.from({ length: 61 }, (_, i) => `l${i}`).join('\n')
    const lines = quoteBlock(text).split('\n')
    expect(lines).toHaveLength(61)
    expect(lines[59]).toBe('> l59')
    expect(lines[60]).toBe('> (1 more line)')
  })

  it('one line longer than a quote still gives text, cut on a character', () => {
    const q = quoteBlock('é'.repeat(MAX_QUOTE_BYTES))
    const line = q.slice(2)
    expect(line.length).toBeGreaterThan(0)
    expect(utf8Bytes(line)).toBe(MAX_QUOTE_BYTES)
    expect(line).toMatch(/^é+$/)
  })
})
