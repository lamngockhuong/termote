import { MoreHorizontal } from 'lucide-react'
import { Menu, MenuItem, MenuSeparator } from './ui/menu'

interface Props {
  // The column's name as shown
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  // Asked from a cell: its row's actions come first
  fromCell: boolean
  // The last column cannot go; a column is renamed in the header row only
  canDelete: boolean
  canRename: boolean
  onInsertRow: (side: 'above' | 'below') => void
  onInsertColumn: (side: 'left' | 'right') => void
  onDeleteColumn: () => void
  onRename: () => void
}

// The actions of a column of a table being edited, from the ⋯ of its name or
// the context menu key on one of its cells (with that cell's row).
export function TableColumnMenu({
  name,
  open,
  onOpenChange,
  fromCell,
  canDelete,
  canRename,
  onInsertRow,
  onInsertColumn,
  onDeleteColumn,
  onRename,
}: Props) {
  return (
    <Menu
      label={`Column ${name}`}
      trigger={<MoreHorizontal size={15} aria-hidden="true" />}
      triggerSize="sm"
      // The keys of its cells open it: no Tab stop of its own
      triggerTabIndex={-1}
      align="start"
      open={open}
      onOpenChange={onOpenChange}
    >
      {fromCell && (
        <>
          <MenuItem onSelect={() => onInsertRow('above')}>
            Insert row above
          </MenuItem>
          <MenuItem onSelect={() => onInsertRow('below')}>
            Insert row below
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      <MenuItem onSelect={() => onInsertColumn('left')}>
        Insert column left
      </MenuItem>
      <MenuItem onSelect={() => onInsertColumn('right')}>
        Insert column right
      </MenuItem>
      {canRename && <MenuItem onSelect={onRename}>Rename column</MenuItem>}
      <MenuItem danger disabled={!canDelete} onSelect={onDeleteColumn}>
        Delete column
      </MenuItem>
    </Menu>
  )
}
