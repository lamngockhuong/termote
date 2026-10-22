import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TableColumnMenu } from './table-column-menu'

function menu(
  over: Record<string, unknown> = {},
  editOver: Record<string, unknown> | null = {},
) {
  const edit = editOver && {
    fromCell: false,
    canDelete: true,
    canRename: true,
    onInsertRow: vi.fn(),
    onInsertColumn: vi.fn(),
    onDeleteColumn: vi.fn(),
    onRename: vi.fn(),
    ...editOver,
  }
  const props = {
    name: 'price',
    open: true,
    onOpenChange: vi.fn(),
    pinned: false,
    canHide: true,
    onPin: vi.fn(),
    onHide: vi.fn(),
    ...over,
    edit: edit ?? undefined,
  }
  render(<TableColumnMenu {...props} />)
  return { ...props, ...(edit as NonNullable<typeof edit>) }
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
    const p = menu({}, { fromCell: true })
    fireEvent.click(item('Insert row above'))
    expect(p.onInsertRow).toHaveBeenLastCalledWith('above')
    fireEvent.click(item('Insert row below'))
    expect(p.onInsertRow).toHaveBeenLastCalledWith('below')
  })

  it('no rename without a header row; the last column cannot go', () => {
    menu({}, { canRename: false, canDelete: false })
    expect(screen.queryByRole('menuitem', { name: 'Rename column' })).toBeNull()
    expect(item('Delete column')).toBeDisabled()
  })

  it('pins, unpins and hides the column; the last one shown stays', () => {
    const p = menu()
    expect(item('Pin column')).toHaveAttribute(
      'title',
      expect.stringMatching(/half/),
    )
    fireEvent.click(item('Pin column'))
    expect(p.onPin).toHaveBeenCalledTimes(1)
    fireEvent.click(item('Hide column'))
    expect(p.onHide).toHaveBeenCalledTimes(1)
  })

  it('pinned, offers to unpin it; the last column shown cannot be hidden', () => {
    menu({ pinned: true, canHide: false })
    expect(item('Unpin column')).toBeEnabled()
    expect(screen.queryByRole('menuitem', { name: 'Pin column' })).toBeNull()
    expect(item('Hide column')).toBeDisabled()
  })

  it('a table only viewed: how the column is shown, no edits', () => {
    menu({}, null)
    expect(item('Pin column')).toBeEnabled()
    expect(item('Hide column')).toBeEnabled()
    expect(
      screen.queryByRole('menuitem', { name: /Insert|Rename|Delete/ }),
    ).toBeNull()
  })
})
