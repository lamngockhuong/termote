import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import { viewerClosing } from '../hooks/use-history-close'
import { readTablePrefs, tableKey } from '../utils/table-prefs'
import MarkdownPreview from './markdown-preview'

const PATH = 'docs/specs.md'
const TABLE = [
  '| Name | Note | Link |',
  '|---|---|---|',
  '| one | short | [two](two.md) |',
  '| three | long | x |',
].join('\n')
const KEY = tableKey(PATH, ['Name', 'Note', 'Link'])

function show(text = TABLE, over: Record<string, unknown> = {}) {
  const props = {
    text,
    path: PATH,
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

const tool = (name: RegExp | string) => screen.getByRole('button', { name })
const cells = (col: number) =>
  [...(screen.getAllByRole('table')[0] as HTMLTableElement).rows].map(
    (r) => r.cells[col] as HTMLElement,
  )

const popped = () =>
  new Promise<void>((r) =>
    window.addEventListener('popstate', () => r(), { once: true }),
  )

afterEach(async () => {
  // A full screen still open takes its history entry off as it unmounts
  const pop = popped()
  cleanup()
  if (viewerClosing()) await pop
})

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn().mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

describe('MarkdownPreview: table tools', () => {
  it('gives the classes and marks of its tables to nothing the file writes', () => {
    const { container } = show(
      [
        '<div class="md-cell" data-cell data-clamped>raw</div>',
        '',
        '<table class="md-table md-expanded"><tr data-open><td>x</td></tr></table>',
      ].join('\n'),
    )
    // Raw HTML shows as text: no element takes the table tools' styles
    expect(screen.queryByRole('table')).toBeNull()
    expect(
      container.querySelector('.md-cell, .md-table, [data-cell], [data-open]'),
    ).toBeNull()
    expect(container).toHaveTextContent('<div class="md-cell"')
  })

  it('expands a table, and keeps it expanded for the next time', () => {
    const { unmount } = show()
    const table = screen.getByRole('table')
    expect(table).toHaveClass('md-table')
    expect(table).not.toHaveClass('md-expanded')
    fireEvent.click(tool('Expand table'))
    expect(table).toHaveClass('md-expanded')
    expect(tool('Expand table')).toHaveAttribute('aria-pressed', 'true')
    expect(readTablePrefs(KEY)).toEqual({ expanded: true })
    unmount()
    show()
    expect(screen.getByRole('table')).toHaveClass('md-expanded')
  })

  it('hides a column from its header, and shows the hidden ones again', () => {
    show()
    fireEvent.click(tool('Hide column Note'))
    for (const c of cells(1)) expect(c.style.display).toBe('none')
    expect(cells(0)[0].style.display).toBe('')
    expect(readTablePrefs(KEY)).toEqual({ hidden: [1] })
    fireEvent.click(tool('Hide column Name'))
    // The last column left cannot be hidden
    expect(
      screen.queryByRole('button', { name: 'Hide column Link' }),
    ).toBeNull()
    fireEvent.click(tool('Show 2 hidden columns'))
    for (const c of cells(1)) expect(c.style.display).toBe('')
    expect(readTablePrefs(KEY)).toEqual({})
  })

  it('resizes a column by dragging the edge of its header, or with the arrow keys', () => {
    show()
    const table = screen.getByRole('table')
    const edge = screen.getByRole('separator', { name: 'Resize column Note' })
    // jsdom lays nothing out: every column starts at the narrowest
    fireEvent.pointerDown(edge, { button: 0, clientX: 100, pointerId: 1 })
    expect(table.style.tableLayout).toBe('fixed')
    fireEvent.pointerMove(edge, { clientX: 180, pointerId: 1 })
    expect(cells(1)[0].style.width).toBe('130px')
    expect(table.style.width).toBe('230px')
    fireEvent.pointerUp(edge, { pointerId: 1 })
    expect(readTablePrefs(KEY)).toEqual({
      widths: { collapsed: [50, 130, 50] },
    })
    expect(edge).toHaveAttribute('aria-valuenow', '130')
    fireEvent.keyDown(edge, { key: 'ArrowLeft' })
    expect(readTablePrefs(KEY).widths?.collapsed?.[1]).toBe(114)
    // Expanded keeps widths of its own
    fireEvent.click(tool('Expand table'))
    expect(table.style.tableLayout).toBe('')
    expect(cells(1)[0].style.width).toBe('')
  })

  it('opens the row of a cut cell on a click, and shows every cell in full', () => {
    show()
    const table = screen.getByRole('table')
    const cell = table.querySelector('tbody [data-cell]') as HTMLElement
    const row = cell.closest('tr') as HTMLElement
    // A cell that fits does not open its row
    fireEvent.click(cell)
    expect(row).not.toHaveAttribute('data-open')
    cell.setAttribute('data-clamped', '')
    fireEvent.click(cell)
    expect(row).toHaveAttribute('data-open')
    fireEvent.click(cell)
    expect(row).not.toHaveAttribute('data-open')
    fireEvent.click(tool('Show cells in full'))
    expect(table).toHaveClass('md-unclamped')
    expect(row).not.toHaveAttribute('data-open')
    expect(readTablePrefs(KEY)).toEqual({ unclamped: true })
    // Nothing to open while every cell shows
    fireEvent.click(cell)
    expect(row).not.toHaveAttribute('data-open')
  })

  it('marks the cells taller than their box as cut', () => {
    const heights = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.textContent === 'long' ? 300 : 0
      })
    show()
    const [short, long] = [...document.querySelectorAll('[data-cell]')].filter(
      (c) => ['short', 'long'].includes(c.textContent ?? ''),
    )
    expect(long).toHaveAttribute('data-clamped')
    expect(short).not.toHaveAttribute('data-clamped')
    heights.mockRestore()
  })

  it('shows the table full screen, closed by its button', async () => {
    show()
    fireEvent.click(tool('Open table full screen'))
    const dialog = screen.getByRole('dialog', { name: 'Table in specs.md' })
    const full = screen.getByTestId('table-full-screen')
    expect(full.querySelector('table')).toHaveClass('md-expanded')
    expect(dialog).toContainElement(
      screen.getAllByRole('button', { name: 'Show cells in full' })[1],
    )
    const pop = popped()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await pop
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('follows a link from full screen once it has closed', async () => {
    const { onFollow } = show()
    fireEvent.click(tool('Open table full screen'))
    const full = screen.getByTestId('table-full-screen')
    const link = [...full.querySelectorAll('button')].find(
      (b) => b.textContent === 'two',
    ) as HTMLElement
    const pop = popped()
    fireEvent.click(link)
    expect(onFollow).not.toHaveBeenCalled()
    await pop
    expect(onFollow).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'docs/two.md' }),
      expect.any(Number),
      { newTab: false },
    )
  })
})
