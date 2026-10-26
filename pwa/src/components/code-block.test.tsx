import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import { CodeBlock, splitLines } from './code-block'

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
