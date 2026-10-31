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
import { CodeBlock, firstLines, splitLines } from './code-block'

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

describe('firstLines', () => {
  it('cuts after the last line kept, only when more follow', () => {
    expect(firstLines('a\nb\nc', 2)).toBe('a\nb\n')
    expect(firstLines('a\nb\n\n', 2)).toBe('a\nb\n')
    expect(firstLines('a\nb\n', 2)).toBeUndefined()
    expect(firstLines('a\nb', 2)).toBeUndefined()
    expect(firstLines('', 2)).toBeUndefined()
  })
})

describe('CodeBlock', () => {
  it('shows the text plain with line numbers until the tokens come', async () => {
    let done!: (t: unknown) => void
    mockHighlight.mockReturnValue(new Promise((r) => (done = r)))
    show('const a\n\nb\n')
    expect(lines()).toEqual(['const a', ' ', 'b'])
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
