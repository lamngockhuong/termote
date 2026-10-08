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
import type { TableOp } from '../utils/csv-edits'
import type { Delimiter } from '../utils/csv-parse'
import { CSV_WORKER_MIN } from '../utils/csv-parse-client'
import { MAX_SCROLL_HEIGHT } from '../utils/table-columns'
import { MAX_CELL_CHARS } from './table-grid'
import TablePreview, { MAX_COLUMNS, type TableEditing } from './table-preview'

vi.mock('../utils/highlight', async (orig) => ({
  ...(await orig<typeof import('../utils/highlight')>()),
  highlight: async () => null,
}))
const coarse = vi.hoisted(() => ({ value: false }))
vi.mock('../hooks/use-media-query', () => ({
  useIsMobile: () => false,
  useMediaQuery: () => coarse.value,
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
  screen.getByRole('menuitemcheckbox', { name })
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
    expect(bodyRow()).toHaveClass('overflow-hidden')
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
