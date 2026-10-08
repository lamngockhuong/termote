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
    show('```\nplain\n```\n\n```mermaid\ngraph TD\n```')
    const [plain, mermaid] = screen.getAllByTestId('fenced-code')
    expect(plain).toHaveTextContent('text')
    expect(plain).toHaveTextContent('plain')
    expect(mermaid).toHaveTextContent('mermaid')
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
