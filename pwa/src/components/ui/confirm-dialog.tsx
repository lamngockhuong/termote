import type { ReactNode } from 'react'
import { Button } from './button'
import { Sheet } from './sheet'

interface Props {
  isOpen: boolean
  title: ReactNode
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  // A destructive action gets the danger colour on its confirm button
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

// Asks before an action that cannot be undone. Escape, the close button, a
// tap on the scrim and Cancel all cancel; only the confirm button confirms.
export function ConfirmDialog({
  isOpen,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Sheet isOpen={isOpen} onClose={onCancel} title={title}>
      <div className="flex flex-col gap-4 p-4">
        <div className="text-sm text-fg-muted">{children}</div>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            className={destructive ? 'border border-danger/40 bg-danger/5' : ''}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
