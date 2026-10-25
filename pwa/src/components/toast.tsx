import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { type PointerEvent, useEffect, useRef, useState } from 'react'
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

// A swipe this far up, or to either side, dismisses the toast; a shorter one
// springs back.
const SWIPE_PX = 40
// A dismissing swipe carries on this many times as far while it fades.
const FLING = 3

type Offset = { x: number; y: number }

// A short message near the top of the screen: the toolbar and the keys sit at
// the bottom, and a toast there would cover what the user is about to press.
export function Toast({
  message,
  onClose,
  duration = 4000,
  variant = 'info',
  action,
}: Props) {
  // How the toast is leaving: fading after its time is up, or flung the way
  // it was swiped. Either way it closes EXIT_MS later.
  const [exit, setExit] = useState<'fade' | Offset | null>(null)
  // Where the finger has pulled the toast; null when it is not held.
  const [offset, setOffset] = useState<Offset | null>(null)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const held = offset !== null
  const flung = exit !== null && exit !== 'fade'
  // Callers pass an inline onClose; depending on it would restart the timer
  // (and bring a fading toast back) on every parent render.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message brings the toast back
  useEffect(() => setExit(null), [message])
  // A held toast waits for the finger, and letting go starts its time again;
  // a flung one closes as soon as it has faded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message restarts the timer
  useEffect(() => {
    if (held) return
    const leave = flung
      ? undefined
      : setTimeout(() => setExit('fade'), duration - EXIT_MS)
    const close = setTimeout(
      () => onCloseRef.current(),
      flung ? EXIT_MS : duration,
    )
    return () => {
      clearTimeout(leave)
      clearTimeout(close)
    }
  }, [message, duration, held, flung])

  // Up or sideways only: down would push it over what it sits above.
  const pull = (e: PointerEvent, d: { x: number; y: number }) => ({
    x: e.clientX - d.x,
    y: Math.min(0, e.clientY - d.y),
  })
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // One finger at a time; the action button keeps its own click
    if (e.button !== 0 || drag.current || exit) return
    if (e.target instanceof Element && e.target.closest('button')) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    setOffset({ x: 0, y: 0 })
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d?.id === e.pointerId) setOffset(pull(e, d))
  }
  // An interrupted gesture springs back; only a release can dismiss.
  const endDrag = (e: PointerEvent<HTMLDivElement>, release: boolean) => {
    const d = drag.current
    if (d?.id !== e.pointerId) return
    drag.current = null
    setOffset(null)
    const { x, y } = pull(e, d)
    if (!release || Math.max(Math.abs(x), -y) < SWIPE_PX) return
    setExit(Math.abs(x) > -y ? { x: x * FLING, y: 0 } : { x: 0, y: y * FLING })
  }

  const moved = offset ?? (exit === 'fade' ? null : exit)
  const { icon: Icon, color } = VARIANTS[variant]

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.5rem)] z-50 flex justify-center px-4">
      <div
        // An error interrupts; anything else waits its turn
        role={variant === 'danger' ? 'alert' : 'status'}
        data-variant={variant}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        onLostPointerCapture={(e) => endDrag(e, false)}
        style={
          moved
            ? {
                translate: `${moved.x}px ${moved.y}px`,
                // Follows the finger at once, fading as it nears the threshold
                transition: offset ? 'none' : undefined,
                opacity: offset
                  ? 1 -
                    Math.min(Math.hypot(offset.x, offset.y) / SWIPE_PX, 1) / 2
                  : undefined,
              }
            : undefined
        }
        className={`pointer-events-auto flex max-w-[85vw] touch-none select-none items-center gap-2 rounded-panel border border-border bg-surface-raised px-4 py-3 text-sm text-fg shadow-lg transition-[opacity,translate] duration-(--duration-base) ease-emphasized starting:opacity-0 motion-safe:starting:-translate-y-2 ${exit === 'fade' ? 'opacity-0 motion-safe:-translate-y-2' : exit ? 'opacity-0' : ''}`}
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
            className={`shrink-0 rounded-control px-2 py-1 font-medium text-accent hover:bg-surface ${FOCUS_RING}`}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  )
}
