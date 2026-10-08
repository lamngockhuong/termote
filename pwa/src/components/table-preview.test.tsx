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
import { MAX_CELL_CHARS, MAX_SCROLL_HEIGHT } from './table-grid'
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
    expect(screen.getAllByRole('row')[1]).toHaveClass('pointer-coarse:h-touch')
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
    expect(screen.getByText('Hà Nội, VN')).toBeInTheDocument()
    fireEvent.click(next)
    expect(next).toBeDisabled()
    expect(screen.getByText('Record 3 / 3 · row 4')).toBeInTheDocument()
    fireEvent.click(prev)
    expect(screen.getByText('Record 2 / 3 · row 3')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Hà Nội, VN'))
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
