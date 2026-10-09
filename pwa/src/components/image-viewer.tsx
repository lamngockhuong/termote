import { Maximize, Minus, Plus, X } from 'lucide-react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { useDialogModal } from '../hooks/use-dialog-modal'
import { useHistoryClose } from '../hooks/use-history-close'
import { useRestoreFocus } from '../hooks/use-restore-focus'
import { useZoomPan } from '../hooks/use-zoom-pan'
import type { Size } from '../utils/zoom-pan'
import { IconButton } from './ui/button'

// One step of the buttons and the + / - keys
const STEP = 1.25
// Keys of the viewer: the zoom factor of each, 0 for Fit (= is + unshifted)
const KEY_STEPS: Record<string, number> = {
  '+': STEP,
  '=': STEP,
  '-': 1 / STEP,
  '0': 0,
}

interface Props {
  // The URL already on screen (data: or blob:): never read again
  src: string
  // The image's name, from the app (never text inside the image)
  alt: string
  // Its own size, when the caller knows it; else read once it loads
  width?: number
  height?: number
  // Drawn again at its size once a gesture ends, so it stays sharp
  isSvg: boolean
  // The image where it was opened shows another URL now (this one may be
  // revoked): closes, as X does
  stale?: boolean
  onClose: () => void
}

// An image full screen: pinch, drag and double tap on a phone; wheel, drag,
// buttons and + - 0 on a desktop. Back closes it (its own history entry), as
// do X and Escape; focus then returns to what opened it. Mounted only while
// open.
export default function ImageViewer({
  src,
  alt,
  width,
  height,
  isSvg,
  stale = false,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  useRestoreFocus()
  const close = useHistoryClose(onClose)
  useDialogModal(dialogRef, true, close)
  useEffect(() => {
    if (stale) close()
  }, [stale, close])
  const [natural, setNatural] = useState<Size | null>(
    width && height ? { width, height } : null,
  )
  const size = natural ?? { width: 1, height: 1 }
  const { view, settled, zoom, zoomBy, reset } = useZoomPan(stageRef, size)

  let style: CSSProperties = { visibility: 'hidden' }
  if (natural && view) {
    const at = `translate(${view.x}px, ${view.y}px)`
    style =
      isSvg && settled
        ? {
            width: natural.width * view.scale,
            height: natural.height * view.scale,
            transform: at,
          }
        : {
            width: natural.width,
            height: natural.height,
            transform: `${at} scale(${view.scale})`,
          }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={alt}
      className="fixed inset-0 z-50 m-0 h-(--app-height) max-h-none w-screen max-w-none flex-col overflow-hidden bg-bg p-0 text-fg outline-none open:flex backdrop:bg-overlay"
      onKeyDown={(e) => {
        // Ctrl/Cmd with + - 0 is the browser's own zoom: left to it
        if (e.ctrlKey || e.metaKey || e.altKey) return
        const step = KEY_STEPS[e.key]
        if (step === undefined) return
        e.preventDefault()
        if (step) zoomBy(step)
        else reset()
      }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface pt-[env(safe-area-inset-top)] pl-3">
        <span className="min-w-0 flex-1 truncate text-[13px]">{alt}</span>
        <IconButton
          onClick={() => zoomBy(1 / STEP)}
          aria-label="Zoom out"
          title="Zoom out (-)"
        >
          <Minus size={16} aria-hidden="true" />
        </IconButton>
        <span
          className="w-12 text-center text-[12px] tabular-nums text-fg-muted"
          aria-live="polite"
          // Read out once a gesture ends, not at every step of a pinch
          aria-busy={!settled}
        >
          {Math.round(zoom * 100)}%
        </span>
        <IconButton
          onClick={() => zoomBy(STEP)}
          aria-label="Zoom in"
          title="Zoom in (+)"
        >
          <Plus size={16} aria-hidden="true" />
        </IconButton>
        <IconButton onClick={reset} aria-label="Fit" title="Fit (0)">
          <Maximize size={16} aria-hidden="true" />
        </IconButton>
        <IconButton onClick={close} aria-label="Close" title="Close">
          <X size={18} aria-hidden="true" />
        </IconButton>
      </div>
      <div
        ref={stageRef}
        data-testid="viewer-stage"
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden pb-safe select-none active:cursor-grabbing"
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="absolute top-0 left-0 max-w-none origin-top-left"
          style={style}
          onLoad={(e) => {
            if (natural) return
            const img = e.currentTarget
            const stage = stageRef.current as HTMLElement
            // An SVG without a size of its own takes the stage's
            setNatural({
              width: img.naturalWidth || stage.clientWidth,
              height: img.naturalHeight || stage.clientHeight,
            })
          }}
        />
      </div>
    </dialog>
  )
}
