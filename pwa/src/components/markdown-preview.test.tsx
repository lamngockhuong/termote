import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import type { Token } from '../utils/highlight'
import MarkdownPreview from './markdown-preview'

const mockHighlight = vi.fn()
vi.mock('../utils/highlight', async (orig) => ({
  ...(await orig<typeof import('../utils/highlight')>()),
  highlightLang: (...a: unknown[]) => mockHighlight(...a),
}))

const scrollIntoView = vi.fn()

function show(text: string, over: Record<string, unknown> = {}) {
  const props = {
    text,
    path: 'docs/guide/intro.md',
    wrap: false,
    onFollow: vi.fn(),
    notify: vi.fn(),
    ...over,
  }
  const view = render(
    <ThemeProvider>
      <MarkdownPreview {...props} />
    </ThemeProvider>,
  )
  return { ...props, ...view }
}

beforeEach(() => {
  mockHighlight.mockReset().mockResolvedValue(null)
  scrollIntoView.mockReset()
  Element.prototype.scrollIntoView = scrollIntoView
})
afterEach(() => vi.unstubAllGlobals())

describe('MarkdownPreview: rendering', () => {
  it('renders GFM: tables that scroll, read-only task lists, strikethrough, footnotes', () => {
    const { container } = show(
      [
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '~~old~~ www.example.com',
        '',
        'Note[^1]',
        '',
        '[^1]: The note.',
      ].join('\n'),
    )
    const table = screen.getByRole('table')
    expect(table.parentElement).toHaveClass('overflow-x-auto')
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toBeChecked()
    expect(boxes[0]).toBeDisabled()
    expect(container.querySelector('del')).toHaveTextContent('old')
    expect(
      screen.getByRole('link', { name: 'www.example.com' }),
    ).toHaveAttribute('href', 'http://www.example.com/')
    expect(container.querySelector('.footnotes')).toHaveTextContent('The note.')
  })

  it('shows front matter as code, not as text and a rule', () => {
    const { container } = show('---\ntitle: Hi\n---\n# Body')
    const blocks = screen.getAllByTestId('fenced-code')
    expect(blocks[0]).toHaveTextContent('front matter')
    expect(blocks[0]).toHaveTextContent('title: Hi')
    expect(container.querySelector('hr')).toBeNull()
    expect(mockHighlight).toHaveBeenCalledWith(
      'title: Hi',
      'yaml',
      'light',
      expect.any(AbortSignal),
    )
  })

  it('shows raw HTML and MDX JSX as text, never as elements', () => {
    const { container } = show(
      "import Tabs from './tabs'\n\n<Tabs items={[1]} />\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>",
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('tabs')).toBeNull()
    expect(container).toHaveTextContent("import Tabs from './tabs'")
    expect(container).toHaveTextContent('<Tabs items={[1]} />')
  })

  it('folds <details> blocks into disclosures whose body is still markdown', () => {
    const { container } = show(
      [
        '1. Question?',
        '',
        '   <details><summary>Reference answer</summary>',
        '',
        '   Uses `code` and **bold**.',
        '',
        '   </details>',
        '',
        '<details open class="x" onclick="alert(1)">',
        '<summary>Outer</summary>',
        '',
        '<details>',
        '',
        'Inner',
        '',
        '</details>',
        '</details>',
        '',
        '<details><summary>One line</summary>Hidden</details>',
      ].join('\n'),
    )
    const all = container.querySelectorAll('details')
    expect(all).toHaveLength(4)
    const [answer, outer, inner, line] = Array.from(all)
    expect(answer.querySelector('summary')).toHaveTextContent(
      'Reference answer',
    )
    expect(answer.querySelector('code')).toHaveTextContent('code')
    expect(answer.querySelector('strong')).toHaveTextContent('bold')
    expect(answer.open).toBe(false)
    expect(outer.open).toBe(true)
    expect(outer.getAttribute('class')).toBeNull()
    expect(outer.getAttribute('onclick')).toBeNull()
    expect(outer.contains(inner)).toBe(true)
    expect(inner.querySelector('summary')).toBeNull()
    expect(inner).toHaveTextContent('Inner')
    expect(line).toHaveTextContent('Hidden')
    expect(container).not.toHaveTextContent('<details')
    expect(container).not.toHaveTextContent('</summary>')
  })

  it('leaves an unclosed <details> and the HTML around it as text', () => {
    const { container } = show(
      '<details><summary>Open</summary>\n\nBody <b>x</b>',
    )
    expect(container.querySelector('details')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container).toHaveTextContent('<details><summary>Open</summary>')
  })

  it('gives headings GitHub ids', () => {
    show('# Getting Started\n\n## Getting Started')
    const [h1, h2] = screen.getAllByRole('heading')
    expect(h1.id).toBe('user-content-getting-started')
    expect(h2.id).toBe('user-content-getting-started-1')
  })

  it('keeps inline code in the terminal font, outside a code block', () => {
    const { container } = show('Run `make`')
    expect(container.querySelector('code')).toHaveTextContent('make')
    expect(screen.queryByTestId('fenced-code')).toBeNull()
  })
})

describe('MarkdownPreview: code blocks', () => {
  it('highlights a fenced block in its language', async () => {
    const tokens: Token[][] = [[['const', '#f00', 1]], [['x', '#0f0', 2]]]
    mockHighlight.mockResolvedValue(tokens)
    show('```ts\nconst\nx\n```')
    expect(mockHighlight).toHaveBeenCalledWith(
      'const\nx',
      'typescript',
      'light',
      expect.any(AbortSignal),
    )
    await waitFor(() =>
      expect(screen.getByText('const')).toHaveStyle({
        color: '#f00',
        fontStyle: 'italic',
      }),
    )
    expect(screen.getByTestId('fenced-code')).toHaveTextContent('ts')
  })

  it('a block without a known language is plain text', () => {
    show('```\nplain\n```\n\n```nosuchlang\ngraph TD\n```')
    const [plain, other] = screen.getAllByTestId('fenced-code')
    expect(plain).toHaveTextContent('text')
    expect(plain).toHaveTextContent('plain')
    expect(other).toHaveTextContent('nosuchlang')
    const signal = expect.any(AbortSignal)
    expect(mockHighlight).toHaveBeenCalledWith(
      'plain',
      undefined,
      'light',
      signal,
    )
    expect(mockHighlight).toHaveBeenCalledWith(
      'graph TD',
      undefined,
      'light',
      signal,
    )
  })

  it('wraps code blocks when Wrap is on', () => {
    const { container } = show('```\nx\n```', { wrap: true })
    expect(container.querySelector('pre code')).toHaveClass(
      'whitespace-pre-wrap',
    )
  })

  it('drops a highlight that comes after the block changed', async () => {
    let finish!: (t: Token[][]) => void
    mockHighlight
      .mockReturnValueOnce(new Promise((r) => (finish = r)))
      .mockResolvedValue(null)
    const p = show('```ts\nold\n```')
    p.rerender(
      <ThemeProvider>
        <MarkdownPreview {...p} text={'```ts\nnew\n```'} />
      </ThemeProvider>,
    )
    await act(async () => finish([[['old', '#f00']]]))
    expect(screen.getByTestId('fenced-code')).toHaveTextContent('new')
  })

  it('cancels the highlight of a block that is gone or changed', () => {
    const p = show('```ts\nold\n```')
    const first: AbortSignal = mockHighlight.mock.calls[0][3]
    expect(first.aborted).toBe(false)
    p.rerender(
      <ThemeProvider>
        <MarkdownPreview {...p} text={'```ts\nnew\n```'} />
      </ThemeProvider>,
    )
    expect(first.aborted).toBe(true)
    const second: AbortSignal = mockHighlight.mock.calls[1][3]
    p.unmount()
    expect(second.aborted).toBe(true)
  })

  it('copies a block', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const p = show('```sh\necho hi\n```')
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' })),
    )
    expect(writeText).toHaveBeenCalledWith('echo hi')
    expect(p.notify).toHaveBeenCalledWith('Code copied')
  })

  it('says when copying fails', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
    })
    const p = show('```\nx\n```')
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' })),
    )
    expect(p.notify).toHaveBeenCalledWith('Could not copy the code')
  })
})

describe('MarkdownPreview: links', () => {
  it('follows a relative link from the scroll offset it was left at', () => {
    const p = show('[readme](../../README.md#install) [src](/src/)')
    const box = screen.getByTestId('markdown-preview')
    box.scrollTop = 40
    fireEvent.click(screen.getByRole('button', { name: 'readme' }))
    expect(p.onFollow).toHaveBeenCalledWith(
      { kind: 'path', path: 'README.md', anchor: 'install' },
      40,
      { newTab: false },
    )
    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    expect(p.onFollow).toHaveBeenLastCalledWith(
      { kind: 'path', path: 'src', anchor: undefined },
      40,
      { newTab: false },
    )
  })

  it('a draft being edited follows a link from where the editor is, and is not kept as the scroll', () => {
    const p = show('[readme](../../README.md)', {
      editing: true,
      followScrollTop: () => 75,
    })
    const box = screen.getByTestId('markdown-preview')
    expect(box).not.toHaveAttribute('data-scroll-restore')
    expect(box).toHaveAttribute('tabindex', '-1')
    box.scrollTop = 40
    fireEvent.click(screen.getByRole('button', { name: 'readme' }))
    expect(p.onFollow).toHaveBeenCalledWith(
      { kind: 'path', path: 'README.md', anchor: undefined },
      75,
      { newTab: false },
    )
  })

  it('a file only viewed is kept as the scroll, and takes no focus', () => {
    show('x')
    const box = screen.getByTestId('markdown-preview')
    expect(box).toHaveAttribute('data-scroll-restore')
    expect(box).not.toHaveAttribute('tabindex')
  })

  it('scrolls to a heading of the same file', () => {
    const p = show(
      '[go](#usage) [self](intro.md#Usage) [top](intro.md)\n\n## Usage',
    )
    const box = screen.getByTestId('markdown-preview')
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    fireEvent.click(screen.getByRole('button', { name: 'self' }))
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    box.scrollTop = 50
    fireEvent.click(screen.getByRole('button', { name: 'top' }))
    expect(box.scrollTop).toBe(0)
    expect(p.onFollow).not.toHaveBeenCalled()
  })

  it('opens the closed disclosures around a heading it scrolls to', () => {
    const { container } = show(
      '[go](#deep)\n\n<details>\n\n<details>\n\n## Deep\n\n</details>\n\n</details>',
    )
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    const all = Array.from(container.querySelectorAll('details'))
    expect(all).toHaveLength(2)
    expect(all.every((d) => d.open)).toBe(true)
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('says when a heading is missing', () => {
    const p = show('[go](#nowhere)')
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    expect(p.notify).toHaveBeenCalledWith('Heading not found')
  })

  it('footnote links jump inside the file, keeping their ids and labels', () => {
    show('Note[^1]\n\n[^1]: The note.')
    const ref = screen.getByRole('button', { name: '1' })
    expect(ref.id).toBe('user-content-fnref-1')
    fireEvent.click(ref)
    const back = screen.getByRole('button', { name: /Back to reference 1/ })
    fireEvent.click(back)
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })

  it('opens http(s) links in a new tab, naming the host', () => {
    show('[site](https://example.com/x)')
    const a = screen.getByRole('link', { name: 'site' })
    expect(a).toHaveAttribute('href', 'https://example.com/x')
    expect(a).toHaveAttribute('target', '_blank')
    expect(a).toHaveAttribute('rel', 'noopener noreferrer')
    expect(a).toHaveAttribute('title', 'example.com')
  })

  it('never follows other schemes or paths that leave the root', () => {
    const p = show(
      '[js](javascript:alert(1)) [file](file:///etc/passwd) [up](../../../../etc/passwd)',
    )
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('up').tagName).toBe('SPAN')
    expect(p.onFollow).not.toHaveBeenCalled()
  })

  it('Ctrl/Cmd+click, a middle click or a long press ask for a new tab', () => {
    vi.useFakeTimers()
    try {
      const p = show('[readme](../../README.md) [up](/src/)')
      const link = screen.getByRole('button', { name: 'readme' })
      const target = { kind: 'path', path: 'README.md', anchor: undefined }
      fireEvent.click(link, { ctrlKey: true })
      expect(p.onFollow).toHaveBeenLastCalledWith(target, 0, { newTab: true })
      fireEvent.click(link, { metaKey: true })
      expect(p.onFollow).toHaveBeenCalledTimes(2)
      // A middle click, without the browser's autoscroll
      const down = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 1,
      })
      link.dispatchEvent(down)
      expect(down.defaultPrevented).toBe(true)
      fireEvent(link, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
      expect(p.onFollow).toHaveBeenCalledTimes(3)
      // A right click does nothing
      fireEvent(link, new MouseEvent('auxclick', { bubbles: true, button: 2 }))
      fireEvent.mouseDown(link, { button: 0 })
      expect(p.onFollow).toHaveBeenCalledTimes(3)
      // A long press, then the click that ends it is swallowed
      fireEvent.pointerDown(link, { pointerType: 'touch' })
      vi.advanceTimersByTime(500)
      expect(p.onFollow).toHaveBeenLastCalledWith(target, 0, { newTab: true })
      fireEvent.click(link)
      expect(p.onFollow).toHaveBeenCalledTimes(4)
      // A tap follows in the tab
      fireEvent.click(screen.getByRole('button', { name: 'up' }))
      expect(p.onFollow).toHaveBeenLastCalledWith(
        { kind: 'path', path: 'src', anchor: undefined },
        0,
        { newTab: false },
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts at the heading it was opened at', () => {
    show('# A\n\n## Usage', { anchor: 'usage' })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toHaveTextContent('Usage')
  })

  it('starts at the offset it was left at', () => {
    show('# A', { scrollTop: 120 })
    expect(screen.getByTestId('markdown-preview').scrollTop).toBe(120)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})

describe('MarkdownPreview: start kept while diagrams draw', () => {
  // Reports a size change of the observed content, on demand
  let resize: (() => void) | null = null
  let observed: Element | null = null
  beforeEach(() => {
    resize = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: () => void) {}
        observe(el: Element) {
          observed = el
          resize = () => this.cb()
        }
        disconnect() {
          resize = null
        }
      },
    )
  })
  afterEach(() => vi.useRealTimers())

  it('scrolls back to the heading when the content above grows', () => {
    show('# A\n\n## Usage', { anchor: 'usage' })
    const box = screen.getByTestId('markdown-preview')
    expect(observed).toBe(box.firstElementChild)
    scrollIntoView.mockClear()
    resize?.()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toHaveTextContent('Usage')
  })

  it('a heading gone meanwhile is left alone, without a message', () => {
    const p = show('# A\n\n## Usage', { anchor: 'gone' })
    scrollIntoView.mockClear()
    resize?.()
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(p.notify).toHaveBeenCalledTimes(1)
  })

  it('puts the offset back when the content grows', () => {
    show('# A', { scrollTop: 120 })
    const box = screen.getByTestId('markdown-preview')
    box.scrollTop = 40
    resize?.()
    expect(box.scrollTop).toBe(120)
  })

  it.each(['wheel', 'touchStart', 'keyDown', 'pointerDown'] as const)(
    'stops once the user scrolls (%s)',
    (event) => {
      show('# A', { scrollTop: 120 })
      const box = screen.getByTestId('markdown-preview')
      fireEvent[event](box)
      expect(resize).toBeNull()
      // A second event finds nothing left to stop
      fireEvent[event](box)
    },
  )

  it('stops after 10 seconds', () => {
    vi.useFakeTimers()
    show('# A', { anchor: 'a' })
    vi.advanceTimersByTime(9999)
    expect(resize).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(resize).toBeNull()
  })

  it('stops when the preview is gone', () => {
    const p = show('# A', { scrollTop: 10 })
    p.unmount()
    expect(resize).toBeNull()
  })

  it('watches nothing for a file opened at its top', () => {
    show('# A')
    expect(resize).toBeNull()
  })
})

describe('MarkdownPreview: images', () => {
  it('never loads an image', () => {
    const p = show(
      '![shot](img/shot.png) ![](img/b.png) ![remote](https://cdn.example/x.png) ![bad](javascript:x)',
    )
    expect(document.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'image: shot' }))
    expect(p.onFollow).toHaveBeenCalledWith(
      { kind: 'path', path: 'docs/guide/img/shot.png', anchor: undefined },
      0,
      { newTab: false },
    )
    expect(
      screen.getByRole('button', { name: 'image: b.png' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'image: cdn.example' }),
    ).toHaveAttribute('target', '_blank')
    expect(screen.getByText('[image: bad]')).toBeInTheDocument()
  })

  it('an image without a usable source or name says so', () => {
    show('![](javascript:x)')
    expect(screen.getByText('[image: unavailable]')).toBeInTheDocument()
  })
})

describe('MarkdownPreview: lines of a draft', () => {
  const FILE = [
    '---', // 1
    'title: T', // 2
    '---', // 3
    '# Head', // 4
    '', // 5
    '- a', // 6
    '- b', // 7
    '', // 8
    '| x | y |', // 9
    '|---|---|', // 10
    '| 1 | 2 |', // 11
    '', // 12
    '```ts', // 13
    'let a', // 14
    '```', // 15
    '', // 16
    '```mermaid', // 17
    'graph TD', // 18
    '```', // 19
    '', // 20
    '<details>', // 21
    '<summary>More</summary>', // 22
    '', // 23
    'Inside', // 24
    '', // 25
    '</details>', // 26
  ].join('\n')

  it('marks each block with the line of the file it starts on', () => {
    const { container } = show(FILE, { editing: true })
    const at = (sel: string) =>
      (container.querySelector(sel) as HTMLElement).dataset.line
    const blocks = screen.getAllByTestId('fenced-code')
    expect(blocks[0]).toHaveAttribute('data-line', '1')
    expect(at('h1')).toBe('4')
    expect(at('ul')).toBe('6')
    // On the box that scrolls the table
    expect(screen.getByRole('table')).not.toHaveAttribute('data-line')
    expect(screen.getByRole('table').parentElement).toHaveAttribute(
      'data-line',
      '9',
    )
    expect(blocks[1]).toHaveAttribute('data-line', '13')
    expect(screen.getByTestId('mermaid-block')).toHaveAttribute(
      'data-line',
      '17',
    )
    expect(at('details')).toBe('21')
    expect(at('details > p')).toBe('24')
  })

  it('marks nothing in a file only viewed', () => {
    const { container } = show(FILE)
    expect(container.querySelector('[data-line]')).toBeNull()
  })

  it('reads and sets the line at its top from where its blocks are laid out', () => {
    let side: import('../hooks/use-scroll-sync').SyncSide | null = null
    const onSyncSide = vi.fn((s) => {
      side = s
    })
    const view = show(
      [
        '# A',
        '',
        'one',
        '',
        '# B',
        '',
        '<details>',
        '',
        'hid',
        '',
        '</details>',
      ].join('\n'),
      { editing: true, onSyncSide },
    )
    const box = screen.getByTestId('markdown-preview')
    const tops: Record<string, number> = {
      '1': 0,
      '3': 40,
      '5': 100,
      '7': 200,
      '9': 50,
    }
    for (const n of box.querySelectorAll<HTMLElement>('[data-line]')) {
      const top = tops[n.dataset.line as string]
      n.getBoundingClientRect = () => ({ top: top - box.scrollTop }) as DOMRect
    }
    box.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    Object.defineProperty(box, 'scrollHeight', { value: 400 })
    const s = side as unknown as import('../hooks/use-scroll-sync').SyncSide
    expect(s.el).toBe(box)
    // Line 4: halfway from the paragraph (line 3) to heading B (line 5)
    s.scrollToLine(4)
    expect(box.scrollTop).toBe(70)
    expect(s.topLine()).toBe(4)
    // The block inside the closed disclosure is not laid out: from the
    // disclosure (7, at 200) to the end (line 12, at 400)
    s.scrollToLine(9.5)
    expect(box.scrollTop).toBe(300)
    view.unmount()
    expect(onSyncSide).toHaveBeenLastCalledWith(null)
  })
})
