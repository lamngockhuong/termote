import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import type { FileBlame } from '../hooks/use-mux-api'
import {
  CodeBlock,
  MAX_LINES,
  splitLines,
  WINDOW_FROM_LINES,
} from './code-block'

const mockHighlight = vi.fn()
vi.mock('../utils/highlight', () => ({
  highlight: (...a: unknown[]) => mockHighlight(...a),
}))

const show = (text: string, wrap = false) =>
  render(
    <ThemeProvider>
      <CodeBlock text={text} path="a.ts" wrap={wrap} />
    </ThemeProvider>,
  )

const lines = () =>
  [...screen.getByTestId('code-block').querySelectorAll('code')].map(
    (c) => c.textContent,
  )

beforeEach(() => mockHighlight.mockReset())

describe('splitLines', () => {
  it('drops the empty line after a final newline only', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\n\n')).toEqual(['a', ''])
    expect(splitLines('')).toEqual([''])
  })
})

describe('CodeBlock', () => {
  it('shows the text plain with line numbers until the tokens come', async () => {
    let done!: (t: unknown) => void
    mockHighlight.mockReturnValue(new Promise((r) => (done = r)))
    show('const a\n\nb\n')
    expect(lines()).toEqual(['const a', ' ', 'b'])
    // The text keeps the browser's menu
    expect(screen.getByTestId('code-block')).toHaveAttribute('data-native-menu')
    expect(screen.getByText('3')).toHaveAttribute('aria-hidden', 'true')
    expect(mockHighlight).toHaveBeenCalledWith(
      'const a\n\nb\n',
      'a.ts',
      'light',
    )
    await act(async () =>
      done([
        [
          ['const', '#f00', 1],
          [' a', '#0f0', 6],
        ],
        [],
        [['b', undefined, 0]],
      ]),
    )
    const kw = screen.getByText('const')
    expect(kw).toHaveStyle({ color: '#f00', fontStyle: 'italic' })
    const a = screen.getByText('a')
    expect(a.style.fontWeight).toBe('bold')
    expect(a.style.textDecoration).toBe('underline')
    expect(lines()).toEqual(['const a', '', 'b'])
  })

  it('stays plain when the worker answers null', async () => {
    mockHighlight.mockResolvedValue(null)
    show('x')
    await act(async () => {})
    expect(lines()).toEqual(['x'])
  })

  it('ignores tokens of a text no longer shown', async () => {
    let first!: (t: unknown) => void
    mockHighlight
      .mockReturnValueOnce(new Promise((r) => (first = r)))
      .mockResolvedValueOnce(null)
    const { rerender } = show('old')
    rerender(
      <ThemeProvider>
        <CodeBlock text="new" path="a.ts" wrap />
      </ThemeProvider>,
    )
    await act(async () => first([[['OLD']]]))
    expect(lines()).toEqual(['new'])
    expect(screen.getByTestId('code-block').querySelector('code')).toHaveClass(
      'whitespace-pre-wrap',
    )
  })
})

describe('CodeBlock scroll', () => {
  it('starts at the offset it was left at, marked for the viewer', () => {
    mockHighlight.mockResolvedValue(null)
    render(
      <ThemeProvider>
        <CodeBlock text={'a\nb'} path="a.ts" wrap={false} scrollTop={64} />
      </ThemeProvider>,
    )
    const frame = screen.getByTestId('code-block')
    expect(frame.scrollTop).toBe(64)
    expect(frame).toHaveAttribute('data-scroll-restore')
  })
})

describe('CodeBlock at a line', () => {
  const at = (
    line: number | undefined,
    jump: number | undefined,
    scrollTop?: number,
  ) => (
    <ThemeProvider>
      <CodeBlock
        text={'a\nb\nc\n'}
        path="a.ts"
        wrap={false}
        line={line}
        jump={jump}
        scrollTop={scrollTop}
      />
    </ThemeProvider>
  )
  const row = (n: number) =>
    screen.getByTestId('code-block').querySelector(`[data-line="${n}"]`)

  it('scrolls the line to the middle and highlights it, at each pick', () => {
    mockHighlight.mockResolvedValue(null)
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const view = render(at(2, 1, 50))
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.contexts[0]).toBe(row(2))
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    expect(screen.getByTestId('code-block').scrollTop).toBe(0)
    expect(row(2)).toHaveClass('bg-accent/15')
    expect(row(1)).toHaveClass('bg-bg')
    // The same line again: once more
    view.rerender(at(2, 2))
    expect(scroll).toHaveBeenCalledTimes(2)
    // The line dropped (the user scrolled): the highlight stays until a pick
    view.rerender(at(undefined, 2))
    expect(scroll).toHaveBeenCalledTimes(2)
    expect(row(2)).toHaveClass('bg-accent/15')
    view.rerender(at(3, 3))
    expect(row(3)).toHaveClass('bg-accent/15')
    expect(row(2)).toHaveClass('bg-bg')
  })

  it('without a line, starts at the offset kept', () => {
    mockHighlight.mockResolvedValue(null)
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    render(at(undefined, undefined, 50))
    expect(scroll).not.toHaveBeenCalled()
  })
})

describe('CodeBlock of many lines', () => {
  const numbered = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')
  const many = (n: number, line?: number, jump?: number) => (
    <ThemeProvider>
      <CodeBlock
        text={numbered(n)}
        path="a.log"
        wrap={false}
        line={line}
        jump={jump}
      />
    </ThemeProvider>
  )
  const row = (n: number) =>
    screen.getByTestId('code-block').querySelector(`[data-line="${n}"]`)
  const rows = () =>
    screen.getByTestId('code-block').querySelectorAll('[data-line]').length

  beforeEach(() => mockHighlight.mockResolvedValue(null))

  it('shows every line up to the limit', () => {
    render(many(WINDOW_FROM_LINES))
    expect(rows()).toBe(WINDOW_FROM_LINES)
  })

  it('past it, puts only the lines near the view in the page, the rest as space', () => {
    render(many(5000))
    expect(rows()).toBeLessThan(WINDOW_FROM_LINES)
    expect(row(1)).not.toBeNull()
    expect(row(5000)).toBeNull()
    const frame = screen.getByTestId('code-block')
    expect(frame.style.overflowAnchor).toBe('none')
    const spacer = frame.firstElementChild?.lastElementChild as HTMLElement
    expect(Number.parseFloat(spacer.style.height)).toBeGreaterThan(0)
  })

  it('follows the scroll', async () => {
    render(many(5000))
    const frame = screen.getByTestId('code-block')
    Object.defineProperty(frame, 'clientHeight', { value: 400 })
    frame.scrollTop = 19.2 * 3000
    fireEvent.scroll(frame)
    await waitFor(() => expect(row(3000)).not.toBeNull())
    expect(row(1)).toBeNull()
  })

  it('shows at most MAX_LINES, saying how many more there are', () => {
    render(many(MAX_LINES + 5))
    expect(
      screen.getByText(
        '5 more lines are not shown: download the file to read them',
      ),
    ).toBeInTheDocument()
  })

  it('brings a line asked for into the page, then scrolls to it', () => {
    // jsdom lays nothing out, so the scroll moves nothing: what counts is
    // the row it was asked of, there and marked at that moment
    const asked: [string | null, boolean][] = []
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      asked.push([
        this.getAttribute('data-line'),
        this.classList.contains('bg-accent/15'),
      ])
    })
    const view = render(many(5000, 4000, 1))
    expect(asked).toEqual([['4000', true]])
    view.rerender(many(5000, 4999, 2))
    expect(asked.at(-1)).toEqual(['4999', true])
  })
})

describe('CodeBlock lines picked for a comment', () => {
  const pickable = (onLineComment = vi.fn(), commentedLines?: Set<number>) => {
    mockHighlight.mockResolvedValue(null)
    render(
      <ThemeProvider>
        <CodeBlock
          text={'a\nb\nc\nd\n'}
          path="a.ts"
          wrap={false}
          onLineComment={onLineComment}
          commentedLines={commentedLines}
        />
      </ThemeProvider>,
    )
    return onLineComment
  }
  const num = (n: number) => screen.getByRole('button', { name: `Line ${n}` })

  it('has no buttons unless asked', () => {
    mockHighlight.mockResolvedValue(null)
    show('a\n')
    expect(screen.queryByRole('button', { name: 'Line 1' })).toBeNull()
  })

  it('picks a line, extends with Shift, and comments on the range', () => {
    const onLineComment = pickable()
    fireEvent.click(num(3))
    expect(screen.getByText('Line 3')).toBeInTheDocument()
    fireEvent.click(num(2), { shiftKey: true })
    expect(screen.getByText('Lines 2-3')).toBeInTheDocument()
    expect(
      screen.getByTestId('code-block').querySelector('[data-line="2"]'),
    ).toHaveClass('bg-accent/15')
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(onLineComment).toHaveBeenCalledWith({
      from: 2,
      to: 3,
      lines: ['b', 'c'],
    })
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
  })

  it('clears the pick, and a press on the line picked alone', () => {
    pickable()
    fireEvent.click(num(1))
    fireEvent.click(screen.getByRole('button', { name: 'Clear the lines' }))
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
    fireEvent.click(num(1))
    fireEvent.click(num(1))
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
  })

  it('drops the pick when the file is read again', () => {
    mockHighlight.mockResolvedValue(null)
    const ui = (text: string) => (
      <ThemeProvider>
        <CodeBlock
          text={text}
          path="a.ts"
          wrap={false}
          onLineComment={vi.fn()}
        />
      </ThemeProvider>
    )
    const v = render(ui('a\nb'))
    fireEvent.click(num(2))
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument()
    v.rerender(ui('b'))
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
  })

  it('keeps a line picked before the first effects ran', async () => {
    mockHighlight.mockResolvedValue(null)
    // Outside act, as the app runs: a line can be pressed as soon as it is
    // on screen, while the mount's effects still wait for the scheduler
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const acting = env.IS_REACT_ACT_ENVIRONMENT
    env.IS_REACT_ACT_ENVIRONMENT = false
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    let seen: MutationObserver | undefined
    try {
      const pressed = new Promise<void>((resolve) => {
        seen = new MutationObserver(() => {
          const line = within(host).queryByRole('button', { name: 'Line 2' })
          if (!line) return
          seen?.disconnect()
          line.click()
          resolve()
        })
        seen.observe(host, { childList: true, subtree: true })
      })
      root.render(
        <ThemeProvider>
          <CodeBlock
            text={'a\nb\n'}
            path="a.ts"
            wrap={false}
            onLineComment={vi.fn()}
          />
        </ThemeProvider>,
      )
      await pressed
      await waitFor(() =>
        expect(
          within(host).getByRole('button', { name: 'Comment' }),
        ).toBeInTheDocument(),
      )
    } finally {
      seen?.disconnect()
      root.unmount()
      host.remove()
      env.IS_REACT_ACT_ENVIRONMENT = acting
    }
  })

  it('marks the lines a comment is on', () => {
    pickable(vi.fn(), new Set([4]))
    expect(num(4)).toHaveAttribute('data-commented', 'true')
    expect(num(3)).not.toHaveAttribute('data-commented')
  })

  it('keeps a double click on a number from the view around it', () => {
    const onDoubleClick = vi.fn()
    mockHighlight.mockResolvedValue(null)
    render(
      <ThemeProvider>
        <div onDoubleClick={onDoubleClick}>
          <CodeBlock
            text="a"
            path="a.ts"
            wrap={false}
            onLineComment={vi.fn()}
          />
        </div>
      </ThemeProvider>,
    )
    fireEvent.doubleClick(num(1))
    expect(onDoubleClick).not.toHaveBeenCalled()
  })
})

describe('CodeBlock blame', () => {
  const H1 = '1'.repeat(40)
  const H2 = '2'.repeat(40)
  const blameOf = (lines: number, ranges: FileBlame['ranges']): FileBlame => ({
    root: '/r',
    path: 'a.ts',
    lines,
    commits: {
      [H1]: { author: 'Alice', time: 1_700_000_000, summary: 'first' },
      [H2]: { author: 'Bob', time: 1_700_000_000, summary: 'second' },
    },
    ranges,
    uncommitted: [],
  })
  const BLAME = blameOf(4, [
    { start: 1, count: 2, commit: H1 },
    { start: 4, count: 1, commit: H2 },
  ])
  const shown = (
    text: string,
    data: FileBlame,
    extra: Partial<Parameters<typeof CodeBlock>[0]> = {},
  ) => {
    mockHighlight.mockResolvedValue(null)
    const notify = vi.fn()
    const view = render(
      <ThemeProvider>
        <CodeBlock
          text={text}
          path="a.ts"
          wrap={false}
          blame={{ data, compact: false, notify }}
          {...extra}
        />
      </ThemeProvider>,
    )
    return { notify, ...view }
  }
  const cellOf = (n: number) =>
    screen.getByTestId('code-block').querySelector(`[data-line="${n}"]`)
      ?.firstElementChild?.firstElementChild as HTMLElement

  it('writes the commit once per run of lines, before the numbers', () => {
    shown('a\nb\nc\nd\n', BLAME)
    expect(cellOf(1)).toHaveTextContent('Alice')
    expect(cellOf(2)).toHaveTextContent('')
    expect(cellOf(3)).toHaveTextContent('Not committed')
    expect(cellOf(4)).toHaveTextContent('Bob')
    // The blame and the number stay put together
    expect(cellOf(1).parentElement?.className).toContain('sticky')
    expect(screen.queryByText(/git counts the lines/)).toBeNull()
  })

  it("opens a commit's details from its cell, and closes them", () => {
    shown('a\nb\nc\nd\n', BLAME)
    fireEvent.click(screen.getByRole('button', { name: /^Bob,/ }))
    expect(screen.getByRole('dialog')).toHaveTextContent('second')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves the column out, with a note, when git counted other lines', () => {
    shown('a\nb\n', BLAME)
    expect(
      screen.getByText(
        'Blame is hidden: git counts the lines of this file differently (its encoding)',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('Alice')).toBeNull()
  })

  it('blames no line of an empty file', () => {
    shown('', blameOf(0, []))
    expect(screen.queryByText(/git counts the lines/)).toBeNull()
  })

  it('keeps the line buttons of a comment beside the column', () => {
    shown('a\nb\nc\nd\n', BLAME, { onLineComment: vi.fn() })
    expect(screen.getByRole('button', { name: 'Line 2' })).toBeInTheDocument()
    expect(cellOf(1)).toHaveTextContent('Alice')
  })

  it('counts the column in the width of a long file not wrapped', () => {
    const text = `${'x\n'.repeat(WINDOW_FROM_LINES)}${'y'.repeat(80)}\n`
    const lines = WINDOW_FROM_LINES + 1
    shown(text, blameOf(lines, [{ start: 1, count: lines, commit: H1 }]))
    const inner = screen.getByTestId('code-block')
      .firstElementChild as HTMLElement
    expect(inner.style.minWidth).toContain('11.5rem')
    expect(cellOf(1)).toHaveTextContent('Alice')
  })
})
