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
