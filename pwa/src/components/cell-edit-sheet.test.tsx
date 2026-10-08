import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CellEditSheet } from './cell-edit-sheet'

vi.mock('../hooks/use-media-query', () => ({
  useIsMobile: () => false,
  useMediaQuery: () => false,
}))

function show(value: string) {
  const props = {
    cell: { row: 2, name: 'price', value },
    onApply: vi.fn(),
    onInsertBelow: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    notify: vi.fn(),
  }
  return { ...props, ...render(<CellEditSheet {...props} />) }
}

const box = () => screen.getByRole('textbox', { name: 'Value' })

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})
afterEach(() => vi.unstubAllGlobals())

describe('CellEditSheet', () => {
  it('shows nothing without a cell', () => {
    render(
      <CellEditSheet
        onApply={vi.fn()}
        onInsertBelow={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('edits the whole value, lines included, and applies it', () => {
    const p = show('two\nlines')
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 3 · price')
    expect(box()).toHaveValue('two\nlines')
    fireEvent.change(box(), { target: { value: 'a, "b"' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(p.onApply).toHaveBeenCalledWith('a, "b"')
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('Cancel, Add row below and Delete row hand on', () => {
    const p = show('x')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(p.onClose).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add row below' }))
    expect(p.onInsertBelow).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete row' }))
    expect(p.onDelete).toHaveBeenCalled()
  })

  it('shows characters that hide or reorder text', () => {
    show('ok\r\nfine')
    expect(screen.queryByText(/Hidden characters/)).toBeNull()
    fireEvent.change(box(), { target: { value: '0001‮' } })
    expect(screen.getByText(/Hidden characters/)).toHaveTextContent(
      'Hidden characters: 0001⟨U+202E⟩',
    )
  })

  it('copies the value typed', async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('no'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const p = show('x')
    fireEvent.change(box(), { target: { value: 'y' } })
    const copy = screen.getByRole('button', { name: 'Copy value' })
    await act(async () => fireEvent.click(copy))
    expect(writeText).toHaveBeenCalledWith('y')
    expect(p.notify).toHaveBeenLastCalledWith('Value copied')
    await act(async () => fireEvent.click(copy))
    expect(p.notify).toHaveBeenLastCalledWith('Could not copy the value')
  })
})
