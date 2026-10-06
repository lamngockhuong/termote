import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { FOCUS_RING } from './ui/button'

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger'

// A button next to the message; pressing it closes the toast, then runs it.
export type ToastAction = { label: string; onClick: () => void }

interface Props {
  message: string
  onClose: () => void
  duration?: number
  variant?: ToastVariant
  action?: ToastAction
}

const VARIANTS = {
  info: { icon: Info, color: 'text-info' },
  success: { icon: CircleCheck, color: 'text-success' },
  warning: { icon: TriangleAlert, color: 'text-warning' },
  danger: { icon: CircleAlert, color: 'text-danger' },
}

// The fade-out starts this long before onClose, so the toast is gone when the
// parent unmounts it.
const EXIT_MS = 150

// A short message near the top of the screen: the toolbar and the keys sit at
// the bottom, and a toast there would cover what the user is about to press.
export function Toast({
  message,
  onClose,
  duration = 4000,
  variant = 'info',
  action,
}: Props) {
  const [leaving, setLeaving] = useState(false)
  // Callers pass an inline onClose; depending on it would restart the timer
  // (and bring a fading toast back) on every parent render.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message restarts the timer
  useEffect(() => {
    setLeaving(false)
    const leave = setTimeout(() => setLeaving(true), duration - EXIT_MS)
    const timer = setTimeout(() => onCloseRef.current(), duration)
    return () => {
      clearTimeout(leave)
      clearTimeout(timer)
    }
  }, [message, duration])

  const { icon: Icon, color } = VARIANTS[variant]

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.5rem)] z-50 flex justify-center px-4">
      <div
        // An error interrupts; anything else waits its turn
        role={variant === 'danger' ? 'alert' : 'status'}
        data-variant={variant}
        className={`flex max-w-[85vw] items-center gap-2 rounded-panel border border-border bg-surface-raised px-4 py-3 text-sm text-fg shadow-lg transition-[opacity,translate] duration-(--duration-base) ease-emphasized starting:opacity-0 motion-safe:starting:-translate-y-2 ${leaving ? 'opacity-0 motion-safe:-translate-y-2' : ''}`}
      >
        <Icon size={16} aria-hidden="true" className={`shrink-0 ${color}`} />
        <span className="min-w-0 break-words">{message}</span>
        {action && (
          <button
            type="button"
            // Closed first: the action may show the next toast.
            onClick={() => {
              onCloseRef.current()
              action.onClick()
            }}
            className={`pointer-events-auto shrink-0 rounded-control px-2 py-1 font-medium text-accent hover:bg-surface ${FOCUS_RING}`}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  )
}
