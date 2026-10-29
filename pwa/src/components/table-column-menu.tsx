import { MoreHorizontal } from 'lucide-react'
import { useT } from '../i18n/i18n-context'
import { Menu, MenuItem, MenuSeparator } from './ui/menu'

// The actions that change the file, offered while the table is edited
export interface ColumnEdits {
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

interface Props {
  // The column's name as shown
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  // The column is the one pinned; the last column shown cannot be hidden
  pinned: boolean
  canHide: boolean
  onPin: () => void
  onHide: () => void
  edit?: ColumnEdits
}

// The actions of a column, from the ⋯ of its name, or while the table is
// edited the context menu key on one of its cells (with that cell's row):
// how it is shown, then the edits.
export function TableColumnMenu({
  name,
  open,
  onOpenChange,
  pinned,
  canHide,
  onPin,
  onHide,
  edit,
}: Props) {
  const { t } = useT()
  return (
    <Menu
      label={t('files.columnMenu.label', { name })}
      trigger={<MoreHorizontal size={15} aria-hidden="true" />}
      triggerSize="sm"
      // The keys of its cells open it: no Tab stop of its own
      triggerTabIndex={-1}
      align="start"
      open={open}
      onOpenChange={onOpenChange}
    >
      {edit?.fromCell && (
        <>
          <MenuItem onSelect={() => edit.onInsertRow('above')}>
            {t('files.columnMenu.rowAbove')}
          </MenuItem>
          <MenuItem onSelect={() => edit.onInsertRow('below')}>
            {t('files.columnMenu.rowBelow')}
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      <MenuItem
        title={pinned ? undefined : t('files.columnMenu.pinTitle')}
        onSelect={onPin}
      >
        {pinned ? t('files.columnMenu.unpin') : t('files.columnMenu.pin')}
      </MenuItem>
      <MenuItem disabled={!canHide} onSelect={onHide}>
        {t('files.columnMenu.hide')}
      </MenuItem>
      {edit && (
        <>
          <MenuSeparator />
          <MenuItem onSelect={() => edit.onInsertColumn('left')}>
            {t('files.columnMenu.left')}
          </MenuItem>
          <MenuItem onSelect={() => edit.onInsertColumn('right')}>
            {t('files.columnMenu.right')}
          </MenuItem>
          {edit.canRename && (
            <MenuItem onSelect={edit.onRename}>
              {t('files.columnMenu.rename')}
            </MenuItem>
          )}
          <MenuItem
            danger
            disabled={!edit.canDelete}
            onSelect={edit.onDeleteColumn}
          >
            {t('files.table.deleteColumn')}
          </MenuItem>
        </>
      )}
    </Menu>
  )
}
