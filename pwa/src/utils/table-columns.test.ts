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
  moveColumns,
  movedColumn,
  pageRows,
  pinnedColumn,
  type ReadCell,
  rowHeightFor,
  scrollTopFor,
  shownColumns,
  wrapLines,
  wrapRowHeight,
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
    expect(wrapRowHeight(3)).toBe(61)
    expect(rowHeightFor(false, true)).toBe(61)
    expect(rowHeightFor(true, true)).toBe(61)
  })

  it('a wrapped row is as tall as the lines chosen', () => {
    expect(wrapRowHeight(6)).toBe(109)
    expect(wrapRowHeight(10)).toBe(173)
    expect(rowHeightFor(false, true, 6)).toBe(109)
    expect(rowHeightFor(true, true, 10)).toBe(173)
    // Lines mean nothing while no column wraps
    expect(rowHeightFor(false, false, 10)).toBe(32)
  })

  it('scales the tallest wrapped rows past the scroll height cap', () => {
    const h = wrapRowHeight(10)
    const count = Math.ceil(MAX_SCROLL_HEIGHT / h) * 2
    const scale = gridScale(count, h, 600)
    expect(scale).toBeCloseTo((count * h - 600) / (MAX_SCROLL_HEIGHT - 600))
    const top = scrollTopFor(count / 2, h, scale)
    expect(Math.floor((top * scale) / h)).toBe(count / 2)
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

describe('shownColumns', () => {
  it('shows every column but the hidden ones, in order', () => {
    expect(shownColumns(4, [])).toEqual([0, 1, 2, 3])
    expect(shownColumns(4, [2, 0])).toEqual([1, 3])
    // A column past the count means nothing
    expect(shownColumns(3, [1, 7])).toEqual([0, 2])
  })

  it('never shows none: the first one when all are hidden', () => {
    expect(shownColumns(2, [0, 1])).toEqual([0])
    expect(shownColumns(0, [])).toEqual([])
  })
})

describe('moveColumns', () => {
  it('moves a column index past an added or removed column', () => {
    expect(movedColumn(1, 2, true)).toBe(1)
    expect(movedColumn(2, 2, true)).toBe(3)
    expect(movedColumn(1, 2, false)).toBe(1)
    expect(movedColumn(2, 2, false)).toBeUndefined()
    expect(movedColumn(3, 2, false)).toBe(2)
  })

  it('widths, wraps and hidden columns follow their columns', () => {
    const layout = {
      key: ',|1',
      widths: { 0: 10, 2: 20, 3: 30 },
      wrapped: [2, 3],
      hidden: [0, 2],
      pinned: true,
    }
    expect(moveColumns(layout, 2, true)).toEqual({
      ...layout,
      widths: { 0: 10, 3: 20, 4: 30 },
      wrapped: [3, 4],
      hidden: [0, 3],
    })
    expect(moveColumns(layout, 2, false)).toEqual({
      ...layout,
      widths: { 0: 10, 2: 30 },
      wrapped: [2],
      hidden: [0],
    })
    // A layout kept before hidden columns has none still
    expect(moveColumns({ key: 'k', widths: {}, wrapped: [] }, 0, true)).toEqual(
      {
        key: 'k',
        widths: {},
        wrapped: [],
      },
    )
  })

  it('a pinned column follows its column, and goes with it', () => {
    const layout = { key: 'k', widths: {}, wrapped: [], pinned: 3 }
    expect(moveColumns(layout, 2, true).pinned).toBe(4)
    expect(moveColumns(layout, 4, true).pinned).toBe(3)
    expect(moveColumns(layout, 2, false).pinned).toBe(2)
    expect(moveColumns(layout, 3, false)).not.toHaveProperty('pinned')
  })
})

describe('pinnedColumn', () => {
  it('is the column pinned while it is shown', () => {
    expect(pinnedColumn(undefined, [0, 1, 2])).toBeUndefined()
    expect(pinnedColumn(false, [0, 1, 2])).toBeUndefined()
    expect(pinnedColumn(2, [0, 1, 2])).toBe(2)
    expect(pinnedColumn(1, [0, 2])).toBeUndefined()
  })

  it('true, from a tab kept before any column could be pinned, is the first shown', () => {
    expect(pinnedColumn(true, [1, 2])).toBe(1)
  })
})
