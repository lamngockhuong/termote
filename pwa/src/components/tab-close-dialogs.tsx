import { visibleUnsafe } from '../utils/unsafe-chars'
import { ConfirmDialog } from './ui/confirm-dialog'

// Asks before a tab with unsaved changes closes (Files, Changes); shown
// while rendered
export function DiscardTabDialog({
  name,
  onConfirm,
  onCancel,
}: {
  // The file's name
  name: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <ConfirmDialog
      isOpen
      title="Discard changes?"
      confirmLabel="Discard"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      Your changes to {visibleUnsafe(name)} will be lost.
    </ConfirmDialog>
  )
}

// Asks what becomes of the tabs with unsaved changes opened under a root the
// pane has left: closed (their changes dropped) or kept
export function RootCloseDialog({
  count,
  onResolve,
}: {
  // How many tabs wait for the answer; none: the box is closed
  count: number
  onResolve: (close: boolean) => void
}) {
  return (
    <ConfirmDialog
      isOpen={count > 0}
      title={`Close ${count === 1 ? 'a file' : `${count} files`} with unsaved changes?`}
      // Not "Close": the sheet's own close button has that name
      confirmLabel="Discard and close"
      cancelLabel="Keep"
      destructive
      onConfirm={() => onResolve(true)}
      onCancel={() => onResolve(false)}
    >
      The pane's directory changed. Closing drops the changes; kept files can no
      longer be saved, but their text can be copied.
    </ConfirmDialog>
  )
}
