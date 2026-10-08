import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampWidth,
  FIT_MAX_WIDTH,
  fitWidth,
  fitWidths,
  gridScale,
  initialWidths,
  longestLine,
  MAX_SCROLL_HEIGHT,
  MAX_WIDTH,
  MIN_WIDTH,
  pageRows,
  type ReadCell,
  rowHeightFor,
  scrollTopFor,
  WRAP_ROW_HEIGHT,
  wrapLines,
} from './table-columns'

// Cells as shown: multiline keeps line breaks, one line shows them as ↵
const reader =
  (cells: string[][]): ReadCell =>
  (r, c, multiline) => {
    const v = cells[r]?.[c] ?? ''
    return multiline ? v : v.replace(/\n/g, '↵')
  }
const all = (n: number) => Int32Array.from({ length: n }, (_, i) => i)

afterEach(() => vi.restoreAllMocks())

describe('clampWidth', () => {
  it('keeps a width between the floor and the ceiling', () => {
    expect(clampWidth(1)).toBe(MIN_WIDTH)
    expect(clampWidth(50.5)).toBe(50.5)
    expect(clampWidth(500)).toBe(FIT_MAX_WIDTH)
  })
})

describe('longestLine and wrapLines', () => {
  it('measures the longest line', () => {
    expect(longestLine('')).toBe(0)
    expect(longestLine('abc')).toBe(3)
    expect(longestLine('a\nabcd\nab')).toBe(4)
    expect(longestLine('ab\n')).toBe(2)
  })

  it('keeps ↵ at the end of each wrapped line', () => {
    expect(wrapLines('\n\nX')).toBe('↵\n↵\nX')
    expect(wrapLines('a')).toBe('a')
  })
})

describe('fitWidth', () => {
  const far = Number.POSITIVE_INFINITY

  it('fits the name when the values are shorter', () => {
    const read = reader([['a'], ['bb']])
    expect(fitWidth(read, all(2), 'description', 0, false, far)).toBe(11)
  })

  it('fits the longest value, never under the floor', () => {
    expect(
      fitWidth(reader([['a'], ['abcdefghij']]), all(2), 'n', 0, false, far),
    ).toBe(10)
    expect(fitWidth(reader([['a']]), all(1), 'n', 0, false, far)).toBe(
      MIN_WIDTH,
    )
  })

  it('stops at the ceiling on a huge cell', () => {
    const read = reader([['x'.repeat(1024)]])
    expect(fitWidth(read, all(1), 'n', 0, false, far)).toBe(FIT_MAX_WIDTH)
  })

  it('a wrapped column fits its longest line, any other its one line', () => {
    const read = reader([['abcdef\nabc\nab']])
    // abcdef↵
    expect(fitWidth(read, all(1), 'n', 0, true, far)).toBe(7)
    // abcdef↵abc↵ab
    expect(fitWidth(read, all(1), 'n', 0, false, far)).toBe(13)
  })

  it('reads only the rows given', () => {
    const read = reader([['a'], ['abcdefghijkl'], ['abcde']])
    expect(fitWidth(read, Int32Array.of(0, 2), 'n', 0, false, far)).toBe(5)
  })

  it('keeps what it measured once past the deadline', () => {
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValue(100)
    const cells = Array.from({ length: 100 }, (_, i) => [
      i < 32 ? 'abcdef' : 'x'.repeat(50),
    ])
    expect(fitWidth(reader(cells), all(100), 'n', 0, false, 50)).toBe(6)
  })
})

describe('fitWidths', () => {
  const read = reader([['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)]])

  it('fits the columns asked, on top of the widths set', () => {
    const far = Number.POSITIVE_INFINITY
    const w = fitWidths(
      read,
      all(1),
      ['x', 'y', 'z'],
      [0, 2],
      new Set(),
      { 1: 9 },
      far,
    )
    expect(w).toEqual({ 0: 60, 1: 9, 2: 60 })
  })

  it('past the deadline, the columns left keep their width', () => {
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValueOnce(0).mockReturnValue(100)
    const w = fitWidths(
      read,
      all(1),
      ['x', 'y', 'z'],
      [0, 1, 2],
      new Set(),
      { 2: 7 },
      50,
    )
    expect(w).toEqual({ 0: 60, 2: 7 })
  })
})

describe('initialWidths', () => {
  it('fits names and the first rows, between the floor and 32', () => {
    const read = reader([
      ['id', 'note'],
      ['1', 'x'.repeat(100)],
    ])
    expect(initialWidths(read, 2, ['id', 'note'])).toEqual([
      MIN_WIDTH,
      MAX_WIDTH,
    ])
  })
})

describe('row heights and scrolling', () => {
  it('is one height for every row, taller while a column wraps', () => {
    expect(rowHeightFor(false, false)).toBe(32)
    expect(rowHeightFor(true, false)).toBe(44)
    expect(WRAP_ROW_HEIGHT).toBe(61)
    expect(rowHeightFor(false, true)).toBe(61)
    expect(rowHeightFor(true, true)).toBe(61)
  })

  it('scales only rows taller than the scroll height cap', () => {
    expect(gridScale(1000, 61, 600)).toBe(1)
    const count = Math.ceil(MAX_SCROLL_HEIGHT / 61) * 2
    const scale = gridScale(count, 61, 600)
    expect(scale).toBeCloseTo((count * 61 - 600) / (MAX_SCROLL_HEIGHT - 600))
  })

  it('puts a row on top at the same place under another height', () => {
    // Row 500 on top at 32px, then at 61px
    expect(scrollTopFor(500, 32, 1)).toBe(16_000)
    expect(scrollTopFor(500, 61, 1)).toBe(30_500)
    const count = Math.ceil(MAX_SCROLL_HEIGHT / 61) * 2
    const scale = gridScale(count, 61, 600)
    const top = scrollTopFor(count / 2, 61, scale)
    expect(Math.floor((top * scale) / 61)).toBe(count / 2)
  })

  it('pages at least one row', () => {
    expect(pageRows(600, 32)).toBe(18)
    expect(pageRows(90, 61)).toBe(1)
    expect(pageRows(30, 61)).toBe(1)
  })
})
