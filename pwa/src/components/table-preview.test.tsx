import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import { makeOp, reapply, redoOp, type TableOp } from '../utils/csv-edits'
import { type CsvTable, type Delimiter, parseCsv } from '../utils/csv-parse'
import { CSV_WORKER_MIN } from '../utils/csv-parse-client'
import { MAX_SCROLL_HEIGHT } from '../utils/table-columns'
import { MAX_CELL_CHARS } from './table-grid'
import TablePreview, { MAX_COLUMNS, type TableEditing } from './table-preview'

const copyText = vi.hoisted(() => vi.fn(async (_: string) => 'ok' as const))
vi.mock('../utils/copy-text', () => ({ copyText }))

vi.mock('../utils/highlight', async (orig) => ({
  ...(await orig<typeof import('../utils/highlight')>()),
  highlight: async () => null,
}))
// A coarse pointer (value), or a fine one (fine): off, neither, as on a
// device with no pointer
const coarse = vi.hoisted(() => ({ value: false, fine: false }))
vi.mock('../hooks/use-media-query', () => ({
  useIsMobile: () => false,
  useMediaQuery: (query: string) =>
    query === '(pointer: fine)' ? coarse.fine : coarse.value,
}))

function show(text: string, over: Record<string, unknown> = {}) {
  const props = {
    text,
    path: 'data.csv',
    wrap: false,
    notify: vi.fn(),
    onTableState: vi.fn(),
    ...over,
  }
  const view = render(
    <ThemeProvider>
      <TablePreview {...props} />
    </ThemeProvider>,
  )
  return { ...props, ...view }
}

// Values of the rendered rows, as shown
function shownRows(): string[][] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .queryAllByRole('gridcell')
        .map((c) => c.textContent ?? ''),
    )
}

// The record shown (the grid stays under it, hidden)
const record = () => document.querySelector('dl') as HTMLElement

const people = 'name,age,city\nBình,30,Huế\nan,4,"Hà Nội, VN"\nCuong,100\n'

beforeEach(() => {
  coarse.value = false
  coarse.fine = false
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})
afterEach(() => vi.unstubAllGlobals())

describe('TablePreview', () => {
  it('shows a header, row numbers and cells, and says it parsed', () => {
    const p = show(people)
    const grid = screen.getByRole('grid')
    expect(grid).toHaveAttribute('aria-rowcount', '4')
    expect(grid).toHaveAttribute('aria-colcount', '4')
    expect(grid).toHaveAttribute('aria-busy', 'false')
    const headers = screen
      .getAllByRole('columnheader')
      .map((h) => h.textContent)
    expect(headers).toEqual(['', 'name', 'age', 'city'])
    expect(shownRows()).toEqual([
      ['Bình', '30', 'Huế'],
      ['an', '4', 'Hà Nội, VN'],
      ['Cuong', '100', ''],
    ])
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveAttribute('aria-rowindex', '2')
    expect(screen.getByText('3 / 3 rows')).toBeInTheDocument()
    expect(p.onTableState).toHaveBeenLastCalledWith({
      ok: true,
      delimiter: ',',
    })
  })

  it('flags a row with another number of cells than the header', () => {
    show(people)
    expect(
      screen.getByRole('rowheader', {
        name: 'Row 4: 2 cells, the header has 3',
      }),
    ).toHaveAttribute('title', 'Row 4: 2 cells, the header has 3')
    expect(
      screen.getByRole('rowheader', {
        name: 'Row 4: 2 cells, the header has 3',
      }),
    ).toHaveClass('text-warning')
    expect(
      screen.getByRole('rowheader', { name: 'Row 2' }),
    ).not.toHaveAttribute('title')
    expect(screen.getByRole('rowheader', { name: 'Row 2' })).not.toHaveClass(
      'text-warning',
    )
  })

  it('without a header row, names the columns and compares with the widest row', () => {
    show(people)
    fireEvent.click(screen.getByRole('button', { name: 'Header row' }))
    const headers = screen
      .getAllByRole('columnheader')
      .map((h) => h.textContent)
    expect(headers).toEqual(['', 'Column 1', 'Column 2', 'Column 3'])
    expect(shownRows()[0]).toEqual(['name', 'age', 'city'])
    expect(screen.getByText('4 / 4 rows')).toBeInTheDocument()
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '5')
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-rowindex', '2')
    expect(
      screen.getByRole('rowheader', {
        name: 'Row 4: 2 cells, the widest row has 3',
      }),
    ).toBeInTheDocument()
  })

  it('sorts up, down and back, never moving the header row', () => {
    show(people)
    const age = screen.getByRole('button', { name: 'age' })
    const header = () => age.closest('[role="columnheader"]')
    expect(header()).toHaveAttribute('aria-sort', 'none')
    fireEvent.click(age)
    expect(header()).toHaveAttribute('aria-sort', 'ascending')
    expect(shownRows().map((r) => r[1])).toEqual(['4', '30', '100'])
    fireEvent.click(age)
    expect(header()).toHaveAttribute('aria-sort', 'descending')
    expect(shownRows().map((r) => r[1])).toEqual(['100', '30', '4'])
    fireEvent.click(age)
    expect(header()).toHaveAttribute('aria-sort', 'none')
    expect(shownRows().map((r) => r[0])).toEqual(['Bình', 'an', 'Cuong'])
    // Row numbers stay those of the file
    fireEvent.click(screen.getByRole('button', { name: 'name' }))
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual([
      '3',
      '2',
      '4',
    ])
  })

  it('filters on any cell, any case, and keeps the header', async () => {
    show(people)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter rows' }), {
      target: { value: 'HÀ NỘI' },
    })
    await waitFor(() => expect(shownRows()).toHaveLength(1))
    expect(shownRows()[0][0]).toBe('an')
    expect(screen.getByText('1 / 3 rows')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'name' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'nothing' },
    })
    await waitFor(() => expect(shownRows()).toHaveLength(0))
  })

  it('reads again with another delimiter, and says so', () => {
    const p = show('a;b\n1;2\n')
    expect(screen.getAllByRole('columnheader')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    const select = screen.getByRole('combobox', { name: 'Delimiter' })
    expect(select).toHaveValue(';')
    fireEvent.change(select, { target: { value: ',' } })
    expect(screen.getAllByRole('columnheader')).toHaveLength(2)
    expect(p.onTableState).toHaveBeenLastCalledWith({
      ok: true,
      delimiter: ',',
    })
    // The sort is of the old columns: dropped
    expect(screen.getByRole('columnheader', { name: 'a;b' })).toHaveAttribute(
      'aria-sort',
      'none',
    )
  })

  it('takes tabs for a .tsv', () => {
    show('a\tb\n1\t2\n', { path: 'x.tsv' })
    expect(screen.getByRole('combobox', { name: 'Delimiter' })).toHaveValue(
      '\t',
    )
    expect(shownRows()).toEqual([['1', '2']])
  })

  it('shows the source and the line of an unclosed quote', () => {
    const p = show('a,b\n"x,y\n')
    expect(
      screen.getByText('Unclosed quote on line 2: shown as source'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('code-block')).toHaveTextContent('"x,y')
    expect(p.onTableState).toHaveBeenLastCalledWith({
      ok: false,
      delimiter: ',',
    })
  })

  it('says when there is no row', () => {
    show('\uFEFF')
    expect(screen.getByText('No rows')).toBeInTheDocument()
  })

  it('never shows a BOM in the first header', () => {
    show('\uFEFFid,v\n1,2\n')
    expect(screen.getByRole('button', { name: 'id' })).toBeInTheDocument()
  })

  it('opens a cell with its whole value, and copies it as it is', async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('no'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const p = show('k,v\nx,"two\nlines \u202e"\n')
    fireEvent.click(screen.getAllByRole('gridcell')[1])
    const dialog = screen.getByRole('dialog', { name: /Row 2 · v/ })
    expect(dialog.querySelector('pre')).toHaveTextContent('two lines ⟨U+202E⟩')
    const copy = within(dialog).getByRole('button', { name: 'Copy value' })
    await act(async () => fireEvent.click(copy))
    expect(writeText).toHaveBeenCalledWith('two\nlines \u202e')
    expect(p.notify).toHaveBeenLastCalledWith('Value copied')
    await act(async () => fireEvent.click(copy))
    expect(p.notify).toHaveBeenLastCalledWith('Could not copy the value')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows bidi, zero-width and control characters as marks', () => {
    show('v\n\u202e0001\na\u200bb\u0007\n')
    expect(shownRows()).toEqual([['⟨U+202E⟩0001'], ['a⟨U+200B⟩b⟨U+0007⟩']])
    const cell = screen.getAllByRole('gridcell')[0]
    expect(cell.querySelector('bdi')).not.toBeNull()
    expect(cell).toHaveAttribute('title', '⟨U+202E⟩0001')
  })

  it('cuts a huge cell in the grid and its tooltip, not in the sheet', () => {
    const big = 'x'.repeat(MAX_CELL_CHARS * 4)
    show(`v\n${big}\n`)
    const cell = screen.getByRole('gridcell')
    expect(cell.textContent).toHaveLength(MAX_CELL_CHARS + 1)
    expect(cell.getAttribute('title')).toHaveLength(MAX_CELL_CHARS + 1)
    fireEvent.click(cell)
    expect(screen.getByRole('dialog').querySelector('pre')?.textContent).toBe(
      big,
    )
  })

  it('renders only the rows in view of a long file', async () => {
    const text = `n\n${Array.from({ length: 50000 }, (_, i) => i).join('\n')}\n`
    show(text)
    const rendered = (await screen.findAllByRole('row')).length - 1
    expect(rendered).toBeGreaterThan(10)
    expect(rendered).toBeLessThan(60)
    // Spacers stand for the rest
    const grid = screen.getByRole('grid')
    const spacer = grid.firstElementChild?.lastElementChild as HTMLElement
    expect(Number.parseInt(spacer.style.height, 10)).toBeGreaterThan(1_000_000)
  })

  it('follows scrolling, on the next frame', () => {
    vi.useFakeTimers()
    try {
      const text = `n\n${Array.from({ length: 1000 }, (_, i) => i).join('\n')}\n`
      show(text)
      const grid = screen.getByRole('grid')
      grid.scrollTop = 32 * 500
      fireEvent.scroll(grid)
      fireEvent.scroll(grid)
      act(() => vi.advanceTimersByTime(50))
      const numbers = screen.getAllByRole('rowheader').map((h) => h.textContent)
      expect(numbers).toContain('520')
      expect(numbers).not.toContain('2')
      // The active cell (row 2) scrolled away: the grid keeps the Tab stop,
      // and a move key brings the focus back to that cell
      expect(grid).toHaveAttribute('tabindex', '0')
      grid.focus()
      fireEvent.keyDown(grid, { key: 'ArrowDown' })
      act(() => vi.advanceTimersByTime(50))
      expect(document.activeElement).toHaveAttribute('data-pos', '0')
      expect(grid).toHaveAttribute('tabindex', '-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps the scroll offset onto rows taller than the scroll height cap', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
    try {
      const count = Math.ceil(MAX_SCROLL_HEIGHT / 32) + 50_000
      show(`n\n${'x\n'.repeat(count)}`)
      const grid = await screen.findByRole('grid')
      const spacers = () => {
        const inner = grid.firstElementChild as HTMLElement
        const top = inner.children[1] as HTMLElement
        const bottom = inner.lastElementChild as HTMLElement
        const rendered = inner.children.length - 3
        return (
          Number.parseFloat(top.style.height) +
          rendered * 32 +
          Number.parseFloat(bottom.style.height)
        )
      }
      const numbers = () =>
        screen.getAllByRole('rowheader').map((h) => Number(h.textContent))
      expect(spacers()).toBe(MAX_SCROLL_HEIGHT)
      // The end of the scroll range shows the last row
      grid.scrollTop = MAX_SCROLL_HEIGHT - 600
      fireEvent.scroll(grid)
      act(() => vi.advanceTimersToNextFrame())
      expect(numbers()).toContain(count + 1)
      expect(spacers()).toBe(MAX_SCROLL_HEIGHT)
      // Halfway shows rows from halfway through
      grid.scrollTop = (MAX_SCROLL_HEIGHT - 600) / 2
      fireEvent.scroll(grid)
      act(() => vi.advanceTimersToNextFrame())
      const mid = numbers()
      expect(Math.abs(mid[0] - count / 2)).toBeLessThan(100)
      expect(spacers()).toBe(MAX_SCROLL_HEIGHT)
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders 200 columns of a row of a million cells, and says so', async () => {
    show(','.repeat(999_999))
    expect(await screen.findAllByRole('columnheader')).toHaveLength(
      MAX_COLUMNS + 1,
    )
    expect(screen.getByRole('grid')).toHaveAttribute('aria-colcount', '1000001')
    expect(
      screen.getByText('Showing 200 of 1000000 columns. See all in Source'),
    ).toBeInTheDocument()
  })

  it('reads the frame size again when it is resized', () => {
    const observed: Element[] = []
    let resized = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resized = cb
        }
        observe(el: Element) {
          observed.push(el)
        }
        disconnect = disconnect
      },
    )
    const p = show(people)
    expect(observed).toEqual([screen.getByRole('grid')])
    act(() => resized())
    p.unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('makes rows touch-sized on a coarse pointer', () => {
    coarse.value = true
    show(people)
    const grid = screen.getByRole('grid')
    grid.scrollTop = 44 * 2
    fireEvent.scroll(grid)
    expect(screen.getAllByRole('row')[1]).toHaveStyle({ height: '44px' })
  })

  it('moves the focus with the arrow keys, scrolling as it goes', () => {
    const text = `a,b\n${Array.from({ length: 100 }, (_, i) => `${i},x`).join('\n')}\n`
    show(text)
    const grid = screen.getByRole('grid')
    const first = screen.getAllByRole('gridcell')[0]
    expect(first).toHaveAttribute('tabindex', '0')
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toHaveTextContent('x')
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAttribute('data-pos', '1')
    expect(document.activeElement).toHaveAttribute('data-col', '0')
    fireEvent.keyDown(document.activeElement as Element, { key: 'PageDown' })
    expect(Number(document.activeElement?.getAttribute('data-pos'))).toBe(19)
    expect(grid.scrollTop).toBeGreaterThan(0)
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' })
    fireEvent.keyDown(document.activeElement as Element, { key: 'PageUp' })
    expect(document.activeElement).toHaveAttribute('data-pos', '0')
    expect(grid.scrollTop).toBe(0)
    // Other keys, and keys on no cell, do nothing
    fireEvent.keyDown(document.activeElement as Element, { key: 'a' })
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAttribute('data-pos', '0')
    // Nor on a column's sort button
    fireEvent.keyDown(screen.getByRole('button', { name: 'a' }), {
      key: 'ArrowDown',
    })
    expect(document.activeElement).toHaveAttribute('data-pos', '0')
    // A click on the grid outside a cell opens nothing
    fireEvent.click(grid)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Home and End go to the ends of the row; with Ctrl or Cmd, of the table shown', () => {
    const text = `a,b,c\n${Array.from({ length: 100 }, (_, i) => `${i},x,y`).join('\n')}\n`
    show(text)
    const grid = screen.getByRole('grid')
    const at = () => [
      document.activeElement?.getAttribute('data-pos'),
      document.activeElement?.getAttribute('data-col'),
    ]
    const key = (k: string, over: object = {}) =>
      fireEvent.keyDown(document.activeElement as Element, { key: k, ...over })
    screen.getAllByRole('gridcell')[0].focus()
    key('ArrowDown')
    key('End')
    expect(at()).toEqual(['1', '2'])
    key('Home')
    expect(at()).toEqual(['1', '0'])
    // From the row number, Home goes to the first column too
    key('ArrowLeft')
    key('Home')
    expect(at()).toEqual(['1', '0'])
    key('End', { ctrlKey: true })
    expect(at()).toEqual(['99', '2'])
    expect(grid.scrollTop).toBeGreaterThan(0)
    key('Home', { metaKey: true })
    expect(at()).toEqual(['0', '0'])
    expect(grid.scrollTop).toBe(0)
    key('End', { metaKey: true })
    expect(at()).toEqual(['99', '2'])
    // On the grid itself, back to the active cell
    act(() => grid.focus())
    fireEvent.keyDown(grid, { key: 'Home', ctrlKey: true })
    expect(at()).toEqual(['99', '2'])
  })

  it('a table only viewed takes no key typed, nor Delete', () => {
    show(people)
    const cell = screen.getByRole('gridcell', { name: '30' })
    cell.focus()
    expect(fireEvent.keyDown(cell, { key: 'a' })).toBe(true)
    expect(fireEvent.keyDown(cell, { key: ' ' })).toBe(true)
    expect(fireEvent.keyDown(cell, { key: 'Delete' })).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('shows one record at a time, with every field', () => {
    show(people)
    fireEvent.click(screen.getByRole('button', { name: 'Records' }))
    expect(screen.queryByRole('grid')).toBeNull()
    expect(screen.getByText('Record 1 / 3 · row 2')).toBeInTheDocument()
    expect(screen.getAllByRole('term').map((t) => t.textContent)).toEqual([
      'name',
      'age',
      'city',
    ])
    const prev = screen.getByRole('button', { name: 'Previous record' })
    const next = screen.getByRole('button', { name: 'Next record' })
    expect(prev).toBeDisabled()
    fireEvent.click(next)
    expect(within(record()).getByText('Hà Nội, VN')).toBeInTheDocument()
    fireEvent.click(next)
    expect(next).toBeDisabled()
    expect(screen.getByText('Record 3 / 3 · row 4')).toBeInTheDocument()
    fireEvent.click(prev)
    expect(screen.getByText('Record 2 / 3 · row 3')).toBeInTheDocument()
    fireEvent.click(within(record()).getByText('Hà Nội, VN'))
    expect(
      screen.getByRole('dialog', { name: /Row 3 · city/ }),
    ).toBeInTheDocument()
  })

  it('shows a record left past the end of a filter as the last one', async () => {
    show(people)
    fireEvent.click(screen.getByRole('button', { name: 'Records' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next record' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next record' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'b' } })
    expect(await screen.findByText('Record 1 / 1 · row 2')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zz' } })
    expect(await screen.findByText('No matching rows')).toBeInTheDocument()
  })
})

// Stands in for the worker: answers through the real handler
class FakeWorker {
  static all: FakeWorker[] = []
  static hold = false
  onmessage?: (e: MessageEvent) => void
  pending: unknown[] = []
  constructor() {
    FakeWorker.all.push(this)
  }
  async postMessage(req: unknown) {
    if (FakeWorker.hold) {
      this.pending.push(req)
      return
    }
    await this.answer(req)
  }
  async answer(req: unknown) {
    const { handleRequest } = await import('../utils/csv-parse-worker')
    const [data] = handleRequest(req as never)
    this.onmessage?.(new MessageEvent('message', { data }))
  }
  // Answers until nothing waits: the client sends the next request only
  // once the last one is answered
  async flush() {
    while (this.pending.length) await this.answer(this.pending.shift())
  }
  terminate() {}
}

describe('TablePreview of a large file', () => {
  const rows = Math.ceil(CSV_WORKER_MIN / 8) + 10
  const big = `id,name\n${Array.from({ length: rows }, (_, i) => `${rows - i},n${i}`).join('\n')}\n`

  beforeEach(() => {
    FakeWorker.all = []
    FakeWorker.hold = false
    vi.stubGlobal('Worker', FakeWorker)
  })

  it('parses, sorts and filters in the worker', async () => {
    FakeWorker.hold = true
    const p = show(big)
    expect(
      screen.getByText('Reading the table…').parentElement,
    ).toHaveAttribute('aria-busy', 'true')
    const w = FakeWorker.all[0]
    await act(() => w.flush())
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'false')
    expect(p.onTableState).toHaveBeenLastCalledWith({
      ok: true,
      delimiter: ',',
    })
    expect(screen.getByText(`${rows} / ${rows} rows`)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'id' }))
    // The worker has not answered: the last rows stay, busy
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'true')
    expect(shownRows()[0][0]).toBe(String(rows))
    await act(() => w.flush())
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'false')
    expect(shownRows()[0][0]).toBe('1')

    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'n12345' },
    })
    await act(() => w.flush())
    await waitFor(() => expect(screen.getByText(/^1 \/ /)).toBeInTheDocument())
  })

  it('drops the parse of a text replaced meanwhile', async () => {
    FakeWorker.hold = true
    const p = show(big)
    const next = big.replace('id,name', 'key,name')
    p.rerender(
      <ThemeProvider>
        <TablePreview {...p} text={next} />
      </ThemeProvider>,
    )
    await act(() => FakeWorker.all[0].flush())
    // Told nothing while parsing, then only the new text's parse
    expect(p.onTableState.mock.calls).toEqual([
      [undefined],
      [{ ok: true, delimiter: ',' }],
    ])
    expect(screen.getByRole('button', { name: 'key' })).toBeInTheDocument()
  })

  it('counts "…" until the first view of a new text arrives', async () => {
    FakeWorker.hold = true
    const p = show(big)
    const w = FakeWorker.all[0]
    await act(() => w.flush())
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'n1' } })
    await act(() => w.flush())
    p.rerender(
      <ThemeProvider>
        <TablePreview {...p} text={`${big}0,n1x\n`} />
      </ThemeProvider>,
    )
    // The parse answers; its view waits
    await act(() => w.flush())
    expect(screen.getByText(`… / ${rows + 1} rows`)).toBeInTheDocument()
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Records' }))
    expect(screen.getByText('Sorting and filtering…')).toBeInTheDocument()
    await act(() => w.flush())
    expect(screen.queryByText(/^… /)).toBeNull()
    expect(screen.getByText(/^Record 1 \//)).toBeInTheDocument()
  })

  it('sorts here when there is no worker', async () => {
    vi.stubGlobal('Worker', undefined)
    show(big)
    fireEvent.click(await screen.findByRole('button', { name: 'id' }))
    await waitFor(() => expect(shownRows()[0][0]).toBe('1'))
  })

  it('drops a sort the user moved past, and shows only the last', async () => {
    FakeWorker.hold = true
    show(big)
    const w = FakeWorker.all[0]
    await act(() => w.flush())
    fireEvent.click(screen.getByRole('button', { name: 'id' }))
    fireEvent.click(screen.getByRole('button', { name: 'id' }))
    // Two views asked, the first aborted: only the descending one shows
    await act(() => w.flush())
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'false')
    expect(shownRows()[0][0]).toBe(String(rows))
    expect(
      screen
        .getByRole('button', { name: 'id' })
        .closest('[role="columnheader"]'),
    ).toHaveAttribute('aria-sort', 'descending')
  })
})

// A draft held the way FileViewer holds it: every edit replaces the text
function Draft(props: {
  initial: string
  delimiter?: Delimiter
  saving?: boolean
  canSave?: boolean
  onChange: (text: string, ops: TableOp[], redo: TableOp[]) => void
  onSave: () => void
  notify: () => void
  // Text another view of the pane put in the draft
  elsewhere?: string
}) {
  const [d, setD] = useState({
    text: props.initial,
    ops: [] as TableOp[],
    redo: [] as TableOp[],
  })
  const [seen, setSeen] = useState(props.elsewhere)
  if (props.elsewhere !== seen) {
    setSeen(props.elsewhere)
    if (props.elsewhere !== undefined) setD({ ...d, text: props.elsewhere })
  }
  const editing: TableEditing = {
    delimiter: props.delimiter ?? ',',
    ops: d.ops,
    redo: d.redo,
    saving: props.saving ?? false,
    canSave: props.canSave ?? true,
    onChange: (text, ops, redo) => {
      props.onChange(text, ops, redo)
      setD({ text, ops, redo })
    },
    onSave: props.onSave,
  }
  return (
    <ThemeProvider>
      <TablePreview
        text={d.text}
        path="data.csv"
        wrap={false}
        notify={props.notify}
        editing={editing}
      />
    </ThemeProvider>
  )
}

function edit(
  initial: string,
  over: { delimiter?: Delimiter; saving?: boolean; canSave?: boolean } = {},
) {
  const props = {
    initial,
    onChange: vi.fn(),
    onSave: vi.fn(),
    notify: vi.fn(),
    ...over,
  }
  const view = render(<Draft {...props} />)
  // The text of the last edit
  const text = () => props.onChange.mock.lastCall?.[0]
  return { ...props, ...view, text }
}

const cellButton = (name: string) => screen.getByRole('gridcell', { name })
const valueBox = () => screen.getByRole('textbox', { name: 'Value' })
const press = (target: Element, key: string, over: object = {}) =>
  fireEvent.keyDown(target, { key, ctrlKey: true, ...over })

describe('TablePreview editing', () => {
  it('sets a cell: only its characters change, undo and redo walk back and forth', () => {
    const p = edit(people)
    fireEvent.click(cellButton('30'))
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 2 · age')
    expect(valueBox()).toHaveValue('30')
    fireEvent.change(valueBox(), { target: { value: '31, or so' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.text()).toBe(people.replace('30', '"31, or so"'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(cellButton('31, or so')).toBeInTheDocument()

    const undo = screen.getByRole('button', { name: 'Undo' })
    const redo = screen.getByRole('button', { name: 'Redo' })
    expect(redo).toBeDisabled()
    fireEvent.click(undo)
    expect(p.text()).toBe(people)
    expect(p.onChange.mock.lastCall?.[1]).toEqual([])
    expect(undo).toBeDisabled()
    // The sheet opened on the text undo returned to stays closed
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(redo)
    expect(p.text()).toBe(people.replace('30', '"31, or so"'))
    // A new edit clears what could be redone
    fireEvent.click(undo)
    fireEvent.click(cellButton('Huế'))
    fireEvent.change(valueBox(), { target: { value: 'Hue' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.onChange.mock.lastCall?.[2]).toEqual([])
    expect(redo).toBeDisabled()
  })

  it('a value set to itself, or Cancel, changes nothing', () => {
    const p = edit(people)
    fireEvent.click(cellButton('Bình'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.click(cellButton('Bình'))
    fireEvent.change(valueBox(), { target: { value: 'zz' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(p.onChange).not.toHaveBeenCalled()
    // A cell a short row lacks, set to nothing, is no edit either
    fireEvent.click(screen.getAllByRole('gridcell')[8])
    fireEvent.change(valueBox(), { target: { value: 'x' } })
    fireEvent.change(valueBox(), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('a cell a short row lacks is set after the delimiters it needs', () => {
    const p = edit(people)
    fireEvent.click(screen.getAllByRole('gridcell')[8])
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 4 · city')
    fireEvent.change(valueBox(), { target: { value: 'Vinh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.text()).toBe(people.replace('Cuong,100', 'Cuong,100,Vinh'))
  })

  it('adds a row below a cell, or at the end, and opens its first cell', () => {
    const p = edit('a,b\n1,2\n3,4\n')
    fireEvent.click(cellButton('1'))
    fireEvent.click(screen.getByRole('button', { name: 'Add row below' }))
    expect(p.text()).toBe('a,b\n1,2\n,\n3,4\n')
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 3 · a')
    fireEvent.change(valueBox(), { target: { value: 'new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.text()).toBe('a,b\n1,2\nnew,\n3,4\n')
    fireEvent.click(
      screen.getByRole('button', { name: 'Add a row at the end' }),
    )
    expect(p.text()).toBe('a,b\n1,2\nnew,\n3,4\n,\n')
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 5 · a')
  })

  it('deletes a row once confirmed, and says when it is the header', () => {
    const p = edit('a,b\n1,2\n')
    fireEvent.click(cellButton('1'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete row' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Delete row 2?')
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'The row is removed from the file when you save it.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(p.onChange).not.toHaveBeenCalled()
    fireEvent.click(cellButton('1'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete row' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Delete row',
      }),
    )
    expect(p.text()).toBe('a,b\n')

    // The first row: the header unless Header row is off
    fireEvent.click(screen.getByRole('button', { name: 'Header row' }))
    fireEvent.click(cellButton('a'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete row' }))
    expect(screen.getByRole('dialog')).toHaveTextContent(
      "This is the file's first row, its header when Header row is on",
    )
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Delete row',
      }),
    )
    expect(p.text()).toBe('')
  })

  it('a delete asked before another view changed the text is dropped', () => {
    const p = edit('a\n1\n2\n')
    fireEvent.click(cellButton('2'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete row' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Delete row 3?')
    // A row added above moves row 3 onto another value
    p.rerender(<Draft {...p} elsewhere={'a\n0\n1\n2\n'} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('edits a cell from Records', () => {
    const p = edit('a,b\n1,2\n')
    fireEvent.click(screen.getByRole('button', { name: 'Records' }))
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    fireEvent.change(valueBox(), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.text()).toBe('a,b\n1,3\n')
  })

  it('an empty file offers a first row', () => {
    const p = edit('')
    fireEvent.click(screen.getByRole('button', { name: 'Add a row' }))
    expect(p.text()).toBe('""')
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 1 · Column 1')
  })

  it('keys: undo, redo and save on the table, never inside a field or a sheet', () => {
    const p = edit('a\n1\n')
    const grid = screen.getByRole('grid')
    fireEvent.click(cellButton('1'))
    fireEvent.change(valueBox(), { target: { value: '2' } })
    // Typed in the sheet: its own undo and save, not the table's
    press(valueBox(), 'z')
    press(valueBox(), 's')
    expect(p.onChange).not.toHaveBeenCalled()
    expect(p.onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.text()).toBe('a\n2\n')
    press(screen.getByRole('searchbox'), 'z')
    expect(p.text()).toBe('a\n2\n')
    press(grid, 'z', { ctrlKey: false })
    press(grid, 'a')
    expect(p.text()).toBe('a\n2\n')
    press(grid, 'Z', { ctrlKey: false, metaKey: true })
    expect(p.text()).toBe('a\n1\n')
    press(grid, 'z', { shiftKey: true })
    expect(p.text()).toBe('a\n2\n')
    press(grid, 's')
    expect(p.onSave).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+S does nothing when there is nothing to save, or a save runs', () => {
    const one = edit('a\n1\n', { canSave: false })
    press(screen.getByRole('grid'), 's')
    expect(one.onSave).not.toHaveBeenCalled()
    one.unmount()
    const two = edit('a\n1\n', { saving: true })
    press(screen.getByRole('grid'), 's')
    expect(two.onSave).not.toHaveBeenCalled()
  })

  it('while saving, nothing opens and nothing changes', () => {
    const p = edit('a\n1\n', { saving: true })
    fireEvent.click(cellButton('1'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Add a row at the end' }),
    ).toBeDisabled()
    press(screen.getByRole('grid'), 'z')
    press(screen.getByRole('grid'), 'z', { shiftKey: true })
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('a save that starts with a sheet open takes nothing from it', () => {
    const p = edit('a\n1\n')
    fireEvent.click(cellButton('1'))
    fireEvent.change(valueBox(), { target: { value: '2' } })
    p.rerender(<Draft {...p} saving />)
    fireEvent.click(screen.getByRole('button', { name: 'Add row below' }))
    expect(valueBox()).toHaveValue('2')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('an empty file being saved offers no row', () => {
    edit('', { saving: true })
    expect(screen.getByRole('button', { name: 'Add a row' })).toBeDisabled()
  })

  it('writes with the delimiter given, which cannot change meanwhile', () => {
    const p = edit('a;b\n1;2\n', { delimiter: ';' })
    const select = screen.getByRole('combobox', { name: 'Delimiter' })
    expect(select).toHaveValue(';')
    expect(select).toBeDisabled()
    fireEvent.click(cellButton('2'))
    fireEvent.change(valueBox(), { target: { value: 'x;y' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.text()).toBe('a;b\n1;"x;y"\n')
  })

  it('keys do nothing to a table only viewed', () => {
    const p = show(people)
    press(screen.getByRole('grid'), 'z')
    press(screen.getByRole('grid'), 's')
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(p.onTableState).toHaveBeenCalledTimes(1)
  })

  it('a sheet open on a text another one replaced is closed', () => {
    const p = show(people)
    fireEvent.click(cellButton('30'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    p.rerender(
      <ThemeProvider>
        <TablePreview {...p} text={people.replace('30', '31')} />
      </ThemeProvider>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('TablePreview editing in a cell (a fine pointer)', () => {
  const field = (name: string) => screen.getByRole('textbox', { name })
  const noField = () =>
    expect(screen.queryByRole('textbox', { name: /^Edit / })).toBeNull()
  const key = (target: Element, k: string, over: object = {}) =>
    fireEvent.keyDown(target, { key: k, ...over })

  beforeEach(() => {
    coarse.fine = true
  })

  it('a double click edits the cell where it is: Enter sets it, its cell takes the focus back, Ctrl+Z undoes', () => {
    const p = edit(people)
    fireEvent.doubleClick(cellButton('30'))
    expect(screen.queryByRole('dialog')).toBeNull()
    const box = field('Edit age, row 2')
    expect(box).toHaveValue('30')
    expect(box).toHaveFocus()
    expect(box.closest('[role="gridcell"]')).not.toBeNull()
    fireEvent.change(box, { target: { value: '31, or so' } })
    key(box, 'Enter')
    expect(p.text()).toBe(people.replace('30', '"31, or so"'))
    noField()
    expect(cellButton('31, or so')).toHaveFocus()
    press(cellButton('31, or so'), 'z')
    expect(p.text()).toBe(people)
  })

  it('Escape drops what was typed and stays in editing; a value unchanged sets nothing', () => {
    const p = edit(people)
    fireEvent.doubleClick(cellButton('30'))
    fireEvent.change(field('Edit age, row 2'), { target: { value: 'x' } })
    key(field('Edit age, row 2'), 'Escape')
    noField()
    expect(cellButton('30')).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    fireEvent.doubleClick(cellButton('30'))
    key(field('Edit age, row 2'), 'Enter')
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('Tab sets the value and goes along the row, then on to the next; Shift+Tab goes back', () => {
    const p = edit('a,b\n1,2\n3,4\n')
    fireEvent.doubleClick(cellButton('1'))
    // Only the last column's field grows leftward
    const cell = (box: HTMLElement) => box.closest('[role="gridcell"]')
    expect(cell(field('Edit a, row 2'))).not.toHaveAttribute('data-last')
    fireEvent.change(field('Edit a, row 2'), { target: { value: 'x' } })
    key(field('Edit a, row 2'), 'Tab')
    expect(p.text()).toBe('a,b\nx,2\n3,4\n')
    expect(field('Edit b, row 2')).toHaveValue('2')
    expect(cell(field('Edit b, row 2'))).toHaveAttribute('data-last', 'true')
    expect(field('Edit b, row 2')).toHaveFocus()
    key(field('Edit b, row 2'), 'Tab')
    expect(field('Edit a, row 3')).toHaveValue('3')
    key(field('Edit a, row 3'), 'Tab', { shiftKey: true })
    expect(field('Edit b, row 2')).toHaveFocus()
    key(field('Edit b, row 2'), 'Tab', { shiftKey: true })
    key(field('Edit a, row 2'), 'Tab', { shiftKey: true })
    // Before the first cell: set, and no further
    noField()
    expect(cellButton('x')).toHaveFocus()
    fireEvent.doubleClick(cellButton('4'))
    fireEvent.change(field('Edit b, row 3'), { target: { value: 'y' } })
    key(field('Edit b, row 3'), 'Tab')
    expect(p.text()).toBe('a,b\nx,2\n3,y\n')
    noField()
    expect(cellButton('y')).toHaveFocus()
  })

  it('Tab follows the rows in the order shown', () => {
    edit('a,b\n1,2\n3,4\n')
    const a = screen.getByRole('button', { name: 'a' })
    fireEvent.click(a)
    fireEvent.click(a)
    fireEvent.doubleClick(cellButton('4'))
    key(field('Edit b, row 3'), 'Tab')
    expect(field('Edit a, row 2')).toHaveValue('1')
  })

  it('Tab onto a value the field cannot take sets the value and stops', () => {
    const p = edit('a,b\n1,"x\r\ny"\n')
    fireEvent.doubleClick(cellButton('1'))
    fireEvent.change(field('Edit a, row 2'), { target: { value: '0' } })
    key(field('Edit a, row 2'), 'Tab')
    expect(p.text()).toBe('a,b\n0,"x\r\ny"\n')
    noField()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(cellButton('0')).toHaveFocus()
  })

  it('a value the field would cut, hide or change opens in the sheet', () => {
    const long = 'h'.repeat(MAX_CELL_CHARS + 1)
    edit(`a,b,c\n${long},"x‮y","1\r\n2"\n`)
    const cells = screen.getAllByRole('gridcell')
    for (const [i, value] of [long, 'x‮y', '1\r\n2'].entries()) {
      fireEvent.click(cells[i])
      noField()
      expect(valueBox()).toHaveValue(value.replace('\r\n', '\n'))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    }
  })

  it('⤢ goes on in the sheet with the value typed, and its row actions', () => {
    const p = edit('a,b\n1,2\n')
    fireEvent.doubleClick(cellButton('1'))
    fireEvent.change(field('Edit a, row 2'), { target: { value: 'typed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open in sheet' }))
    noField()
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 2 · a')
    expect(valueBox()).toHaveValue('typed')
    expect(screen.getByRole('button', { name: 'Delete row' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.text()).toBe('a,b\ntyped,2\n')
    fireEvent.doubleClick(cellButton('typed'))
    fireEvent.click(screen.getByRole('button', { name: 'Open in sheet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add row below' }))
    expect(p.text()).toBe('a,b\ntyped,2\n,\n')
  })

  it('F2 edits the cell in focus, never a row number; keys in the field stay there', () => {
    edit(people)
    const grid = screen.getByRole('grid')
    cellButton('Bình').focus()
    key(cellButton('Bình'), 'F2')
    const box = field('Edit name, row 2')
    key(box, 'ArrowDown')
    key(box, 'PageDown')
    key(box, 'Escape')
    // The grid did not move: back on the cell it was on
    expect(cellButton('Bình')).toHaveFocus()
    key(cellButton('Bình'), 'ArrowLeft')
    expect(document.activeElement).toHaveAttribute('data-col', '-1')
    key(document.activeElement as Element, 'F2')
    noField()
    // Nor on the grid itself
    key(grid, 'F2')
    noField()
  })

  it('a key typed on a cell edits it from that key: Enter sets it, Escape keeps the value', () => {
    const p = edit(people)
    cellButton('30').focus()
    expect(key(cellButton('30'), 'a')).toBe(false)
    const box = field('Edit age, row 2') as HTMLTextAreaElement
    expect(box).toHaveValue('a')
    expect(box).toHaveFocus()
    expect([box.selectionStart, box.selectionEnd]).toEqual([1, 1])
    key(box, 'Enter')
    expect(p.text()).toBe(people.replace('30', 'a'))
    expect(cellButton('a')).toHaveFocus()
    // Shift types a capital; Escape leaves the value as it was
    key(cellButton('a'), 'B', { shiftKey: true })
    expect(field('Edit age, row 2')).toHaveValue('B')
    key(field('Edit age, row 2'), 'Escape')
    expect(cellButton('a')).toHaveFocus()
    expect(p.onChange).toHaveBeenCalledTimes(1)
  })

  it('keys with Ctrl, Cmd or Alt, and keys on a row number, type nothing', () => {
    edit(people)
    cellButton('30').focus()
    key(cellButton('30'), 'c', { ctrlKey: true })
    key(cellButton('30'), 'c', { metaKey: true })
    key(cellButton('30'), 'c', { altKey: true })
    // AltGr types its character
    key(cellButton('30'), '@', {
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    })
    expect(field('Edit age, row 2')).toHaveValue('@')
    key(field('Edit age, row 2'), 'Escape')
    key(cellButton('30'), 'Delete', { ctrlKey: true })
    noField()
    key(cellButton('30'), 'Home')
    key(document.activeElement as Element, 'ArrowLeft')
    expect(document.activeElement).toHaveAttribute('data-col', '-1')
    key(document.activeElement as Element, 'x')
    key(document.activeElement as Element, 'Delete')
    noField()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
  })

  it('the first key of an IME opens the field empty and goes on to it', () => {
    edit(people)
    for (const over of [
      { key: 'Process' },
      { key: 'a', isComposing: true },
      { key: 'Unidentified', keyCode: 229 },
    ]) {
      cellButton('30').focus()
      expect(fireEvent.keyDown(cellButton('30'), over)).toBe(true)
      expect(field('Edit age, row 2')).toHaveValue('')
      key(field('Edit age, row 2'), 'Escape')
    }
  })

  it('Delete and Backspace clear a cell, one undo each; an empty cell makes no edit', () => {
    const p = edit(people)
    cellButton('30').focus()
    expect(key(cellButton('30'), 'Delete')).toBe(false)
    expect(p.text()).toBe(people.replace('30', ''))
    expect(p.onChange).toHaveBeenCalledTimes(1)
    key(document.activeElement as Element, 'Backspace')
    expect(p.onChange).toHaveBeenCalledTimes(1)
    press(document.activeElement as Element, 'z')
    expect(p.text()).toBe(people)
    key(cellButton('Huế'), 'Backspace')
    expect(p.text()).toBe(people.replace('Huế', ''))
    noField()
  })

  it('a key typed on a value the field cannot take opens the sheet with it; Delete clears it', () => {
    const p = edit('a,b\n"1\r\n2",x\n')
    const cell = screen.getAllByRole('gridcell')[0]
    cell.focus()
    key(cell, 'z')
    noField()
    expect(valueBox()).toHaveValue('z')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.text()).toBe('a,b\n"z",x\n')
    press(screen.getByRole('grid'), 'z')
    key(screen.getAllByRole('gridcell')[0], 'Delete')
    expect(p.text()).toBe('a,b\n"",x\n')
  })

  it('while saving, a key typed or Delete changes nothing', () => {
    const p = edit(people, { saving: true })
    cellButton('30').focus()
    expect(key(cellButton('30'), 'a')).toBe(true)
    expect(key(cellButton('30'), 'Delete')).toBe(true)
    noField()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('leaving the field sets it, and leaves the focus where it went', () => {
    const p = edit(people)
    fireEvent.doubleClick(cellButton('30'))
    fireEvent.change(field('Edit age, row 2'), { target: { value: '33' } })
    act(() => screen.getByRole('searchbox').focus())
    expect(p.text()).toBe(people.replace('30', '33'))
    noField()
    expect(screen.getByRole('searchbox')).toHaveFocus()
  })

  it('a field left with the focus on nothing yet takes it nowhere', () => {
    // A browser blurs the field before it focuses what was clicked:
    // meanwhile the page has the focus, and the cell must not take it
    const p = edit(people)
    fireEvent.doubleClick(cellButton('30'))
    fireEvent.change(field('Edit age, row 2'), { target: { value: '34' } })
    act(() => field('Edit age, row 2').blur())
    expect(p.text()).toBe(people.replace('30', '34'))
    noField()
    expect(document.body).toHaveFocus()
  })

  it('a field whose row goes out of the grid sets its value', async () => {
    const p = edit(people)
    fireEvent.doubleClick(cellButton('Huế'))
    fireEvent.change(field('Edit city, row 2'), { target: { value: 'Hue' } })
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'Cuong' },
    })
    await waitFor(() => expect(p.text()).toBe(people.replace('Huế', 'Hue')))
    noField()
  })

  it('Ctrl+S in the field sets the value, then saves the file if it can', () => {
    const p = edit('a\n1\n')
    fireEvent.doubleClick(cellButton('1'))
    fireEvent.change(field('Edit a, row 2'), { target: { value: '2' } })
    key(field('Edit a, row 2'), 's', { ctrlKey: true })
    expect(p.text()).toBe('a\n2\n')
    expect(p.onSave).toHaveBeenCalledTimes(1)
    p.unmount()
    const q = edit('a\n1\n', { canSave: false })
    fireEvent.doubleClick(cellButton('1'))
    key(field('Edit a, row 2'), 's', { ctrlKey: true })
    expect(q.onSave).not.toHaveBeenCalled()
  })

  it('another view changing the text closes the field, setting nothing', () => {
    const p = edit('a\n1\n2\n')
    fireEvent.doubleClick(cellButton('2'))
    fireEvent.change(field('Edit a, row 3'), { target: { value: 'z' } })
    p.rerender(<Draft {...p} elsewhere={'a\n0\n1\n2\n'} />)
    noField()
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('while saving, a click opens nothing, and a field open as it starts sets nothing', () => {
    const one = edit('a\n1\n', { saving: true })
    fireEvent.doubleClick(cellButton('1'))
    noField()
    expect(screen.queryByRole('dialog')).toBeNull()
    one.unmount()
    const p = edit('a\n1\n')
    fireEvent.doubleClick(cellButton('1'))
    fireEvent.change(field('Edit a, row 2'), { target: { value: '2' } })
    p.rerender(<Draft {...p} saving />)
    key(field('Edit a, row 2'), 'Tab')
    noField()
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('Records open a cell in the sheet, the grid being under them', () => {
    edit('a,b\n1,2\n')
    fireEvent.click(screen.getByRole('button', { name: 'Records' }))
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    expect(valueBox()).toHaveValue('2')
    noField()
  })

  it('a table only viewed opens a cell in the sheet that shows it', () => {
    show(people)
    fireEvent.doubleClick(cellButton('30'))
    noField()
    expect(screen.getByRole('dialog')).toHaveTextContent('30')
  })
})

// A table viewed until a click asks for editing: given at once (start),
// with saving set to hold the cell back
function Viewer(props: {
  initial: string
  start: boolean
  saving?: boolean
  onRequest: () => void
  // Editing given up (Cancel editing), set from outside
  stop?: boolean
}) {
  const [on, setOn] = useState(false)
  const editing: TableEditing | undefined =
    on && !props.stop
      ? {
          delimiter: ',',
          ops: [],
          redo: [],
          saving: props.saving ?? false,
          canSave: false,
          onChange: () => {},
          onSave: () => {},
        }
      : undefined
  return (
    <ThemeProvider>
      <TablePreview
        text={props.initial}
        path="data.csv"
        wrap={false}
        notify={() => {}}
        editing={editing}
        onRequestEdit={() => {
          props.onRequest()
          if (props.start) setOn(true)
          return props.start
        }}
      />
    </ThemeProvider>
  )
}

describe('TablePreview: a double click on a table viewed starts editing', () => {
  beforeEach(() => {
    coarse.fine = true
  })

  it('opens the cell double-clicked in its field once editing starts', () => {
    const onRequest = vi.fn()
    render(<Viewer initial={people} start onRequest={onRequest} />)
    fireEvent.doubleClick(cellButton('30'))
    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('textbox', { name: 'Edit age, row 2' }),
    ).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a key typed on a cell asks for editing, then opens its field from that key', () => {
    const onRequest = vi.fn()
    render(<Viewer initial={people} start onRequest={onRequest} />)
    cellButton('30').focus()
    fireEvent.keyDown(cellButton('30'), { key: '7' })
    expect(onRequest).toHaveBeenCalledTimes(1)
    const box = screen.getByRole('textbox', { name: 'Edit age, row 2' })
    expect(box).toHaveValue('7')
    expect(box).toHaveFocus()
    fireEvent.keyDown(box, { key: 'Escape' })
  })

  it('keys typed before the cell can open go to it; Delete asks for nothing', () => {
    const onRequest = vi.fn()
    const v = render(
      <Viewer initial={people} start saving onRequest={onRequest} />,
    )
    cellButton('30').focus()
    fireEvent.keyDown(cellButton('30'), { key: 'Delete' })
    expect(onRequest).not.toHaveBeenCalled()
    fireEvent.keyDown(cellButton('30'), { key: '4' })
    fireEvent.keyDown(cellButton('30'), { key: '2' })
    expect(onRequest).toHaveBeenCalledTimes(1)
    v.rerender(<Viewer initial={people} start onRequest={onRequest} />)
    expect(
      screen.getByRole('textbox', { name: 'Edit age, row 2' }),
    ).toHaveValue('42')
    v.unmount()
    // A cell clicked, then a key typed before it opens
    const w = render(
      <Viewer initial={people} start saving onRequest={() => {}} />,
    )
    fireEvent.doubleClick(cellButton('30'))
    fireEvent.keyDown(cellButton('30'), { key: 'x' })
    w.rerender(<Viewer initial={people} start onRequest={() => {}} />)
    expect(
      screen.getByRole('textbox', { name: 'Edit age, row 2' }),
    ).toHaveValue('x')
  })

  it('a value the field cannot take opens in the sheet that sets it', () => {
    render(<Viewer initial={'a\n"1\r\n2"\n'} start onRequest={() => {}} />)
    fireEvent.click(screen.getAllByRole('gridcell')[0])
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
  })

  it('nothing opens while editing was not started (a delimiter to confirm)', () => {
    render(<Viewer initial={people} start={false} onRequest={() => {}} />)
    fireEvent.doubleClick(cellButton('30'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('textbox', { name: /^Edit / })).toBeNull()
  })

  it('editing given up before the cell could open drops it', () => {
    const v = render(
      <Viewer initial={people} start saving onRequest={() => {}} />,
    )
    fireEvent.doubleClick(cellButton('30'))
    expect(screen.queryByRole('textbox', { name: /^Edit / })).toBeNull()
    v.rerender(
      <Viewer initial={people} start saving stop onRequest={() => {}} />,
    )
    v.rerender(<Viewer initial={people} start onRequest={() => {}} />)
    expect(screen.queryByRole('textbox', { name: /^Edit / })).toBeNull()
  })

  it('a coarse pointer types in no cell', () => {
    coarse.fine = false
    coarse.value = true
    const onRequest = vi.fn()
    render(<Viewer initial={people} start onRequest={onRequest} />)
    cellButton('30').focus()
    expect(fireEvent.keyDown(cellButton('30'), { key: 'a' })).toBe(true)
    expect(fireEvent.keyDown(cellButton('30'), { key: 'Delete' })).toBe(true)
    expect(onRequest).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a coarse pointer views the cell in its sheet, asking nothing', () => {
    coarse.fine = false
    const onRequest = vi.fn()
    render(<Viewer initial={people} start onRequest={onRequest} />)
    fireEvent.click(cellButton('30'), { detail: 1 })
    expect(onRequest).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent('30')
  })
})

describe('TablePreview editing a large file in a cell', () => {
  const rows = Math.ceil(CSV_WORKER_MIN / 8) + 10
  const big = `id,name\n${Array.from({ length: rows }, (_, i) => `${i},n${i}`).join('\n')}\n`

  beforeEach(() => {
    coarse.fine = true
    FakeWorker.all = []
    FakeWorker.hold = false
    vi.stubGlobal('Worker', FakeWorker)
  })

  it('Tab reaches the next field once the new text is on screen', async () => {
    FakeWorker.hold = true
    const p = edit(big)
    const w = FakeWorker.all[0]
    await act(() => w.flush())
    fireEvent.doubleClick(cellButton('n0'))
    const box = screen.getByRole('textbox', { name: 'Edit name, row 2' })
    fireEvent.change(box, { target: { value: 'first' } })
    fireEvent.keyDown(box, { key: 'Tab' })
    expect(p.onChange).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox', { name: /^Edit / })).toBeNull()
    await act(() => w.flush())
    expect(screen.getByRole('textbox', { name: 'Edit id, row 3' })).toHaveValue(
      '1',
    )
  }, 15000)

  it('a sort worked out in the worker takes the field away, its value set', async () => {
    FakeWorker.hold = true
    const p = edit(big)
    const w = FakeWorker.all[0]
    await act(() => w.flush())
    fireEvent.doubleClick(cellButton('n1'))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Edit name, row 3' }),
      { target: { value: 'x' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'id' }))
    expect(p.text()).toBe(big.replace('1,n1\n', '1,x\n'))
    await act(() => w.flush())
  }, 15000)
})

describe('TablePreview editing a large file', () => {
  const rows = Math.ceil(CSV_WORKER_MIN / 8) + 10
  const big = `id,name\n${Array.from({ length: rows }, (_, i) => `${i},n${i}`).join('\n')}\n`

  beforeEach(() => {
    FakeWorker.all = []
    FakeWorker.hold = false
    vi.stubGlobal('Worker', FakeWorker)
  })

  it('keeps the last table on screen, locked, while an edit parses', async () => {
    FakeWorker.hold = true
    const p = edit(big)
    expect(screen.getByText('Reading the table…')).toBeInTheDocument()
    const w = FakeWorker.all[0]
    await act(() => w.flush())
    fireEvent.click(cellButton('n0'))
    fireEvent.change(valueBox(), { target: { value: 'first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    // The new text parses in the worker: the old table stays, busy
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'true')
    expect(cellButton('n0')).toBeInTheDocument()
    fireEvent.click(cellButton('n1'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    press(screen.getByRole('grid'), 'z')
    expect(p.onChange).toHaveBeenCalledTimes(1)
    await act(() => w.flush())
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'false')
    expect(cellButton('first')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(p.text()).toBe(big)
  }, 15000)

  it('opens a row just added once its text is on screen', async () => {
    FakeWorker.hold = true
    const p = edit(big)
    const w = FakeWorker.all[0]
    await act(() => w.flush())
    fireEvent.click(cellButton('n0'))
    fireEvent.click(screen.getByRole('button', { name: 'Add row below' }))
    expect(p.onChange).toHaveBeenCalledTimes(1)
    // The old table has no such row yet: no sheet on it
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(() => w.flush())
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 3 · id')
    expect(valueBox()).toHaveValue('')
  }, 15000)
})

describe('TablePreview scroll', () => {
  it('the grid starts at the offset it was left at, once its rows are there', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => `r${i},${i}`).join('\n')
    show(`name,n\n${rows}\n`, { scrollTop: 300 })
    const grid = await screen.findByRole('grid')
    await waitFor(() => expect(grid.scrollTop).toBe(300))
    expect(grid).toHaveAttribute('data-scroll-restore')
  })

  it('an empty table has nothing to scroll to', async () => {
    show('name,n\n', { scrollTop: 300 })
    const grid = await screen.findByRole('grid')
    expect(grid.scrollTop).toBe(0)
  })
})

// The column template of the header row, and a column's width in it (ch)
const template = () =>
  (screen.getAllByRole('row')[0] as HTMLElement).style.gridTemplateColumns
const widthOf = (col: number) =>
  Number(new RegExp(`var\\(--w-${col}, ([\\d.]+)ch\\)`).exec(template())?.[1])
const handle = (name: string) =>
  screen.getByRole('separator', { name: `Resize column ${name}` })
const columnsMenu = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
const menuItem = (name: string) => screen.getByRole('menuitem', { name })
const wrapItem = (name: string) =>
  within(screen.getByRole('group', { name: 'Wrap' })).getByRole(
    'menuitemcheckbox',
    { name },
  )
const bodyRow = () => screen.getAllByRole('row')[1] as HTMLElement

const notes = `id,note\n1,${'x'.repeat(60)}\n2,short\n`

describe('TablePreview column widths', () => {
  it('a handle per column has a name and a value; the header keeps its name', () => {
    show(notes)
    const h = handle('note')
    expect(h).toHaveAttribute('aria-orientation', 'vertical')
    expect(h).toHaveAttribute('aria-valuenow', '32')
    expect(h).toHaveAttribute('aria-valuemin', '4')
    expect(h).toHaveAttribute('aria-valuemax', '120')
    expect(screen.getByRole('columnheader', { name: 'note' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'note' })).toBeVisible()
  })

  it('arrow keys step a width, Home and End go to the limits, Enter fits', () => {
    show(notes)
    fireEvent.keyDown(handle('note'), { key: 'ArrowRight' })
    expect(handle('note')).toHaveAttribute('aria-valuenow', '34')
    expect(widthOf(1)).toBe(34)
    expect(widthOf(0)).toBe(4)
    fireEvent.keyDown(handle('note'), { key: 'Home' })
    expect(widthOf(1)).toBe(4)
    fireEvent.keyDown(handle('note'), { key: 'ArrowLeft' })
    expect(widthOf(1)).toBe(4)
    fireEvent.keyDown(handle('note'), { key: 'End' })
    expect(widthOf(1)).toBe(120)
    fireEvent.keyDown(handle('note'), { key: 'Enter' })
    expect(widthOf(1)).toBe(60)
    // A key on a handle never moves the focus between cells
    expect(document.activeElement).not.toHaveAttribute('data-pos')
  })

  it('a drag sets the width on the frame only, then on the column as it ends', () => {
    show(notes)
    const grid = screen.getByRole('grid')
    const cell = screen.getByRole('gridcell', { name: 'short' })
    const before = template()
    fireEvent.pointerDown(handle('id'), { button: 0, clientX: 100 })
    // 7px a ch where nothing has a size
    fireEvent.pointerMove(handle('id'), { clientX: 170 })
    expect(grid.style.getPropertyValue('--w-0')).toBe('14ch')
    // Nothing rendered again meanwhile
    expect(template()).toBe(before)
    expect(screen.getByRole('gridcell', { name: 'short' })).toBe(cell)
    fireEvent.pointerUp(handle('id'), { clientX: 170 })
    expect(grid.style.getPropertyValue('--w-0')).toBe('')
    expect(widthOf(0)).toBe(14)
    expect(widthOf(1)).toBe(32)
    // A drag past the ceiling stops there; a cancel still keeps the width
    fireEvent.pointerDown(handle('note'), { button: 0, clientX: 0 })
    fireEvent.pointerMove(handle('note'), { clientX: 5000 })
    fireEvent.pointerCancel(handle('note'))
    expect(widthOf(1)).toBe(120)
    // Only the main button drags
    fireEvent.pointerDown(handle('note'), { button: 2, clientX: 0 })
    fireEvent.pointerMove(handle('note'), { clientX: -500 })
    expect(grid.style.getPropertyValue('--w-1')).toBe('')
  })

  it('two quick releases of a handle fit its column; slow ones do not', () => {
    vi.useFakeTimers()
    try {
      show(notes)
      const tap = () => {
        fireEvent.pointerDown(handle('note'), { button: 0, clientX: 10 })
        fireEvent.pointerUp(handle('note'), { clientX: 11 })
      }
      fireEvent.keyDown(handle('note'), { key: 'Home' })
      tap()
      vi.advanceTimersByTime(500)
      tap()
      expect(widthOf(1)).toBe(4)
      vi.advanceTimersByTime(100)
      tap()
      expect(widthOf(1)).toBe(60)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a click a finger leaves on a sort button right after a fit does not sort', () => {
    vi.useFakeTimers()
    try {
      show(notes)
      const tap = () => {
        fireEvent.pointerDown(handle('note'), {
          button: 0,
          clientX: 10,
          pointerType: 'touch',
        })
        fireEvent.pointerUp(handle('note'), {
          clientX: 10,
          pointerType: 'touch',
        })
      }
      tap()
      tap()
      expect(widthOf(1)).toBe(60)
      const note = screen.getByRole('columnheader', { name: 'note' })
      fireEvent.click(screen.getByRole('button', { name: 'note' }))
      expect(note).toHaveAttribute('aria-sort', 'none')
      vi.advanceTimersByTime(600)
      fireEvent.click(screen.getByRole('button', { name: 'note' }))
      expect(note).toHaveAttribute('aria-sort', 'ascending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('Fit columns fits every column, Reset widths drops what was set', () => {
    show(notes)
    columnsMenu()
    expect(menuItem('Reset widths')).toBeDisabled()
    fireEvent.click(menuItem('Fit columns'))
    expect(widthOf(0)).toBe(4)
    expect(widthOf(1)).toBe(60)
    columnsMenu()
    fireEvent.click(menuItem('Reset widths'))
    expect(widthOf(1)).toBe(32)
  })

  it('a fit reads from the first row in view', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
    try {
      const values = Array.from({ length: 2000 }, (_, i) =>
        i === 1500 ? 'y'.repeat(80) : 'v',
      )
      show(`n\n${values.join('\n')}\n`)
      fireEvent.keyDown(handle('n'), { key: 'Enter' })
      expect(widthOf(0)).toBe(4)
      const grid = screen.getByRole('grid')
      grid.scrollTop = 32 * 1000
      fireEvent.scroll(grid)
      act(() => vi.advanceTimersToNextFrame())
      fireEvent.keyDown(handle('n'), { key: 'Enter' })
      expect(widthOf(0)).toBe(80)
    } finally {
      vi.useRealTimers()
    }
  })

  it('widths go with another delimiter or header row, there and back', () => {
    show(notes)
    fireEvent.keyDown(handle('note'), { key: 'End' })
    fireEvent.click(screen.getByRole('button', { name: 'Header row' }))
    fireEvent.click(screen.getByRole('button', { name: 'Header row' }))
    expect(widthOf(1)).toBe(32)
    fireEvent.keyDown(handle('note'), { key: 'End' })
    const select = screen.getByRole('combobox', { name: 'Delimiter' })
    fireEvent.change(select, { target: { value: ';' } })
    fireEvent.change(select, { target: { value: ',' } })
    expect(widthOf(1)).toBe(32)
  })

  it('widths stay while the text changes (an edit)', () => {
    edit('a,b\n1,2\n')
    fireEvent.keyDown(handle('b'), { key: 'End' })
    fireEvent.click(cellButton('2'))
    fireEvent.change(valueBox(), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByRole('gridcell', { name: '9' })).toBeInTheDocument()
    expect(widthOf(1)).toBe(120)
  })

  it('a move under the slop is no drag, and a release with no drag sets nothing', () => {
    show(notes)
    fireEvent.pointerUp(handle('note'), { clientX: 0 })
    expect(widthOf(1)).toBe(32)
    fireEvent.pointerDown(handle('note'), { button: 0, clientX: 100 })
    fireEvent.pointerMove(handle('note'), { clientX: 103 })
    expect(screen.getByRole('grid').style.getPropertyValue('--w-1')).toBe('')
    fireEvent.pointerUp(handle('note'), { clientX: 103 })
    expect(widthOf(1)).toBe(32)
  })

  it('a drag takes its ch from the cell it starts in, and ending where it began sets nothing', () => {
    show(notes)
    // 116px cell less its 16px padding: 100px over 32ch
    const cell = handle('note').parentElement as HTMLElement
    cell.getBoundingClientRect = () => ({ width: 116 }) as DOMRect
    fireEvent.pointerDown(handle('note'), { button: 0, clientX: 100 })
    fireEvent.pointerMove(handle('note'), { clientX: 131.25 })
    expect(screen.getByRole('grid').style.getPropertyValue('--w-1')).toBe(
      '42ch',
    )
    fireEvent.pointerMove(handle('note'), { clientX: 100 })
    fireEvent.pointerUp(handle('note'), { clientX: 100 })
    expect(widthOf(1)).toBe(32)
  })

  it('a cancel with no move is no tap, and a lost capture ends a drag', () => {
    show(notes)
    fireEvent.pointerDown(handle('note'), { button: 0, clientX: 0 })
    fireEvent.pointerCancel(handle('note'))
    fireEvent.pointerDown(handle('note'), { button: 0, clientX: 100 })
    fireEvent.pointerUp(handle('note'), { clientX: 100 })
    // One release is no second tap: nothing fits
    expect(widthOf(1)).toBe(32)
    fireEvent.lostPointerCapture(handle('note'))
    expect(widthOf(1)).toBe(32)
    fireEvent.pointerDown(handle('note'), { button: 0, clientX: 100 })
    fireEvent.pointerMove(handle('note'), { clientX: 170 })
    fireEvent.lostPointerCapture(handle('note'))
    expect(widthOf(1)).toBe(42)
  })

  it('a mouse release does not hold back a sort click on the header', () => {
    show(notes)
    fireEvent.pointerDown(handle('note'), {
      button: 0,
      clientX: 10,
      pointerType: 'mouse',
    })
    fireEvent.pointerUp(handle('note'), {
      clientX: 10,
      pointerType: 'mouse',
    })
    fireEvent.click(screen.getByRole('button', { name: 'note' }))
    expect(screen.getByRole('columnheader', { name: 'note' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
  })

  it('a key the handle does not take goes on to the page', () => {
    show(notes)
    expect(fireEvent.keyDown(handle('note'), { key: 'a' })).toBe(true)
    expect(widthOf(1)).toBe(32)
    expect(fireEvent.keyDown(handle('note'), { key: 'ArrowLeft' })).toBe(false)
    expect(widthOf(1)).toBe(30)
  })

  it('a drag starting closes the Columns menu', () => {
    show(notes)
    columnsMenu()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.pointerDown(handle('note'), { button: 0, clientX: 0 })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('takes widths a tab kept under the same delimiter and header row, and tells each change', () => {
    const onLayout = vi.fn()
    const kept = { key: ',|1', widths: { 1: 50 }, wrapped: [1] }
    const p = show(notes, { layout: kept, onLayout })
    expect(widthOf(1)).toBe(50)
    expect(bodyRow()).toHaveStyle({ height: '61px' })
    fireEvent.keyDown(handle('note'), { key: 'ArrowRight' })
    expect(onLayout).toHaveBeenLastCalledWith({
      key: ',|1',
      widths: { 1: 52 },
      wrapped: [1],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Header row' }))
    expect(onLayout).toHaveBeenLastCalledWith({
      key: ',|0',
      widths: {},
      wrapped: [],
    })
    p.unmount()
    // Kept under another header row: dropped
    show(notes, { layout: { ...kept, key: ',|0' } })
    expect(widthOf(1)).toBe(32)
    expect(bodyRow()).toHaveStyle({ height: '32px' })
  })
})

describe('TablePreview wrapped columns', () => {
  const lines = 'id,note\n1,"\n\nREJECTED"\n2,b\n'

  it('a wrapped column shows its lines, ↵ kept, in taller rows', () => {
    show(lines)
    expect(bodyRow()).toHaveStyle({ height: '32px' })
    columnsMenu()
    const item = wrapItem('2 · note')
    expect(item).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(item)
    // The menu stays open for the next column
    expect(wrapItem('2 · note')).toHaveAttribute('aria-checked', 'true')
    expect(bodyRow()).toHaveStyle({ height: '61px' })
    expect(bodyRow()).toHaveClass('overflow-clip')
    const cell = screen.getAllByRole('gridcell')[1]
    expect(cell.querySelector('.line-clamp-3')?.textContent).toBe(
      '↵\n↵\nREJECTED',
    )
    expect(
      screen
        .getByRole('columnheader', { name: 'note' })
        .querySelector('.lucide-wrap-text'),
    ).not.toBeNull()
    expect(
      screen
        .getByRole('columnheader', { name: 'id' })
        .querySelector('.lucide-wrap-text'),
    ).toBeNull()
    fireEvent.click(wrapItem('2 · note'))
    expect(bodyRow()).toHaveStyle({ height: '32px' })
  })

  it('shows 3, 6 or 10 lines of a wrapped cell, the first row in view kept on top', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
    try {
      const six = Array.from({ length: 6 }, (_, i) => `l${i}`).join('\n')
      const text = `n\n${Array.from({ length: 2000 }, () => `"${six}"`).join('\n')}\n`
      const onLayout = vi.fn()
      show(text, { onLayout })
      const grid = screen.getByRole('grid')
      columnsMenu()
      const radio = (n: number) =>
        screen.getByRole('menuitemradio', { name: `${n} lines` })
      // Lines mean nothing until a column wraps
      expect(radio(3)).toBeDisabled()
      expect(radio(3)).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(wrapItem('1 · n'))
      expect(radio(6)).toBeEnabled()
      grid.scrollTop = 61 * 500
      fireEvent.scroll(grid)
      act(() => vi.advanceTimersToNextFrame())
      fireEvent.click(radio(6))
      // The menu stays open for another choice
      expect(radio(6)).toHaveAttribute('aria-checked', 'true')
      expect(radio(3)).toHaveAttribute('aria-checked', 'false')
      expect(bodyRow()).toHaveStyle({ height: '109px' })
      expect(grid.scrollTop).toBe(109 * 500)
      const cell = screen.getAllByRole('gridcell')[0]
      expect(cell.querySelector('.line-clamp-6')?.textContent).toBe(
        Array.from({ length: 6 }, (_, i) => `l${i}`).join('↵\n'),
      )
      expect(onLayout).toHaveBeenLastCalledWith({
        key: ',|1',
        widths: {},
        wrapped: [0],
        lines: 6,
      })
      fireEvent.click(radio(10))
      expect(bodyRow()).toHaveStyle({ height: '173px' })
      expect(
        screen.getAllByRole('gridcell')[0].querySelector('.line-clamp-10'),
      ).not.toBeNull()
      expect(grid.scrollTop).toBe(173 * 500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes the lines a tab kept, and 3 from a tab kept before them', () => {
    const p = show(lines, {
      layout: { key: ',|1', widths: {}, wrapped: [1], lines: 10 },
    })
    expect(bodyRow()).toHaveStyle({ height: '173px' })
    p.unmount()
    show(lines, { layout: { key: ',|1', widths: {}, wrapped: [1] } })
    expect(bodyRow()).toHaveStyle({ height: '61px' })
  })

  it('a value longer than three lines opens whole in the sheet', () => {
    const long = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n')
    show(`n\n"${long}"\n`)
    columnsMenu()
    fireEvent.click(wrapItem('1 · n'))
    fireEvent.click(screen.getAllByRole('gridcell')[0])
    expect(screen.getByRole('dialog').querySelector('pre')?.textContent).toBe(
      long,
    )
  })

  it('names columns in the menu as shown, numbered', () => {
    show(`a‮b,${'h'.repeat(MAX_CELL_CHARS + 1)}\n1,2\n`)
    columnsMenu()
    expect(wrapItem('1 · a⟨U+202E⟩b')).toBeInTheDocument()
    expect(wrapItem(`2 · ${'h'.repeat(MAX_CELL_CHARS)}…`)).toBeInTheDocument()
  })

  it('wrapping goes with another delimiter', () => {
    show(lines)
    columnsMenu()
    fireEvent.click(wrapItem('2 · note'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Delimiter' }), {
      target: { value: ';' },
    })
    expect(bodyRow()).toHaveStyle({ height: '32px' })
  })

  it('maps the scroll offset onto wrapped rows past the scroll height cap', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
    try {
      const count = Math.ceil(MAX_SCROLL_HEIGHT / 61) + 50_000
      show(`n\n${'x\n'.repeat(count)}`)
      const grid = await screen.findByRole('grid')
      columnsMenu()
      fireEvent.click(wrapItem('1 · n'))
      const spacers = () => {
        const inner = grid.firstElementChild as HTMLElement
        const top = inner.children[1] as HTMLElement
        const bottom = inner.lastElementChild as HTMLElement
        const rendered = inner.children.length - 3
        return (
          Number.parseFloat(top.style.height) +
          rendered * 61 +
          Number.parseFloat(bottom.style.height)
        )
      }
      const numbers = () =>
        screen.getAllByRole('rowheader').map((h) => Number(h.textContent))
      expect(spacers()).toBe(MAX_SCROLL_HEIGHT)
      grid.scrollTop = MAX_SCROLL_HEIGHT - 600
      fireEvent.scroll(grid)
      act(() => vi.advanceTimersToNextFrame())
      expect(numbers()).toContain(count + 1)
      expect(spacers()).toBe(MAX_SCROLL_HEIGHT)
    } finally {
      vi.useRealTimers()
    }
  })

  it('arrow keys and pages move by wrapped rows, below the header', () => {
    const text = `a\n${Array.from({ length: 100 }, (_, i) => i).join('\n')}\n`
    show(text)
    columnsMenu()
    fireEvent.click(wrapItem('1 · a'))
    const grid = screen.getByRole('grid')
    const first = screen.getAllByRole('gridcell')[0]
    first.focus()
    fireEvent.keyDown(first, { key: 'PageDown' })
    expect(document.activeElement).toHaveAttribute('data-pos', '9')
    // Row 9 ends at 610px, under a 32px header in a 600px frame
    expect(grid.scrollTop).toBe(9 * 61 + 32 + 61 - 600)
    fireEvent.keyDown(document.activeElement as Element, { key: 'PageUp' })
    expect(document.activeElement).toHaveAttribute('data-pos', '0')
    expect(grid.scrollTop).toBe(0)
  })

  it('starting or stopping a wrap keeps the first row in view on top', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
    try {
      const text = `n\n${Array.from({ length: 2000 }, (_, i) => i).join('\n')}\n`
      show(text)
      const grid = screen.getByRole('grid')
      grid.scrollTop = 32 * 500
      fireEvent.scroll(grid)
      act(() => vi.advanceTimersToNextFrame())
      columnsMenu()
      fireEvent.click(wrapItem('1 · n'))
      expect(grid.scrollTop).toBe(61 * 500)
      fireEvent.click(wrapItem('1 · n'))
      expect(grid.scrollTop).toBe(32 * 500)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TablePreview row numbers', () => {
  const openRow = (n: number) =>
    fireEvent.click(
      screen.getByRole('button', { name: `Open row ${n} as a record` }),
    )

  it('a row number opens that row as a record, sorted or filtered', async () => {
    show(people)
    // The row header keeps its name
    expect(screen.getByRole('rowheader', { name: 'Row 3' })).toBeVisible()
    openRow(3)
    expect(screen.getByText('Record 2 / 3 · row 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Records' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next record' }))
    expect(screen.getByText('Record 3 / 3 · row 4')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Records' }))
    // Sorted by age: row 3 (an, 4) comes first, and is still row 3
    fireEvent.click(screen.getByRole('button', { name: 'age' }))
    openRow(3)
    expect(screen.getByText('Record 1 / 3 · row 3')).toBeInTheDocument()
    // Filtered to it, then back
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'an' } })
    expect(await screen.findByText('Record 1 / 1 · row 3')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(await screen.findByText('Record 1 / 3 · row 3')).toBeInTheDocument()
    // Filtered out: the first record
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'Bình' },
    })
    expect(await screen.findByText('Record 1 / 1 · row 2')).toBeInTheDocument()
  })

  it('the arrow keys reach a row number without another Tab stop', () => {
    show(people)
    const first = screen.getAllByRole('gridcell')[0]
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    const number = document.activeElement as HTMLElement
    expect(number).toHaveAccessibleName('Open row 2 as a record')
    expect(number).toHaveAttribute('tabindex', '0')
    expect(first).toHaveAttribute('tabindex', '-1')
    // Opened from it, the focus goes to the record, out of the covered grid
    fireEvent.click(number)
    expect(document.activeElement).toContainElement(
      screen.getByText('Record 1 / 3 · row 2'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Records' }))
    fireEvent.keyDown(number, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(number)
    fireEvent.keyDown(number, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAccessibleName(
      'Open row 3 as a record',
    )
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' })
    expect(document.activeElement).toHaveTextContent('an')
  })

  it('a flagged row keeps its warning', () => {
    show(people)
    expect(
      screen.getByRole('rowheader', {
        name: 'Row 4: 2 cells, the header has 3',
      }),
    ).toHaveClass('text-warning')
    openRow(4)
    expect(screen.getByText('Record 3 / 3 · row 4')).toBeInTheDocument()
  })

  it('back from records, the grid is where it was, wrapped meanwhile or not', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
    try {
      const text = `n\n${Array.from({ length: 2000 }, (_, i) => i).join('\n')}\n`
      show(text)
      const grid = screen.getByRole('grid')
      grid.scrollTop = 32 * 500
      fireEvent.scroll(grid)
      act(() => vi.advanceTimersToNextFrame())
      openRow(510)
      // Covered: out of the accessibility tree and of the focus order
      expect(screen.queryByRole('grid')).toBeNull()
      expect(grid).toHaveAttribute('inert')
      columnsMenu()
      fireEvent.click(wrapItem('1 · n'))
      fireEvent.click(screen.getByRole('button', { name: 'Records' }))
      expect(screen.getByRole('grid')).toBe(grid)
      expect(grid).not.toHaveAttribute('inert')
      expect(grid.scrollTop).toBe(61 * 500)
      openRow(505)
      fireEvent.click(screen.getByRole('button', { name: 'Records' }))
      expect(grid.scrollTop).toBe(61 * 500)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TablePreview of a large file, while its rows are worked out', () => {
  const rows = Math.ceil(CSV_WORKER_MIN / 8) + 10
  const big = `id,name\n${Array.from({ length: rows }, (_, i) => `${rows - i},n${i}`).join('\n')}\n`

  beforeEach(() => {
    FakeWorker.all = []
    FakeWorker.hold = false
    vi.stubGlobal('Worker', FakeWorker)
  })

  it('neither fits nor opens a row number', async () => {
    FakeWorker.hold = true
    show(big)
    const w = FakeWorker.all[0]
    await act(() => w.flush())
    fireEvent.click(screen.getByRole('button', { name: 'id' }))
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'true')
    columnsMenu()
    expect(menuItem('Fit columns')).toBeDisabled()
    const before = widthOf(1)
    fireEvent.keyDown(handle('name'), { key: 'Enter' })
    expect(widthOf(1)).toBe(before)
    fireEvent.click(
      screen.getByRole('button', { name: 'Open row 2 as a record' }),
    )
    expect(screen.queryByText(/^Record /)).toBeNull()
    await act(() => w.flush())
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'false')
  })
})

describe('TablePreview pinned first column', () => {
  const pinItem = () =>
    screen.getByRole('menuitemcheckbox', { name: 'Pin first column' })
  const stuck = (el: Element) => el.classList.contains('sticky')
  const firstCells = () =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('gridcell')[0])

  it('pins the first column next to the row numbers, its header too, and tells it', () => {
    const onLayout = vi.fn()
    show(notes, { onLayout })
    const id = screen.getByRole('columnheader', { name: 'id' })
    expect(stuck(id)).toBe(false)
    columnsMenu()
    expect(pinItem()).toHaveAttribute('aria-checked', 'false')
    expect(pinItem()).toHaveAttribute('title', expect.stringMatching(/half/))
    fireEvent.click(pinItem())
    // The menu stays open
    expect(pinItem()).toHaveAttribute('aria-checked', 'true')
    expect(onLayout).toHaveBeenLastCalledWith({
      key: ',|1',
      widths: {},
      wrapped: [],
      pinned: true,
    })
    expect(stuck(id)).toBe(true)
    expect(id.style.left).toBe('calc(2ch + 1rem)')
    for (const cell of firstCells()) {
      expect(stuck(cell)).toBe(true)
      expect(cell.style.left).toBe('calc(2ch + 1rem)')
    }
    // Only the first column
    expect(stuck(screen.getByRole('columnheader', { name: 'note' }))).toBe(
      false,
    )
    expect(stuck(screen.getByRole('gridcell', { name: 'short' }))).toBe(false)
    fireEvent.click(pinItem())
    expect(stuck(id)).toBe(false)
    expect(firstCells().some(stuck)).toBe(false)
  })

  it('a tab keeps it; another header row or delimiter drops it', () => {
    const onLayout = vi.fn()
    show(notes, {
      layout: { key: ',|1', widths: {}, wrapped: [], pinned: true },
      onLayout,
    })
    expect(stuck(screen.getByRole('columnheader', { name: 'id' }))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Header row' }))
    expect(onLayout).toHaveBeenLastCalledWith({
      key: ',|0',
      widths: {},
      wrapped: [],
    })
    expect(firstCells().some(stuck)).toBe(false)
  })

  it('stops sticking while the row numbers and the column take more than half the frame', () => {
    let frame = 1000
    let cell = 0
    const width = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(() => frame)
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => ({ width: cell }) as DOMRect)
    try {
      const layout = { key: ',|1', widths: {}, wrapped: [], pinned: true }
      const p = show(notes, { layout })
      const id = () => screen.getByRole('columnheader', { name: 'id' })
      // Not measured: estimated from the widths in ch
      expect(stuck(id())).toBe(true)
      p.unmount()
      frame = 100
      const q = show(notes, { layout })
      expect(stuck(id())).toBe(false)
      expect(firstCells().some(stuck)).toBe(false)
      q.unmount()
      // Measured: two cells of 300px in a frame of 1000
      frame = 1000
      cell = 300
      show(notes, { layout })
      expect(stuck(id())).toBe(false)
    } finally {
      width.mockRestore()
      rect.mockRestore()
    }
  })

  it('a cell edited in the pinned column grows over the pinned cells below', () => {
    coarse.fine = true
    edit(notes)
    columnsMenu()
    fireEvent.click(pinItem())
    fireEvent.click(screen.getByRole('gridcell', { name: '1' }))
    const box = screen.getByRole('textbox', { name: 'Edit id, row 2' })
    const cell = box.closest('[role="gridcell"]') as HTMLElement
    expect(stuck(cell)).toBe(true)
    expect(cell.closest('[role="row"]')).toHaveClass('z-[7]')
    fireEvent.keyDown(box, { key: 'Tab' })
    const next = screen.getByRole('textbox', { name: 'Edit note, row 2' })
    const nextCell = next.closest('[role="gridcell"]') as HTMLElement
    expect(stuck(nextCell)).toBe(false)
    // Above the pinned cell of its row, which its field may grow over
    expect(nextCell).toHaveClass('z-[7]')
    expect(nextCell.closest('[role="row"]')).toHaveClass('z-[5]')
  })

  it('scrolls a cell given the focus out from under the columns stuck at the left', () => {
    const grid = () => screen.getByRole('grid')
    const v = show(notes)
    expect(grid().style.scrollPaddingLeft).toBe('calc(2ch + 1rem)')
    v.unmount()
    show(notes, {
      layout: { key: ',|1', widths: { 0: 10 }, wrapped: [], pinned: true },
    })
    expect(grid().style.scrollPaddingLeft).toBe('calc(12ch + 2rem)')
  })
})

describe('TablePreview hidden columns', () => {
  const abc = 'a,b,c\n1,2,3\n4,5,6\n'
  const showItem = (name: string) =>
    within(screen.getByRole('group', { name: 'Show' })).getByRole(
      'menuitemcheckbox',
      { name },
    )
  const headers = () =>
    screen
      .getAllByRole('columnheader')
      .slice(1)
      .map((h) => h.getAttribute('aria-label'))

  it('hides a column from the grid, says how many, and Show all brings it back', () => {
    const onLayout = vi.fn()
    show(abc, { onLayout })
    columnsMenu()
    expect(menuItem('Show all')).toBeDisabled()
    fireEvent.click(showItem('2 · b'))
    // The menu stays open
    expect(showItem('2 · b')).toHaveAttribute('aria-checked', 'false')
    expect(onLayout).toHaveBeenLastCalledWith({
      key: ',|1',
      widths: {},
      wrapped: [],
      hidden: [1],
    })
    expect(headers()).toEqual(['a', 'c'])
    expect(shownRows()).toEqual([
      ['1', '3'],
      ['4', '6'],
    ])
    // A screen reader is told which column a cell is in
    expect(screen.getByRole('columnheader', { name: 'c' })).toHaveAttribute(
      'aria-colindex',
      '4',
    )
    expect(screen.getByRole('gridcell', { name: '3' })).toHaveAttribute(
      'aria-colindex',
      '4',
    )
    expect(screen.getByRole('grid')).toHaveAttribute('aria-colcount', '4')
    const count = screen.getByText(/1 column hidden/)
    expect(count).toHaveAttribute(
      'title',
      'Filter rows also searches hidden columns',
    )
    // The last column shown cannot be hidden
    fireEvent.click(showItem('1 · a'))
    expect(screen.getByText(/2 columns hidden/)).toBeInTheDocument()
    expect(showItem('3 · c')).toBeDisabled()
    expect(showItem('1 · a')).toBeEnabled()
    fireEvent.click(showItem('1 · a'))
    expect(headers()).toEqual(['a', 'c'])
    fireEvent.click(menuItem('Show all'))
    expect(headers()).toEqual(['a', 'b', 'c'])
    expect(screen.queryByText(/hidden/)).toBeNull()
    // Disabled once it ran, it closes the menu
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a hidden wrapped column makes no row taller; a hidden sorted column drops the sort', () => {
    show('a,b\n2,y\n1,x\n', {
      layout: { key: ',|1', widths: {}, wrapped: [1], hidden: [1] },
    })
    expect(bodyRow()).toHaveStyle({ height: '32px' })
    columnsMenu()
    fireEvent.click(showItem('2 · b'))
    expect(bodyRow()).toHaveStyle({ height: '61px' })
    // A press outside closes the menu
    fireEvent.pointerDown(screen.getByRole('button', { name: 'b' }))
    fireEvent.click(screen.getByRole('button', { name: 'b' }))
    expect(shownRows().map((r) => r[0])).toEqual(['1', '2'])
    columnsMenu()
    fireEvent.click(showItem('1 · a'))
    // A sort by another column stays
    expect(shownRows().map((r) => r[0])).toEqual(['x', 'y'])
    fireEvent.click(showItem('1 · a'))
    fireEvent.click(showItem('2 · b'))
    expect(shownRows().map((r) => r[0])).toEqual(['2', '1'])
    expect(screen.getByRole('columnheader', { name: 'a' })).toHaveAttribute(
      'aria-sort',
      'none',
    )
  })

  it('the filter still searches hidden columns', async () => {
    show(abc, {
      layout: { key: ',|1', widths: {}, wrapped: [], hidden: [1] },
    })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '5' } })
    await waitFor(() => expect(shownRows()).toEqual([['4', '6']]))
  })

  it('a hidden column a tab kept past the columns read means nothing; another header row shows all', () => {
    const onLayout = vi.fn()
    show(abc, {
      layout: { key: ',|1', widths: {}, wrapped: [], hidden: [7, 2] },
      onLayout,
    })
    expect(headers()).toEqual(['a', 'b'])
    expect(screen.getByText(/1 column hidden/)).toBeInTheDocument()
    columnsMenu()
    fireEvent.click(showItem('1 · a'))
    expect(onLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ hidden: [2, 0] }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Header row' }))
    expect(headers()).toEqual(['Column 1', 'Column 2', 'Column 3'])
  })

  it('keys move along the columns shown; the pinned one is the first shown', () => {
    show(abc, {
      layout: {
        key: ',|1',
        widths: {},
        wrapped: [],
        hidden: [0],
        pinned: true,
      },
    })
    const key = (k: string, over: object = {}) =>
      fireEvent.keyDown(document.activeElement as Element, { key: k, ...over })
    const at = () => document.activeElement?.getAttribute('data-col')
    const first = screen.getByRole('gridcell', { name: '2' })
    expect(first).toHaveAttribute('tabindex', '0')
    expect(first.classList.contains('sticky')).toBe(true)
    expect(
      screen
        .getByRole('columnheader', { name: 'b' })
        .classList.contains('sticky'),
    ).toBe(true)
    first.focus()
    key('ArrowRight')
    expect(at()).toBe('2')
    key('ArrowLeft')
    expect(at()).toBe('1')
    key('End')
    expect(at()).toBe('2')
    key('Home', { ctrlKey: true })
    expect(at()).toBe('1')
  })

  it('Fit columns fits only the columns shown', () => {
    const onLayout = vi.fn()
    show(`a,b\n${'x'.repeat(30)},${'y'.repeat(30)}\n`, {
      layout: { key: ',|1', widths: {}, wrapped: [], hidden: [1] },
      onLayout,
    })
    columnsMenu()
    fireEvent.click(menuItem('Fit columns'))
    expect(Object.keys(onLayout.mock.lastCall?.[0].widths)).toEqual(['0'])
  })

  it('Records show only the columns shown, and say how many are hidden', () => {
    show(abc, {
      layout: { key: ',|1', widths: {}, wrapped: [], hidden: [1] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Records' }))
    expect(
      screen.getByText(/Record 1 \/ 2 · row 2 · 1 column hidden/),
    ).toBeInTheDocument()
    expect(
      within(record())
        .getAllByRole('term')
        .map((t) => t.textContent),
    ).toEqual(['a', 'c'])
  })

  it('Records say "columns" past one', () => {
    show(abc, {
      layout: { key: ',|1', widths: {}, wrapped: [], hidden: [0, 1] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Records' }))
    expect(
      screen.getByText(/Record 1 \/ 2 · row 2 · 2 columns hidden/),
    ).toBeInTheDocument()
  })

  describe('while editing in a cell', () => {
    beforeEach(() => {
      coarse.fine = true
    })
    const field = (name: string) => screen.getByRole('textbox', { name })

    it('Tab and Shift+Tab skip a hidden column', () => {
      edit(abc)
      columnsMenu()
      fireEvent.click(showItem('2 · b'))
      fireEvent.click(screen.getByRole('gridcell', { name: '1' }))
      fireEvent.keyDown(field('Edit a, row 2'), { key: 'Tab' })
      fireEvent.keyDown(field('Edit c, row 2'), { key: 'Tab' })
      expect(field('Edit a, row 3')).toHaveFocus()
      fireEvent.keyDown(field('Edit a, row 3'), { key: 'Tab', shiftKey: true })
      expect(field('Edit c, row 2')).toHaveFocus()
      fireEvent.keyDown(field('Edit c, row 2'), { key: 'Tab', shiftKey: true })
      expect(field('Edit a, row 2')).toHaveFocus()
    })

    it('F2, a key typed and Delete act on the column of the cell, past a hidden one', () => {
      const p = edit(abc)
      columnsMenu()
      fireEvent.click(showItem('1 · a'))
      const two = screen.getByRole('gridcell', { name: '2' })
      two.focus()
      fireEvent.keyDown(two, { key: 'F2' })
      fireEvent.keyDown(field('Edit b, row 2'), { key: 'Escape' })
      expect(screen.getByRole('gridcell', { name: '2' })).toHaveFocus()
      fireEvent.keyDown(screen.getByRole('gridcell', { name: '3' }), {
        key: 'z',
      })
      fireEvent.keyDown(field('Edit c, row 2'), { key: 'Enter' })
      expect(p.text()).toBe('a,b,c\n1,2,z\n4,5,6\n')
      expect(screen.getByRole('gridcell', { name: 'z' })).toHaveFocus()
      fireEvent.keyDown(screen.getByRole('gridcell', { name: '5' }), {
        key: 'Delete',
      })
      expect(p.text()).toBe('a,b,c\n1,2,z\n4,,6\n')
    })

    it('a field whose column is hidden sets its value', () => {
      const p = edit(abc)
      fireEvent.click(screen.getByRole('gridcell', { name: '2' }))
      fireEvent.change(field('Edit b, row 2'), { target: { value: 'two' } })
      columnsMenu()
      fireEvent.click(showItem('2 · b'))
      expect(screen.queryByRole('textbox', { name: /^Edit / })).toBeNull()
      expect(p.text()).toBe('a,b,c\n1,two,3\n4,5,6\n')
    })
  })
})

describe('TablePreview find', () => {
  // beta: row 2 word, row 3 name, row 4 note
  const greek =
    'name,word,note\nalpha,beta,x\nbeta,gamma,y\ngamma,delta,beta\ndelta,alpha,z\n'
  const findBox = () => screen.getByRole('textbox', { name: 'Find' })
  const at = (row: number, col: number) =>
    document.querySelector(
      `[role="gridcell"][data-pos="${row}"][data-col="${col}"]`,
    ) as HTMLElement
  const classes = (el: Element) => el.className.split(/\s+/)
  // Cells found, and the current one, as "place in rows:column"
  const found = () =>
    [...document.querySelectorAll<HTMLElement>('[role="gridcell"]')]
      .filter((c) => classes(c).includes('from-accent/15'))
      .map((c) => `${c.dataset.pos}:${c.dataset.col}`)
  const currentCell = () =>
    [...document.querySelectorAll<HTMLElement>('[role="gridcell"]')]
      .filter((c) => classes(c).includes('outline-accent'))
      .map((c) => `${c.dataset.pos}:${c.dataset.col}`)
  const openFind = (from: Element = at(0, 0)) =>
    fireEvent.keyDown(from, { key: 'f', ctrlKey: true })
  const typeFind = async (query: string, count: string) => {
    fireEvent.change(findBox(), { target: { value: query } })
    expect(await screen.findByText(count)).toBeInTheDocument()
  }
  const enter = (shiftKey = false) =>
    fireEvent.keyDown(findBox(), { key: 'Enter', shiftKey })
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    scrollIntoView.mockClear()
    Element.prototype.scrollIntoView = scrollIntoView
  })
  afterEach(() => {
    // jsdom has none
    delete (Element.prototype as Partial<Element>).scrollIntoView
  })

  it('Ctrl+F on a table only viewed opens find, the focus in it; every row stays', async () => {
    show(greek)
    expect(openFind()).toBe(false)
    expect(findBox()).toHaveFocus()
    await typeFind('BETA', '1 of 3')
    expect(found()).toEqual(['0:1', '1:0', '2:2'])
    // The first match is current and scrolled to, the focus left in find
    expect(currentCell()).toEqual(['0:1'])
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      block: 'nearest',
      inline: 'nearest',
    })
    expect(findBox()).toHaveFocus()
    expect(screen.getByText('4 / 4 rows')).toBeInTheDocument()
    expect(document.querySelector('search')).toBeInTheDocument()
  })

  it('Enter and Shift+Enter go round the matches; the buttons too', async () => {
    show(greek)
    openFind()
    await typeFind('beta', '1 of 3')
    enter()
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    expect(currentCell()).toEqual(['1:0'])
    enter()
    enter()
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    enter(true)
    expect(screen.getByText('3 of 3')).toBeInTheDocument()
    expect(currentCell()).toEqual(['2:2'])
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
  })

  it('F3 and Shift+F3 on a cell go to the next match and give it the focus', async () => {
    show(greek)
    openFind()
    await typeFind('beta', '1 of 3')
    at(0, 0).focus()
    expect(fireEvent.keyDown(at(0, 0), { key: 'F3' })).toBe(false)
    expect(at(1, 0)).toHaveFocus()
    fireEvent.keyDown(at(1, 0), { key: 'F3', shiftKey: true })
    expect(at(0, 1)).toHaveFocus()
    // F3 in find goes too, leaving the focus there
    findBox().focus()
    fireEvent.keyDown(findBox(), { key: 'F3' })
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    expect(findBox()).toHaveFocus()
  })

  it('Escape closes find onto the current match; F3 opens it again on the next one', async () => {
    show(greek)
    openFind()
    await typeFind('beta', '1 of 3')
    enter()
    fireEvent.keyDown(findBox(), { key: 'Escape' })
    expect(document.querySelector('search')).toBeNull()
    expect(at(1, 0)).toHaveFocus()
    // Closed, nothing is marked
    expect(found()).toEqual([])
    fireEvent.keyDown(at(1, 0), { key: 'F3' })
    expect(await screen.findByText('3 of 3')).toBeInTheDocument()
    expect(at(2, 2)).toHaveFocus()
    // Ctrl+F again: the query chosen, to type over
    openFind(at(2, 2))
    expect(findBox()).toHaveFocus()
    expect(findBox()).toHaveValue('beta')
    expect((findBox() as HTMLInputElement).selectionStart).toBe(0)
    expect((findBox() as HTMLInputElement).selectionEnd).toBe(4)
  })

  it('with no query, F3 opens find; closed with no match, the focus goes back to the active cell', async () => {
    show(greek)
    at(1, 1).focus()
    fireEvent.click(at(1, 1))
    fireEvent.keyDown(at(1, 1), { key: 'F3' })
    expect(findBox()).toHaveFocus()
    await typeFind('zz', 'No matches')
    // Nothing to go to
    enter()
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }))
    expect(at(1, 1)).toHaveFocus()
  })

  it("Ctrl+F typed in the filter or in a sheet is the browser's, F3 in a sheet too", () => {
    show(greek)
    expect(
      fireEvent.keyDown(screen.getByRole('searchbox'), {
        key: 'f',
        ctrlKey: true,
      }),
    ).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
    fireEvent.click(at(0, 0))
    const sheet = screen.getByRole('dialog')
    expect(fireEvent.keyDown(sheet, { key: 'F3' })).toBe(true)
    expect(fireEvent.keyDown(sheet, { key: 'f', ctrlKey: true })).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
    // Other keys with Ctrl, on a table only viewed, are left alone
    expect(fireEvent.keyDown(at(0, 0), { key: 'z', ctrlKey: true })).toBe(true)
  })

  it('match case, whole cell and a regex; a bad one says so', async () => {
    show(greek)
    openFind()
    await typeFind('Beta', '1 of 3')
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }))
    expect(await screen.findByText('No matches')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }))
    await typeFind('bet', '1 of 3')
    fireEvent.click(screen.getByRole('button', { name: 'Whole cell' }))
    expect(await screen.findByText('No matches')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Whole cell' }))
    fireEvent.click(screen.getByRole('button', { name: 'Regular expression' }))
    await typeFind('(', 'Invalid pattern')
    expect(found()).toEqual([])
  })

  it('finds only the columns shown, and says so', async () => {
    show(greek)
    columnsMenu()
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show' })).getByRole(
        'menuitemcheckbox',
        { name: '2 · word' },
      ),
    )
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    openFind()
    await typeFind('beta', '1 of 2')
    expect(found()).toEqual(['1:0', '2:2'])
    expect(screen.getByText('Hidden columns not searched')).toBeInTheDocument()
  })

  it('a sort keeps the current match, by its row of the file', async () => {
    show(greek)
    openFind()
    await typeFind('beta', '1 of 3')
    enter()
    expect(currentCell()).toEqual(['1:0'])
    // Descending: gamma, delta, beta (row 3), alpha
    fireEvent.click(screen.getByRole('button', { name: 'name' }))
    fireEvent.click(screen.getByRole('button', { name: 'name' }))
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    expect(currentCell()).toEqual(['2:0'])
  })

  it('the current match filtered out, or its column hidden: the next one after it', async () => {
    show(greek)
    openFind()
    await typeFind('beta', '1 of 3')
    enter()
    // Rows 4 and 5 left: none after row 3's place, so the first
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'delta' },
    })
    expect(await screen.findByText('1 of 1')).toBeInTheDocument()
    expect(currentCell()).toEqual(['0:2'])
    // Row 3 back: its match again
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(await screen.findByText('2 of 3')).toBeInTheDocument()
    expect(currentCell()).toEqual(['1:0'])
    // Its column hidden: the next match, on row 4
    columnsMenu()
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show' })).getByRole(
        'menuitemcheckbox',
        { name: '1 · name' },
      ),
    )
    expect(await screen.findByText('2 of 2')).toBeInTheDocument()
    expect(currentCell()).toEqual(['2:2'])
  })

  it('an edit that ends the current match moves it to the next, and from the last to the first', async () => {
    const p = edit(greek)
    openFind()
    await typeFind('beta', '1 of 3')
    enter(true)
    expect(screen.getByText('3 of 3')).toBeInTheDocument()
    // The note of row 4 set to another value: back to the first match
    fireEvent.click(at(2, 2))
    fireEvent.change(valueBox(), { target: { value: 'nu' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.text()).toContain('gamma,delta,nu')
    expect(await screen.findByText('1 of 2')).toBeInTheDocument()
    expect(currentCell()).toEqual(['0:1'])
  })

  it("the current match's column hidden: the next column shown, or the next row", async () => {
    show(greek)
    openFind()
    await typeFind('beta', '1 of 3')
    // Row 2's match, in word
    const hide = (name: string) => {
      columnsMenu()
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Show' })).getByRole(
          'menuitemcheckbox',
          { name },
        ),
      )
      fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    }
    hide('2 · word')
    // name, note shown: row 2 has none after word; row 3's name is next
    expect(await screen.findByText('1 of 2')).toBeInTheDocument()
    expect(currentCell()).toEqual(['1:0'])
    enter()
    expect(currentCell()).toEqual(['2:2'])
    // note hidden too: no column after it, so the next row's match
    hide('3 · note')
    expect(await screen.findByText('1 of 1')).toBeInTheDocument()
    expect(currentCell()).toEqual(['1:0'])
  })

  it('Enter typed right after the query goes from its own matches', async () => {
    show(greek)
    openFind()
    fireEvent.change(findBox(), { target: { value: 'beta' } })
    enter()
    expect(await screen.findByText('2 of 3')).toBeInTheDocument()
  })

  it('Ctrl+Shift+F, Ctrl+Alt+F and Ctrl+F3 are left alone', () => {
    show(greek)
    expect(
      fireEvent.keyDown(at(0, 0), { key: 'F', ctrlKey: true, shiftKey: true }),
    ).toBe(true)
    expect(
      fireEvent.keyDown(at(0, 0), { key: 'f', ctrlKey: true, altKey: true }),
    ).toBe(true)
    expect(fireEvent.keyDown(at(0, 0), { key: 'F3', ctrlKey: true })).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
  })

  it('records follow the match gone to; closed, the focus goes back to them', async () => {
    show(greek)
    fireEvent.click(screen.getByRole('button', { name: 'Records' }))
    openFind(screen.getByRole('button', { name: 'Records' }))
    await typeFind('beta', '1 of 3')
    enter()
    expect(screen.getByText(/· row 3$/)).toBeInTheDocument()
    fireEvent.keyDown(findBox(), { key: 'Escape' })
    expect(record().parentElement?.closest('[tabindex="-1"]')).toHaveFocus()
  })

  it('marks only the rows rendered, and goes to a match far below', async () => {
    const many = `n,v\n${Array.from({ length: 300 }, (_, i) => `${i},${i % 100 === 50 ? 'hit' : 'x'}`).join('\n')}\n`
    show(many)
    openFind()
    await typeFind('hit', '1 of 3')
    expect(found()).toEqual(['50:1'])
    enter()
    expect(found()).toEqual(['150:1'])
    expect(currentCell()).toEqual(['150:1'])
  })
})

describe('TablePreview find, editing in a cell (a fine pointer)', () => {
  beforeEach(() => {
    coarse.fine = true
  })

  it("F3 in a cell's field sets it, then goes to the next match", async () => {
    const p = edit('a,b\nbeta,1\n2,beta\n')
    const cell = (name: string) => screen.getByRole('gridcell', { name })
    fireEvent.keyDown(cell('1'), { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'Find' }), {
      target: { value: 'beta' },
    })
    expect(await screen.findByText('1 of 2')).toBeInTheDocument()
    fireEvent.doubleClick(cell('1'))
    const box = screen.getByRole('textbox', { name: 'Edit b, row 2' })
    fireEvent.change(box, { target: { value: '9' } })
    fireEvent.keyDown(box, { key: 'F3' })
    expect(p.text()).toBe('a,b\nbeta,9\n2,beta\n')
    expect(await screen.findByText('2 of 2')).toBeInTheDocument()
  })
})

describe('TablePreview find in a worker', () => {
  // Answers a parse or a search through its real handler
  class AnyWorker {
    onmessage?: (e: MessageEvent) => void
    constructor(readonly url: URL) {}
    async postMessage(req: unknown) {
      const find = this.url.pathname.includes('csv-find-worker')
      const [data] = find
        ? (await import('../utils/csv-find-worker')).handleFind(req as never)
        : (await import('../utils/csv-parse-worker')).handleRequest(
            req as never,
          )
      this.onmessage?.(new MessageEvent('message', { data }))
    }
    terminate() {}
  }

  beforeEach(() => vi.stubGlobal('Worker', AnyWorker))

  it('a regex is found in the worker, "…" meanwhile', async () => {
    show('a\nbeta\nbit\nbot\n')
    fireEvent.keyDown(document.querySelector('[role="gridcell"]') as Element, {
      key: 'f',
      ctrlKey: true,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Regular expression' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Find' }), {
      target: { value: '^b.t$' },
    })
    expect(screen.getByText('…')).toBeInTheDocument()
    expect(await screen.findByText('1 of 2')).toBeInTheDocument()
  })
})

describe('TablePreview row and column edits', () => {
  const abc = 'a,b,c\n1,2,3\n4,,6\n'
  const header = (name: string) =>
    screen.getByRole('columnheader', { name }) as HTMLElement
  const headers = () =>
    screen
      .getAllByRole('columnheader')
      .slice(1)
      .map((h) => h.getAttribute('aria-label'))
  const menuOf = (name: string) =>
    screen.getByRole('button', { name: `Column ${name}` })
  const choose = (name: string) =>
    fireEvent.click(screen.getByRole('menuitem', { name }))
  const nameBox = () => screen.getByRole('textbox', { name: /^Rename column/ })
  const confirmDelete = () =>
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Delete column',
      }),
    )

  beforeEach(() => {
    coarse.fine = true
  })

  it("Insert row above in a cell's sheet adds the row before it", () => {
    coarse.fine = false
    const p = edit(abc)
    fireEvent.click(screen.getByRole('gridcell', { name: '4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert row above' }))
    expect(p.text()).toBe('a,b,c\n1,2,3\n,,\n4,,6\n')
    // Its first cell opens
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 3 · a')
  })

  it('a column added at the right asks for its name; Enter sets it, one undo each', () => {
    const p = edit(abc)
    fireEvent.click(menuOf('a'))
    choose('Insert column right')
    expect(p.text()).toBe('a,,b,c\n1,,2,3\n4,,,6\n')
    expect(nameBox()).toHaveFocus()
    expect(nameBox()).toHaveValue('')
    fireEvent.change(nameBox(), { target: { value: 'new' } })
    fireEvent.keyDown(nameBox(), { key: 'Enter' })
    expect(p.text()).toBe('a,new,b,c\n1,,2,3\n4,,,6\n')
    expect(headers()).toEqual(['a', 'new', 'b', 'c'])
    press(screen.getByRole('grid'), 'z')
    press(screen.getByRole('grid'), 'z')
    expect(p.text()).toBe(abc)
    expect(headers()).toEqual(['a', 'b', 'c'])
    press(screen.getByRole('grid'), 'z', { shiftKey: true })
    expect(headers()).toEqual(['a', 'Column 2', 'b', 'c'])
  })

  it('a name left as it was, or dropped with Escape, makes no edit', () => {
    const p = edit(abc)
    fireEvent.click(menuOf('b'))
    choose('Insert column left')
    expect(p.text()).toBe('a,,b,c\n1,,2,3\n4,,,6\n')
    fireEvent.keyDown(nameBox(), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: /^Rename/ })).toBeNull()
    fireEvent.keyDown(header('c').querySelector('button') as Element, {
      key: 'F2',
    })
    fireEvent.keyDown(nameBox(), { key: 'Enter' })
    expect(p.onChange).toHaveBeenCalledTimes(1)
  })

  it('a double click renames, sorting once; Ctrl+S in the name saves after it', () => {
    const p = edit(abc)
    const button = header('b').querySelector('button') as HTMLElement
    fireEvent.click(button, { detail: 1 })
    fireEvent.click(button, { detail: 2 })
    fireEvent.doubleClick(button)
    expect(header('b')).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.change(nameBox(), { target: { value: 'B' } })
    fireEvent.keyDown(nameBox(), { key: 's', ctrlKey: true })
    expect(p.text()).toBe('a,B,c\n1,2,3\n4,,6\n')
    expect(p.onSave).toHaveBeenCalled()
  })

  it('a name the field cannot take renames in the sheet; ⤢ takes what was typed there', () => {
    const p = edit('a,x\u202Ey\n1,2\n')
    fireEvent.contextMenu(header('x⟨U+202E⟩y'))
    choose('Rename column')
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 1 · x⟨U+202E⟩y')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(header('a').querySelector('button') as Element, {
      key: 'F2',
    })
    fireEvent.change(nameBox(), { target: { value: 'z' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open in sheet' }))
    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveValue('z')
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('a column deleted, after saying what goes with it; widths, wraps, hidden columns and sort follow', () => {
    const p = edit('a,b,c,d\n1,2,3,4\n5,,7,8\n')
    // d sorted, c wrapped, a width set
    fireEvent.click(header('d').querySelector('button') as HTMLElement)
    columnsMenu()
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Wrap' })).getByRole(
        'menuitemcheckbox',
        { name: '3 · c' },
      ),
    )
    fireEvent.click(menuItem('Fit columns'))
    fireEvent.contextMenu(header('b'))
    choose('Delete column')
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Delete column b?1 cell with a value goes with it. The column is removed from the file when you save it.',
    )
    confirmDelete()
    expect(p.text()).toBe('a,c,d\n1,3,4\n5,7,8\n')
    expect(header('d')).toHaveAttribute('aria-sort', 'ascending')
    // The wrap icon of its name
    const icon = (name: string) =>
      header(name).querySelector('button[title] svg')
    expect(icon('c')).not.toBeNull()
    // Undone, b is back, unwrapped, and the sort with d
    press(screen.getByRole('grid'), 'z')
    expect(headers()).toEqual(['a', 'b', 'c', 'd'])
    expect(header('d')).toHaveAttribute('aria-sort', 'ascending')
    expect(icon('b')).toBeNull()
    expect(icon('c')).not.toBeNull()
  })

  it('deleting the sorted column drops the sort; the count reads right for none or many', () => {
    edit('a,b\n1,2\n3,4\n')
    fireEvent.click(header('b').querySelector('button') as HTMLElement)
    fireEvent.contextMenu(header('b'))
    choose('Delete column')
    expect(screen.getByRole('dialog')).toHaveTextContent(
      '2 cells with a value go with it.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(headers()).toEqual(['a', 'b'])
    fireEvent.contextMenu(header('b'))
    choose('Delete column')
    confirmDelete()
    expect(header('a')).toHaveAttribute('aria-sort', 'none')
    fireEvent.contextMenu(header('a'))
    // The last column cannot go
    expect(
      screen.getByRole('menuitem', { name: 'Delete column' }),
    ).toBeDisabled()
  })

  it('a column with no values says so', () => {
    edit('a,b\n1,\n')
    fireEvent.contextMenu(header('b'))
    choose('Delete column')
    expect(screen.getByRole('dialog')).toHaveTextContent('It has no values.')
  })

  it('a hidden column after the one added stays hidden', () => {
    edit(abc)
    columnsMenu()
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show' })).getByRole(
        'menuitemcheckbox',
        { name: '3 · c' },
      ),
    )
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    fireEvent.contextMenu(header('a'))
    choose('Insert column left')
    fireEvent.keyDown(nameBox(), { key: 'Escape' })
    expect(headers()).toEqual(['Column 1', 'a', 'b'])
  })

  it('Shift+F10 or the context menu on a cell offers its row too', () => {
    const p = edit(abc)
    const cell = screen.getByRole('gridcell', { name: '2' })
    fireEvent.keyDown(cell, { key: 'F10', shiftKey: true })
    choose('Insert row above')
    expect(p.text()).toBe('a,b,c\n,,\n1,2,3\n4,,6\n')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.contextMenu(screen.getByRole('gridcell', { name: '6' }))
    choose('Insert row below')
    expect(p.text()).toBe('a,b,c\n,,\n1,2,3\n4,,6\n,,\n')
  })

  it('the context menu key on a column name opens its menu; a row number has none', () => {
    edit(abc)
    fireEvent.keyDown(header('c').querySelector('button') as Element, {
      key: 'ContextMenu',
    })
    expect(menuOf('c')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByRole('menuitem', { name: /row/ })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(
      fireEvent.contextMenu(
        screen.getByRole('button', { name: 'Open row 2 as a record' }),
      ),
    ).toBe(true)
    // Other keys on a name are left alone
    expect(
      fireEvent.keyDown(header('c').querySelector('button') as Element, {
        key: 'x',
      }),
    ).toBe(true)
  })

  it('without a header row there is no rename, and an added column asks nothing', () => {
    const p = edit(abc)
    fireEvent.click(screen.getByRole('button', { name: 'Header row' }))
    fireEvent.contextMenu(header('Column 1'))
    expect(screen.queryByRole('menuitem', { name: 'Rename column' })).toBeNull()
    choose('Insert column left')
    expect(p.text()).toBe(',a,b,c\n,1,2,3\n,4,,6\n')
    expect(screen.queryByRole('textbox', { name: /^Rename/ })).toBeNull()
    // Every row's value counts, the first one too
    fireEvent.contextMenu(header('Column 2'))
    choose('Delete column')
    expect(screen.getByRole('dialog')).toHaveTextContent(
      '3 cells with a value go with it.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // F2 on a name does nothing
    expect(
      fireEvent.keyDown(header('Column 2').querySelector('button') as Element, {
        key: 'F2',
      }),
    ).toBe(true)
  })

  it("a table only viewed has no column menu; its context menu is the browser's", () => {
    show(abc)
    expect(screen.queryByRole('button', { name: /^Column / })).toBeNull()
    expect(fireEvent.contextMenu(header('a'))).toBe(true)
    expect(
      fireEvent.contextMenu(screen.getByRole('gridcell', { name: '1' })),
    ).toBe(true)
    expect(
      fireEvent.keyDown(screen.getByRole('gridcell', { name: '1' }), {
        key: 'ContextMenu',
      }),
    ).toBe(true)
  })

  it('another view changing the text closes a name being edited, and a column delete asked, setting nothing', () => {
    const p = edit(abc)
    fireEvent.keyDown(header('a').querySelector('button') as Element, {
      key: 'F2',
    })
    // Its context menu is the field's own
    expect(fireEvent.contextMenu(nameBox())).toBe(true)
    fireEvent.change(nameBox(), { target: { value: 'z' } })
    p.rerender(<Draft {...p} elsewhere={`x,y,z\n${abc}`} />)
    expect(screen.queryByRole('textbox', { name: /^Rename/ })).toBeNull()
    fireEvent.contextMenu(header('y'))
    choose('Delete column')
    p.rerender(<Draft {...p} elsewhere={abc} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('a column added at the right of the last one: its name field grows leftward', () => {
    edit(abc)
    fireEvent.click(menuOf('c'))
    choose('Insert column right')
    expect(nameBox()).toHaveAccessibleName('Rename column Column 4')
    expect(nameBox().closest('[data-last]')).not.toBeNull()
  })

  it("a touch screen renames in the sheet, the header row's: no row added or deleted there", () => {
    coarse.fine = false
    coarse.value = true
    const p = edit(abc)
    fireEvent.click(menuOf('a'))
    choose('Insert column right')
    const sheet = screen.getByRole('dialog')
    expect(sheet).toHaveTextContent('Row 1 · Column 2')
    for (const name of ['Insert row above', 'Add row below', 'Delete row']) {
      expect(within(sheet).queryByRole('button', { name })).toBeNull()
    }
    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), {
      target: { value: 'new' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.text()).toBe('a,new,b,c\n1,,2,3\n4,,,6\n')
    fireEvent.click(menuOf('b'))
    choose('Rename column')
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 1 · b')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // No rename on a double tap
    fireEvent.doubleClick(header('c').querySelector('button') as Element)
    expect(screen.queryByRole('textbox', { name: /^Rename/ })).toBeNull()
  })

  it('a menu asked from a cell gives the focus back to it; a field it opens keeps it', () => {
    edit(abc)
    const cell = screen.getByRole('gridcell', { name: '2' })
    cell.focus()
    fireEvent.keyDown(cell, { key: 'ContextMenu' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.getByRole('gridcell', { name: '2' })).toHaveFocus()
    // A right click inside it keeps its row's actions
    fireEvent.contextMenu(screen.getByRole('gridcell', { name: '3' }))
    fireEvent.contextMenu(
      screen.getByRole('menuitem', { name: 'Insert column left' }),
    )
    expect(
      screen.getByRole('menuitem', { name: 'Insert row above' }),
    ).toBeVisible()
    choose('Insert column left')
    expect(nameBox()).toHaveFocus()
  })

  it('a menu opened from its ⋯ leaves the focus where it closes', () => {
    edit(abc)
    fireEvent.click(menuOf('a'))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(menuOf('a')).toHaveFocus()
  })
})

describe('TablePreview layout and column edits leaving editing', () => {
  const abc = 'a,b,c\n1,2,3\n'
  const headers = () =>
    screen
      .getAllByRole('columnheader')
      .slice(1)
      .map((h) => h.getAttribute('aria-label'))

  // A table edited by hand: the column op made on abc, as a draft has it
  function setup() {
    coarse.fine = true
    const onChange = vi.fn()
    const editing = (ops: TableOp[]): TableEditing => ({
      delimiter: ',',
      ops,
      redo: [],
      saving: false,
      canSave: true,
      onChange,
      onSave: vi.fn(),
    })
    const p = show(abc, { editing: editing([]) })
    const view = (text: string, ed?: TableEditing) =>
      p.rerender(
        <ThemeProvider>
          <TablePreview {...p} text={text} editing={ed} />
        </ThemeProvider>,
      )
    // c hidden, then a column added before a
    columnsMenu()
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show' })).getByRole(
        'menuitemcheckbox',
        { name: '3 · c' },
      ),
    )
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    fireEvent.contextMenu(screen.getByRole('columnheader', { name: 'a' }))
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Insert column left' }),
    )
    const [text, ops] = onChange.mock.lastCall as [string, TableOp[]]
    view(text, editing(ops))
    fireEvent.keyDown(screen.getByRole('textbox', { name: /^Rename/ }), {
      key: 'Escape',
    })
    expect(headers()).toEqual(['Column 1', 'a', 'b'])
    return { view, editing, text, ops }
  }

  it('dropped (Discard), the layout goes back with the text', () => {
    const { view } = setup()
    view(abc)
    expect(headers()).toEqual(['a', 'b'])
  })

  it("saved, the layout stays: the text is the file's now", () => {
    const { view, text } = setup()
    view(text.replace(/\n/g, '\r\n'))
    expect(headers()).toEqual(['Column 1', 'a', 'b'])
  })

  it('applied again on another file, the layout follows the new op', () => {
    const { view, editing, ops } = setup()
    const r = reapply('x,a,b,c\n0,1,2,3\n', ',', ops)
    if (!r.ok) throw new Error('not a table')
    view(r.text, editing(r.ops))
    // The column went in before a, found second: the layout moved there.
    // x, the host's own, moves the old places by one, as with no edit
    expect(headers()).toEqual(['x', 'Column 2', 'a', 'c'])
    expect(screen.getByText(/1 column hidden/)).toBeInTheDocument()
  })

  it("a save that ran while more was edited: the ops it saved are the file's", () => {
    const { view, editing, text, ops } = setup()
    const later = makeOp(text, parsed(text), {
      kind: 'insert',
      after: 0,
    }) as TableOp
    const next = redoOp(text, later)
    view(next, editing([...ops, later]))
    // The save took the column op: the draft goes on with the row
    view(next, editing([later]))
    expect(headers()).toEqual(['Column 1', 'a', 'b'])
  })
})

function parsed(text: string): CsvTable {
  const r = parseCsv(text, ',')
  if (!r.ok) throw new Error('not a table')
  return r.table
}

describe('TablePreview ranges, copy and paste', () => {
  const grid4 = 'a,b,c\n1,2,3\n4,5,6\n7,8,9\n'
  const at = (pos: number, col: number) =>
    document.querySelector(
      `[role="gridcell"][data-pos="${pos}"][data-col="${col}"]`,
    ) as HTMLElement
  const picked = () =>
    [...document.querySelectorAll<HTMLElement>('[aria-selected="true"]')].map(
      (c) => `${c.dataset.pos}:${c.dataset.col}`,
    )
  const key = (target: Element, k: string, over: object = {}) =>
    fireEvent.keyDown(target, { key: k, ...over })
  // Ctrl+C on the grid: what it wrote to the clipboard
  const copy = (from: Element) => {
    copyText.mockClear()
    const ok = key(from, 'c', { ctrlKey: true })
    return { text: copyText.mock.calls[0]?.[0], prevented: !ok }
  }
  // Ctrl+V on the grid, then the paste as the browser sends it, to the
  // field that has the focus then
  const paste = (from: Element, text: string) => {
    key(from, 'v', { ctrlKey: true })
    return !fireEvent.paste(document.activeElement as Element, {
      clipboardData: { getData: () => text },
    })
  }

  // A range from one cell to another, by Shift+arrows
  const select = (from: [number, number], to: [number, number]) => {
    at(...from).focus()
    let [pos, col] = from
    while (col < to[1]) key(at(pos, col++), 'ArrowRight', { shiftKey: true })
    while (pos < to[0]) key(at(pos++, col), 'ArrowDown', { shiftKey: true })
  }

  beforeEach(() => {
    coarse.fine = true
  })

  it('Shift+arrows grow a range from where it began; an arrow alone or Escape drops it', () => {
    show(grid4)
    at(0, 0).focus()
    key(at(0, 0), 'ArrowRight', { shiftKey: true })
    key(at(0, 1), 'ArrowDown', { shiftKey: true })
    expect(picked()).toEqual(['0:0', '0:1', '1:0', '1:1'])
    expect(screen.getByRole('grid')).toHaveAttribute(
      'aria-multiselectable',
      'true',
    )
    expect(at(1, 1)).toHaveFocus()
    key(at(1, 1), 'Escape')
    expect(picked()).toEqual([])
    key(at(1, 1), 'End', { shiftKey: true, ctrlKey: true })
    expect(picked()).toEqual(['1:1', '1:2', '2:1', '2:2'])
    key(at(2, 2), 'ArrowLeft')
    expect(picked()).toEqual([])
    // Escape with no range is left alone
    expect(key(at(2, 1), 'Escape')).toBe(true)
    // Never onto a row number: from one, Shift moves as an arrow does
    const number = screen.getByRole('button', {
      name: 'Open row 2 as a record',
    })
    number.focus()
    key(number, 'ArrowRight', { shiftKey: true })
    expect(picked()).toEqual([])
    key(at(0, 0), 'ArrowLeft', { shiftKey: true })
    expect(picked()).toEqual([])
  })

  it('Shift+click and a mouse drag select; the click a drag ends with opens nothing', () => {
    const p = edit(grid4)
    fireEvent.click(at(0, 0), { shiftKey: true })
    // From the active cell, the first one
    expect(picked()).toEqual([])
    fireEvent.click(at(1, 1), { shiftKey: true })
    expect(picked()).toEqual(['0:0', '0:1', '1:0', '1:1'])
    // A plain click drops it, and only makes its cell active
    fireEvent.click(at(2, 2), { detail: 1 })
    expect(picked()).toEqual([])
    expect(screen.queryByRole('textbox', { name: /^Edit/ })).toBeNull()
    fireEvent.pointerDown(at(0, 1), { pointerType: 'mouse', button: 0 })
    fireEvent.pointerMove(at(0, 1), {
      pointerType: 'mouse',
      buttons: 1,
      clientY: 100,
    })
    expect(picked()).toEqual([])
    fireEvent.pointerMove(at(1, 2), {
      pointerType: 'mouse',
      buttons: 1,
      clientY: 100,
    })
    fireEvent.pointerUp(at(1, 2), { pointerType: 'mouse' })
    expect(picked()).toEqual(['0:1', '0:2', '1:1', '1:2'])
    fireEvent.click(at(1, 2))
    expect(screen.queryByRole('textbox', { name: /^Edit/ })).toBeNull()
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it("a drag only with the mouse's first button, from a cell; near the edges it scrolls", () => {
    show(grid4)
    const grid = screen.getByRole('grid')
    fireEvent.pointerDown(at(0, 0), { pointerType: 'touch', button: 0 })
    fireEvent.pointerMove(at(1, 1), { pointerType: 'touch', buttons: 1 })
    fireEvent.pointerDown(at(0, 0), { pointerType: 'mouse', button: 2 })
    fireEvent.pointerMove(at(1, 1), { pointerType: 'mouse', buttons: 1 })
    fireEvent.pointerDown(at(0, 0), {
      pointerType: 'mouse',
      button: 0,
      shiftKey: true,
    })
    fireEvent.pointerMove(at(1, 1), { pointerType: 'mouse', buttons: 1 })
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Open row 2 as a record' }),
      {
        pointerType: 'mouse',
        button: 0,
      },
    )
    fireEvent.pointerMove(at(1, 1), { pointerType: 'mouse', buttons: 1 })
    expect(picked()).toEqual([])
    fireEvent.pointerDown(at(0, 0), { pointerType: 'mouse', button: 0 })
    // Released meanwhile, out of the grid
    fireEvent.pointerMove(at(1, 1), { pointerType: 'mouse', buttons: 0 })
    expect(picked()).toEqual([])
    // Below the frame's bottom (jsdom's box is 0 high): a row down; above
    // its top: a row up; over a row number nothing is selected
    fireEvent.pointerMove(
      screen.getByRole('button', { name: 'Open row 3 as a record' }),
      { pointerType: 'mouse', buttons: 1, clientY: 100 },
    )
    expect(grid.scrollTop).toBeGreaterThan(0)
    fireEvent.pointerMove(grid, {
      pointerType: 'mouse',
      buttons: 1,
      clientY: -100,
    })
    expect(grid.scrollTop).toBe(0)
    // In between: no scroll
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 500,
    } as DOMRect)
    fireEvent.pointerMove(grid, {
      pointerType: 'mouse',
      buttons: 1,
      clientY: 200,
    })
    expect(grid.scrollTop).toBe(0)
    expect(picked()).toEqual([])
  })

  it('Ctrl+C copies the range as tabs, whole values in the order shown, hidden columns left out', () => {
    show('a,b,c\n1,"x\ny",3\n4,5,6\n')
    // Sorted by a, descending: 4 first
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    columnsMenu()
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show' })).getByRole(
        'menuitemcheckbox',
        { name: '2 · b' },
      ),
    )
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    at(0, 0).focus()
    key(at(0, 0), 'End', { shiftKey: true, ctrlKey: true })
    expect(copy(at(1, 2))).toEqual({ text: '4\t6\n1\t3', prevented: true })
    // No range: the active cell; a row number: its row
    key(at(1, 2), 'Home')
    expect(copy(at(1, 0)).text).toBe('1')
    // Cmd+C on macOS, with no text selected for a copy event to come from
    copyText.mockClear()
    expect(key(at(1, 0), 'c', { metaKey: true })).toBe(false)
    expect(copyText).toHaveBeenLastCalledWith('1')
    const number = screen.getByRole('button', {
      name: 'Open row 2 as a record',
    })
    number.focus()
    fireEvent.click(number)
    fireEvent.click(screen.getByRole('button', { name: 'Records' }))
    expect(copy(number).text).toBe('1\t3')
  })

  it('a value with a line break is quoted; too many cells copy nothing and say so', () => {
    const p = show('a,b\n"x\ny",2\n')
    at(0, 0).focus()
    expect(copy(at(0, 0)).text).toBe('"x\ny"')
    const many = `a,b,c\n${'1,2,3\n'.repeat(33_334)}`
    p.rerender(
      <ThemeProvider>
        <TablePreview {...p} text={many} />
      </ThemeProvider>,
    )
    at(0, 0).focus()
    key(at(0, 0), 'End', { shiftKey: true, ctrlKey: true })
    // The focus went with the range to the last cell
    expect(copy(document.activeElement as Element)).toEqual({
      text: undefined,
      prevented: true,
    })
    expect(p.notify).toHaveBeenCalledWith(
      'Too many cells to copy: 100002, at most 100000',
    )
  })

  it('Ctrl+V pastes a block from the active cell as one edit; one Ctrl+Z takes it back', () => {
    const p = edit(grid4)
    at(1, 1).focus()
    expect(paste(at(1, 1), '5\tx\ny\t9\n')).toBe(true)
    expect(p.text()).toBe('a,b,c\n1,2,3\n4,5,x\n7,y,9\n')
    expect(p.onChange.mock.lastCall?.[1]).toHaveLength(1)
    press(at(1, 1), 'z')
    expect(p.text()).toBe(grid4)
    // From a range the block does not fill whole: its top-left cell
    key(at(1, 1), 'ArrowUp', { shiftKey: true })
    paste(at(0, 1), 'q\tr')
    expect(p.text()).toBe('a,b,c\n1,q,r\n4,5,6\n7,8,9\n')
    // Nothing that changes, or nothing at all: no edit
    paste(at(0, 1), 'q\tr')
    paste(at(0, 1), '')
    expect(p.onChange).toHaveBeenCalledTimes(3)
  })

  it('a range the block fills whole gets it over and over, as one edit', () => {
    const p = edit(grid4)
    // One cell: every cell of the range
    select([0, 0], [1, 1])
    paste(at(1, 1), 'q')
    expect(p.text()).toBe('a,b,c\nq,q,3\nq,q,6\n7,8,9\n')
    expect(p.onChange).toHaveBeenCalledTimes(1)
    press(at(1, 1), 'z')
    expect(p.text()).toBe(grid4)
    // A row of two cells: every row of a range two columns wide
    select([0, 0], [2, 1])
    paste(at(2, 1), 'x\ty')
    expect(p.text()).toBe('a,b,c\nx,y,3\nx,y,6\nx,y,9\n')
    press(at(2, 1), 'z')
    key(at(2, 1), 'Escape')
    // Three rows: not two blocks whole down, so once, from the top-left cell
    select([0, 0], [2, 2])
    paste(at(2, 2), 'x\ny')
    expect(p.text()).toBe('a,b,c\nx,2,3\ny,5,6\n7,8,9\n')
    press(at(2, 2), 'z')
    key(at(2, 2), 'Escape')
    // A column of two cells: every column of a range two rows tall
    select([1, 0], [2, 2])
    paste(at(2, 2), 'x\ny')
    expect(p.text()).toBe('a,b,c\n1,2,3\nx,x,x\ny,y,y\n')
  })

  it('repeated, a short line of the block empties its missing cells', () => {
    const grid = 'a,b\n1,2\n3,4\n5,6\n7,8\n'
    const p = edit(grid)
    select([0, 0], [3, 1])
    paste(at(3, 1), 'x\ty\nz')
    expect(p.text()).toBe('a,b\nx,y\nz,\nx,y\nz,\n')
    // Once, it leaves them as they are
    press(at(3, 1), 'z')
    key(at(3, 1), 'Escape')
    at(0, 0).focus()
    paste(at(0, 0), 'x\ty\nz')
    expect(p.text()).toBe('a,b\nx,y\nz,4\n5,6\n7,8\n')
  })

  it('Delete and Backspace clear every cell of the range, as one edit', () => {
    const p = edit(grid4)
    select([0, 0], [1, 1])
    expect(key(at(1, 1), 'Delete')).toBe(false)
    expect(p.text()).toBe('a,b,c\n,,3\n,,6\n7,8,9\n')
    expect(p.onChange).toHaveBeenCalledTimes(1)
    // The rows worked out again drop the range, as a paste does; the cell
    // left in focus, empty now, makes no edit
    expect(picked()).toEqual([])
    key(at(1, 1), 'Backspace')
    expect(p.onChange).toHaveBeenCalledTimes(1)
    press(at(1, 1), 'z')
    expect(p.text()).toBe(grid4)
    key(at(1, 1), 'Escape')
    // Along the rows shown, sorted
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    select([0, 1], [1, 2])
    key(at(1, 2), 'Backspace')
    expect(p.text()).toBe('a,b,c\n1,2,3\n4,,\n7,,\n')
    expect(screen.queryByRole('textbox', { name: /^Edit / })).toBeNull()
  })

  it('a range over a hidden column leaves its cells as they are', () => {
    const p = edit(grid4)
    columnsMenu()
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show' })).getByRole(
        'menuitemcheckbox',
        { name: '2 · b' },
      ),
    )
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    // a and c, side by side now (data-col is the file's column)
    at(0, 0).focus()
    key(at(0, 0), 'ArrowRight', { shiftKey: true })
    key(at(0, 2), 'ArrowDown', { shiftKey: true })
    key(at(1, 2), 'Delete')
    expect(p.text()).toBe('a,b,c\n,2,\n,5,\n7,8,9\n')
  })

  it('a range too large to clear: refused, saying so', () => {
    const p = edit(`a,b,c\n${'1,2,3\n'.repeat(33_334)}`)
    at(0, 0).focus()
    key(at(0, 0), 'End', { shiftKey: true, ctrlKey: true })
    key(document.activeElement as Element, 'Delete')
    expect(p.notify).toHaveBeenLastCalledWith(
      'Too many cells to clear: 100002, at most 100000',
    )
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('a table only viewed: Delete on a range clears nothing', () => {
    show(grid4)
    select([0, 0], [1, 1])
    expect(key(at(1, 1), 'Delete')).toBe(true)
    expect(at(0, 0)).toHaveTextContent('1')
  })

  it('a row number with no range pastes once from its first cell, never over the row', () => {
    const p = edit(grid4)
    const number = screen.getByRole('button', {
      name: 'Open row 3 as a record',
    })
    number.focus()
    paste(number, 'q')
    expect(p.text()).toBe('a,b,c\n1,2,3\nq,5,6\n7,8,9\n')
  })

  it('too many cells once repeated over the range: refused, saying so', () => {
    const p = edit(`a,b,c\n${'1,2,3\n'.repeat(33_334)}`)
    at(0, 0).focus()
    key(at(0, 0), 'End', { shiftKey: true, ctrlKey: true })
    paste(document.activeElement as Element, 'q')
    expect(p.notify).toHaveBeenLastCalledWith(
      'Too many cells to paste over the range: 100002, at most 100000',
    )
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('a paste on a sorted table goes to the rows shown, along the columns shown', () => {
    const p = edit(grid4)
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    at(0, 0).focus()
    paste(at(0, 0), 'x\ny')
    expect(p.text()).toBe('a,b,c\n1,2,3\ny,5,6\nx,8,9\n')
  })

  it('wider than the columns left: refused; longer while sorted: refused, saying why', () => {
    const p = edit(grid4)
    at(0, 1).focus()
    paste(at(0, 1), '1\t2\t3')
    expect(p.notify).toHaveBeenLastCalledWith(
      'The block is 3 columns wide; 2 columns from here',
    )
    at(0, 2).focus()
    paste(at(0, 2), '1\t2')
    expect(p.notify).toHaveBeenLastCalledWith(
      'The block is 2 columns wide; 1 column from here',
    )
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    at(2, 0).focus()
    paste(at(2, 0), '1\n2\n3')
    expect(p.notify).toHaveBeenLastCalledWith(
      'The block is 3 rows long; 1 row from here, and no row is added while sorted or filtered',
    )
    at(1, 0).focus()
    paste(at(1, 0), '1\n2\n3')
    expect(p.notify).toHaveBeenLastCalledWith(
      'The block is 3 rows long; 2 rows from here, and no row is added while sorted or filtered',
    )
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('longer than the rows left: asks to add them, then pastes as one edit', () => {
    const p = edit(grid4)
    at(2, 1).focus()
    paste(at(2, 1), 'x\ny\nz')
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Add 2 rows at the end?',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(p.onChange).not.toHaveBeenCalled()
    paste(at(2, 1), 'x\ny')
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Add 1 row at the end?',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add and paste' }))
    expect(p.text()).toBe('a,b,c\n1,2,3\n4,5,6\n7,x,9\n,y,\n')
    press(screen.getByRole('grid'), 'z')
    expect(p.text()).toBe(grid4)
  })

  it('the question goes when another view changes the text', () => {
    const p = edit(grid4)
    at(2, 1).focus()
    paste(at(2, 1), 'x\ny')
    p.rerender(<Draft {...p} elsewhere={`${grid4}0,0,0\n`} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a table only viewed leaves a paste to the browser; a field keeps its own copy and paste', () => {
    show(grid4)
    at(0, 0).focus()
    expect(paste(at(0, 0), 'x')).toBe(false)
    const p = edit(grid4)
    fireEvent.click(
      within(p.container).getAllByRole('gridcell', { name: '1' })[0],
    )
    const box = screen.getByRole('textbox', { name: /^Edit/ })
    key(box, 'v', { ctrlKey: true })
    expect(
      fireEvent.paste(document, { clipboardData: { getData: () => 'z' } }),
    ).toBe(true)
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('Cmd+V takes the paste in a hidden field, which then gives the focus back', () => {
    const p = edit(grid4)
    at(0, 1).focus()
    key(at(0, 1), 'v', { metaKey: true })
    // A field: the only place macOS lets Cmd+V paste with nothing selected
    const field = document.activeElement as HTMLTextAreaElement
    expect(field.tagName).toBe('TEXTAREA')
    expect(field).toHaveAttribute('aria-hidden', 'true')
    expect(
      fireEvent.paste(field, { clipboardData: { getData: () => 'x' } }),
    ).toBe(false)
    expect(field.isConnected).toBe(false)
    expect(document.activeElement).toBe(at(0, 1))
    expect(p.onChange).toHaveBeenCalledTimes(1)
    // No text on the clipboard: an empty paste changes nothing
    key(at(0, 1), 'v', { metaKey: true })
    fireEvent.paste(document.activeElement as Element)
    expect(document.activeElement).toBe(at(0, 1))
    expect(p.onChange).toHaveBeenCalledTimes(1)
  })

  it('no paste coming (another key, the focus gone, a moment passed): the field goes, the focus comes back', () => {
    vi.useFakeTimers()
    try {
      const p = edit(grid4)
      at(0, 0).focus()
      key(at(0, 0), 'v', { ctrlKey: true })
      let field = document.activeElement as HTMLElement
      vi.runAllTimers()
      expect(field.isConnected).toBe(false)
      expect(document.activeElement).toBe(at(0, 0))
      // Late, to the field gone: nothing pasted, the focus left alone
      fireEvent.paste(field, { clipboardData: { getData: () => 'x' } })
      fireEvent.blur(field)
      key(at(0, 0), 'v', { ctrlKey: true })
      field = document.activeElement as HTMLElement
      key(field, 'ArrowDown')
      expect(field.isConnected).toBe(false)
      expect(document.activeElement).toBe(at(0, 0))
      key(at(0, 0), 'v', { ctrlKey: true })
      field = document.activeElement as HTMLElement
      fireEvent.blur(field)
      expect(field.isConnected).toBe(false)
      expect(p.onChange).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Ctrl+C or V on another layout of letters is the key where C or V is', () => {
    show(grid4)
    at(0, 1).focus()
    copyText.mockClear()
    key(at(0, 1), 'с', { ctrlKey: true, code: 'KeyC' })
    expect(copyText).toHaveBeenLastCalledWith('2')
    // Another key with Ctrl is not a copy
    copyText.mockClear()
    key(at(0, 1), 'ж', { ctrlKey: true, code: 'Semicolon' })
    expect(copyText).not.toHaveBeenCalled()
  })

  it('a grid with no row shown copies nothing, leaving the clipboard alone', async () => {
    show(grid4)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zz' } })
    await screen.findByText('0 / 3 rows')
    const grid = screen.getByRole('grid')
    grid.focus()
    copyText.mockClear()
    expect(key(grid, 'c', { ctrlKey: true })).toBe(true)
    expect(copyText).not.toHaveBeenCalled()
  })

  it('too many cells to paste: refused, saying so', () => {
    const p = edit(grid4)
    at(0, 0).focus()
    paste(at(0, 0), 'x\n'.repeat(100_001))
    expect(p.notify).toHaveBeenLastCalledWith(
      'Too many cells to paste: 100001, at most 100000',
    )
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('a range of one cell left: Escape goes on to the page', () => {
    show(grid4)
    at(0, 0).focus()
    key(at(0, 0), 'ArrowRight', { shiftKey: true })
    key(at(0, 1), 'ArrowLeft', { shiftKey: true })
    expect(picked()).toEqual([])
    expect(key(at(0, 0), 'Escape')).toBe(true)
  })

  it('a drag leaves its last cell active, in focus: Shift and an arrow grow the range on', () => {
    show(grid4)
    fireEvent.pointerDown(at(0, 0), { pointerType: 'mouse', button: 0 })
    fireEvent.pointerMove(at(1, 1), {
      pointerType: 'mouse',
      buttons: 1,
      clientY: 100,
    })
    // The same cell again changes nothing
    fireEvent.pointerMove(at(1, 1), {
      pointerType: 'mouse',
      buttons: 1,
      clientY: 100,
    })
    expect(at(1, 1)).toHaveFocus()
    key(at(1, 1), 'ArrowDown', { shiftKey: true })
    expect(picked()).toHaveLength(6)
    // Released outside the frame: the next click is a click
    fireEvent.pointerDown(at(0, 2), { pointerType: 'mouse', button: 0 })
    fireEvent.click(at(0, 2), { detail: 1 })
    expect(picked()).toEqual([])
  })

  it('a sort drops the range, which would land on other cells', () => {
    show(grid4)
    at(0, 0).focus()
    key(at(0, 0), 'ArrowDown', { shiftKey: true })
    expect(picked()).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    expect(picked()).toEqual([])
  })
})

describe('TablePreview: a click of a fine pointer selects, a double click opens', () => {
  const abc = 'a,b\n1,2\n'
  const cell = (name: string) => screen.getByRole('gridcell', { name })
  const field = () => screen.queryByRole('textbox', { name: /^Edit / })

  it('editing: a click makes the cell active, a double click or Enter edits it', () => {
    coarse.fine = true
    const p = edit(abc)
    fireEvent.click(cell('1'), { detail: 1 })
    expect(field()).toBeNull()
    expect(cell('1')).toHaveAttribute('tabindex', '0')
    // The second click of a double click does not open it either
    fireEvent.click(cell('2'), { detail: 2 })
    expect(field()).toBeNull()
    fireEvent.doubleClick(cell('2'))
    expect(field()).toHaveAccessibleName('Edit b, row 2')
    fireEvent.keyDown(field() as HTMLElement, { key: 'Escape' })
    // Enter on a cell is a click with no detail
    fireEvent.click(cell('1'), { detail: 0 })
    expect(field()).toHaveAccessibleName('Edit a, row 2')
    // A double click on a row number opens nothing more than its click
    fireEvent.keyDown(field() as HTMLElement, { key: 'Escape' })
    fireEvent.doubleClick(
      screen.getByRole('button', { name: 'Open row 2 as a record' }),
    )
    expect(field()).toBeNull()
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it('viewed: a click asks for nothing, a double click starts editing', () => {
    coarse.fine = true
    const onRequestEdit = vi.fn(() => false)
    show(abc, { onRequestEdit })
    fireEvent.click(cell('1'), { detail: 1 })
    expect(onRequestEdit).not.toHaveBeenCalled()
    fireEvent.doubleClick(cell('1'))
    expect(onRequestEdit).toHaveBeenCalledTimes(1)
  })

  it('a touch screen still opens a cell with a tap, and a double tap is no more', () => {
    coarse.value = true
    show(abc)
    fireEvent.click(cell('1'), { detail: 1 })
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 2 · a')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.doubleClick(cell('1'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a click puts the focus on its cell, where a browser leaves it on the grid', () => {
    coarse.fine = true
    edit(abc)
    const grid = screen.getByRole('grid')
    grid.focus()
    fireEvent.click(cell('2'), { detail: 1 })
    expect(cell('2')).toHaveFocus()
    // Shift+click too
    grid.focus()
    fireEvent.click(cell('1'), { detail: 1, shiftKey: true })
    expect(cell('1')).toHaveFocus()
  })

  it('a tap on a touch screen opens, though a mouse is the main pointer; Shift+double click opens nothing', () => {
    coarse.fine = true
    edit(abc)
    const tap = new MouseEvent('click', { bubbles: true, detail: 1 })
    Object.defineProperty(tap, 'pointerType', { value: 'touch' })
    fireEvent(cell('1'), tap)
    expect(field()).toHaveAccessibleName('Edit a, row 2')
    fireEvent.keyDown(field() as HTMLElement, { key: 'Escape' })
    fireEvent.doubleClick(cell('2'), { shiftKey: true })
    expect(field()).toBeNull()
  })

  it("the cell in focus is outlined, a click's too; a column name only from the keyboard", () => {
    show(abc)
    expect(cell('1')).toHaveClass('focus:outline-accent')
    expect(
      screen.getByRole('button', { name: 'a' }).className.split(/\s+/),
    ).not.toContain('focus:outline-accent')
  })
})
