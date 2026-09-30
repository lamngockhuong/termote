import { useRef } from 'react'
import { useDialogModal } from '../hooks/use-dialog-modal'
import { Button } from './ui/button'

interface Props {
  isOpen: boolean
  onDismiss: () => void
}

const GESTURE_HINTS = [
  { icon: '👈', gesture: 'Swipe Left', action: 'Cancel (Ctrl+C)' },
  { icon: '👉', gesture: 'Swipe Right', action: 'Tab completion' },
  { icon: '👆👇', gesture: 'Swipe Up/Down', action: 'Scroll history' },
  { icon: '👆', gesture: 'Long Press', action: 'Paste clipboard (limited*)' },
  { icon: '🤏', gesture: 'Pinch In/Out', action: 'Font size' },
]

export function GestureHintsOverlay({ isOpen, onDismiss }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useDialogModal(dialogRef, isOpen, onDismiss)

  if (!isOpen) return null

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-50 m-auto w-[90vw] max-w-sm rounded-sheet border border-border bg-bg p-0 text-fg shadow-xl backdrop:bg-overlay transition-[opacity,scale] duration-(--duration-base) ease-emphasized starting:opacity-0 motion-safe:starting:scale-95 ui-native:border-0 ui-native:bg-surface"
      aria-labelledby="gesture-hints-title"
    >
      <div className="p-6">
        <h2
          id="gesture-hints-title"
          className="m-0 mb-2 text-center text-2xl font-bold ui-terminal:font-label ui-terminal:text-lg ui-terminal:uppercase ui-terminal:tracking-wider"
        >
          Touch Gestures
        </h2>
        <p className="mb-6 mt-0 text-center text-sm text-fg-muted">
          Control the terminal with gestures
        </p>

        <div className="mb-8 space-y-3">
          {GESTURE_HINTS.map((hint) => (
            <div
              key={hint.gesture}
              className="flex items-center gap-4 rounded-panel bg-surface px-4 py-3 ui-native:bg-bg"
            >
              <span className="w-10 text-center text-2xl" aria-hidden="true">
                {hint.icon}
              </span>
              <div className="flex-1">
                <div className="font-medium text-fg">{hint.gesture}</div>
                <div className="text-sm text-fg-muted">{hint.action}</div>
              </div>
            </div>
          ))}
        </div>

        <Button variant="primary" className="w-full" onClick={onDismiss}>
          Got it
        </Button>

        <p className="mb-0 mt-4 text-center text-xs text-fg-subtle">
          *Long press paste may not work. Use the Paste button instead.
        </p>
        <p className="mb-0 mt-2 text-center text-xs text-fg-subtle">
          View anytime in Settings &gt; Show Gesture Hints
        </p>
      </div>
    </dialog>
  )
}
