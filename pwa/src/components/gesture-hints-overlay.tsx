import { useEffect, useRef } from 'react'

interface Props {
  isOpen: boolean
  onDismiss: () => void
}

const GESTURE_HINTS = [
  { icon: '👈', gesture: 'Swipe Left', action: 'Cancel (Ctrl+C)' },
  { icon: '👉', gesture: 'Swipe Right', action: 'Tab completion' },
  { icon: '👆👇', gesture: 'Swipe Up/Down', action: 'Scroll in copy mode' },
  { icon: '👆', gesture: 'Long Press', action: 'Paste clipboard (limited*)' },
  { icon: '🤏', gesture: 'Pinch In/Out', action: 'Font size' },
]

export function GestureHintsOverlay({ isOpen, onDismiss }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (isOpen) {
      dialog.showModal()
      const handleCancel = (e: Event) => {
        e.preventDefault()
        onDismiss()
      }
      dialog.addEventListener('cancel', handleCancel)
      return () => dialog.removeEventListener('cancel', handleCancel)
    } else {
      dialog.close()
    }
  }, [isOpen, onDismiss])

  if (!isOpen) return null

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-50 m-auto w-[90vw] max-w-sm bg-transparent p-0 backdrop:bg-black/80"
      aria-labelledby="gesture-hints-title"
    >
      <div className="p-6">
        <h2
          id="gesture-hints-title"
          className="text-2xl font-bold text-white text-center mb-2"
        >
          Touch Gestures
        </h2>
        <p className="text-zinc-400 text-center text-sm mb-6">
          Control the terminal with gestures
        </p>

        <div className="space-y-3 mb-8">
          {GESTURE_HINTS.map((hint) => (
            <div
              key={hint.gesture}
              className="flex items-center gap-4 bg-white/10 rounded-xl px-4 py-3"
            >
              <span className="text-2xl w-10 text-center" aria-hidden="true">
                {hint.icon}
              </span>
              <div className="flex-1">
                <div className="text-white font-medium">{hint.gesture}</div>
                <div className="text-zinc-400 text-sm">{hint.action}</div>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={onDismiss}
          className="w-full py-3 bg-blue-500 hover:bg-blue-600 text-white font-medium rounded-xl transition-colors"
        >
          Got it
        </button>

        <p className="text-zinc-500 text-xs text-center mt-4">
          *Long press paste may not work. Use the Paste button instead.
        </p>
        <p className="text-zinc-500 text-xs text-center mt-2">
          View anytime in Settings &gt; Show Gesture Hints
        </p>
      </div>
    </dialog>
  )
}
