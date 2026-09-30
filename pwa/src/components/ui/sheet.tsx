import { X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useId, useRef } from 'react'
import { useDialogModal } from '../../hooks/use-dialog-modal'
import { useIsMobile } from '../../hooks/use-media-query'
import { IconButton } from './button'

interface Props {
  isOpen: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  // Accessible name of the close button
  closeLabel?: string
  // Extra controls in the header, before the close button
  actions?: ReactNode
  className?: string
}

// A modal <dialog>: a bottom sheet on phones, a centred dialog on desktop.
// Escape, the close button and a tap on the scrim close it; focus returns to
// whatever had it when the sheet opened.
export function Sheet({ isOpen, onClose, ...rest }: Props) {
  if (!isOpen) return null
  return <OpenSheet onClose={onClose} {...rest} />
}

function OpenSheet({
  onClose,
  title,
  children,
  closeLabel = 'Close',
  actions,
  className = '',
}: Omit<Props, 'isOpen'>) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const isMobile = useIsMobile()

  // Declared before useDialogModal: the opener still has focus here, before
  // showModal moves it into the dialog.
  useEffect(() => {
    const opener = document.activeElement
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])
  // A stable callback: callers pass inline functions, and a new one would
  // re-run useDialogModal (showModal on an open dialog, listener churn).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const close = useCallback(() => onCloseRef.current(), [])
  useDialogModal(dialogRef, true, close)
  // Only a press that starts and ends on the scrim closes the sheet; a text
  // selection dragged out of the content ends with a click on the dialog too.
  const pressedScrim = useRef(false)

  const layout = isMobile
    ? 'mb-0 mt-auto max-h-[90dvh] w-full max-w-none rounded-t-sheet border-t border-border pb-safe starting:translate-y-8'
    : 'm-auto max-h-[85vh] w-[90vw] max-w-lg rounded-sheet border border-border starting:scale-95'

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      data-layout={isMobile ? 'sheet' : 'dialog'}
      className={`fixed inset-0 z-50 flex-col overflow-hidden bg-bg p-0 text-fg shadow-xl backdrop:bg-overlay open:flex transition-[opacity,translate,scale] duration-(--duration-base) ease-emphasized starting:opacity-0 ui-native:border-0 ui-native:bg-surface ${layout} ${className}`}
      onPointerDown={(e) => {
        pressedScrim.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (pressedScrim.current && e.target === e.currentTarget) close()
      }}
    >
      {isMobile && (
        <div
          aria-hidden="true"
          data-testid="sheet-grabber"
          className="hidden justify-center pt-2 ui-native:flex"
        >
          <span className="h-1.5 w-10 rounded-full bg-border-strong" />
        </div>
      )}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4 ui-native:border-0">
        <h2
          id={titleId}
          className="m-0 truncate text-[17px] font-semibold ui-terminal:font-label ui-terminal:text-[14px] ui-terminal:uppercase ui-terminal:tracking-wider"
        >
          {title}
        </h2>
        <div className="flex items-center gap-1">
          {actions}
          <IconButton aria-label={closeLabel} onClick={close}>
            <X size={18} aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </dialog>
  )
}
