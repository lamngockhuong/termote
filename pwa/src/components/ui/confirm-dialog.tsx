import { type KeyboardEvent, type ReactNode, useRef } from 'react'
import { useIsMobile } from '../../hooks/use-media-query'
import { useT } from '../../i18n/i18n-context'
import { Button } from './button'
import { Sheet } from './sheet'

interface Props {
  isOpen: boolean
  title: ReactNode
  children: ReactNode
  confirmLabel: string
  // Common Cancel when not given
  cancelLabel?: string
  // A destructive action gets the danger colour on its confirm button
  destructive?: boolean
  // The button focused on desktop, so Enter presses it. A second ask that
  // exists to make the user stop and read again passes 'cancel'.
  defaultAction?: 'confirm' | 'cancel'
  onConfirm: () => void
  onCancel: () => void
}

// Asks before an action that cannot be undone. Escape, the close button, a
// tap on the scrim and Cancel all cancel; only the confirm button confirms.
// On desktop the default button holds focus, so Enter answers the dialog.
export function ConfirmDialog({
  isOpen,
  title,
  children,
  confirmLabel,
  cancelLabel,
  destructive = false,
  defaultAction = 'confirm',
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useT()
  const isMobile = useIsMobile()
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // A held Enter that opened the dialog auto-repeats into the focused button
  // and would click it; block the repeats, a real press is a fresh keydown.
  const blockRepeat = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.repeat) e.preventDefault()
  }
  return (
    <Sheet
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      // Not on a phone: focusing a button there draws a focus ring on open
      focusOnOpen={
        isMobile
          ? undefined
          : () =>
              (defaultAction === 'cancel'
                ? cancelRef
                : confirmRef
              ).current?.focus()
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="text-sm text-fg-muted">{children}</div>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} onKeyDown={blockRepeat} onClick={onCancel}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            onKeyDown={blockRepeat}
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
