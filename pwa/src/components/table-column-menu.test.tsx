import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TableColumnMenu } from './table-column-menu'

function menu(over: Record<string, unknown> = {}) {
  const props = {
    name: 'price',
    open: true,
    onOpenChange: vi.fn(),
    fromCell: false,
    canDelete: true,
    canRename: true,
    onInsertRow: vi.fn(),
    onInsertColumn: vi.fn(),
    onDeleteColumn: vi.fn(),
    onRename: vi.fn(),
    ...over,
  }
  render(<TableColumnMenu {...props} />)
  return props
}

const item = (name: string) => screen.getByRole('menuitem', { name })

describe('TableColumnMenu', () => {
  it('offers the column actions under the column name, out of Tab', () => {
    const p = menu()
    const trigger = screen.getByRole('button', { name: 'Column price' })
    expect(trigger).toHaveAttribute('tabindex', '-1')
    expect(screen.queryByRole('menuitem', { name: /row/ })).toBeNull()
    fireEvent.click(item('Insert column left'))
    expect(p.onInsertColumn).toHaveBeenLastCalledWith('left')
    fireEvent.click(item('Insert column right'))
    expect(p.onInsertColumn).toHaveBeenLastCalledWith('right')
    fireEvent.click(item('Rename column'))
    expect(p.onRename).toHaveBeenCalled()
    fireEvent.click(item('Delete column'))
    expect(p.onDeleteColumn).toHaveBeenCalled()
    // Each choice closes it
    expect(p.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('asked from a cell, offers its row first', () => {
    const p = menu({ fromCell: true })
    fireEvent.click(item('Insert row above'))
    expect(p.onInsertRow).toHaveBeenLastCalledWith('above')
    fireEvent.click(item('Insert row below'))
    expect(p.onInsertRow).toHaveBeenLastCalledWith('below')
  })

  it('no rename without a header row; the last column cannot go', () => {
    menu({ canRename: false, canDelete: false })
    expect(screen.queryByRole('menuitem', { name: 'Rename column' })).toBeNull()
    expect(item('Delete column')).toBeDisabled()
  })
})
