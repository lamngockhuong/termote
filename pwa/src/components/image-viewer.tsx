import { Maximize, Minus, Plus, X } from 'lucide-react'
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useDialogModal } from '../hooks/use-dialog-modal'
import { useExitTransition } from '../hooks/use-exit-transition'
import { useHistoryClose } from '../hooks/use-history-close'
import { useRestoreFocus } from '../hooks/use-restore-focus'
import { useZoomPan } from '../hooks/use-zoom-pan'
import { useT } from '../i18n/i18n-context'
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
// How long a message of an action stays in the bottom bar: a toast would be
// under this modal dialog
export const STATUS_MS = 4000

interface Props {
  // False once closed: it fades out, then leaves
  isOpen: boolean
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
  // Takes focus on close when what opened the viewer is gone
  returnFocus?: RefObject<HTMLElement | null>
  // Buttons for a bar at the bottom, given the way to tell the user
  // something there. Not in the top bar: on a phone its zoom buttons
  // already take most of the width.
  actions?: (say: (message: string) => void) => ReactNode
  onClose: () => void
}

// An image full screen: pinch, drag and double tap on a phone; wheel, drag,
// buttons and + - 0 on a desktop. Back closes it (its own history entry), as
// do X and Escape; focus then returns to what opened it, and it fades out.
export default function ImageViewer({ isOpen, ...rest }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { mounted, closing } = useExitTransition(isOpen, dialogRef)
  if (!mounted) return null
  return <OpenViewer dialogRef={dialogRef} closing={closing} {...rest} />
}

function OpenViewer({
  dialogRef,
  closing,
  src,
  alt,
  width,
  height,
  isSvg,
  stale = false,
  returnFocus,
  actions,
  onClose,
}: Omit<Props, 'isOpen'> & {
  dialogRef: RefObject<HTMLDialogElement | null>
  closing: boolean
}) {
  const { t } = useT()
  const stageRef = useRef<HTMLDivElement>(null)
  const restoreFocus = useRestoreFocus(returnFocus)
  const close = useHistoryClose(onClose)
  useDialogModal(dialogRef, !closing, close)
  // No longer modal once closing: focus goes back without waiting for the fade
  useEffect(() => {
    if (closing) restoreFocus()
  }, [closing, restoreFocus])
  useEffect(() => {
    if (stale) close()
  }, [stale, close])
  const [natural, setNatural] = useState<Size | null>(
    width && height ? { width, height } : null,
  )
  const size = natural ?? { width: 1, height: 1 }
  const { view, settled, zoom, zoomBy, reset } = useZoomPan(stageRef, size)
  const [status, setStatus] = useState<string | null>(null)
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(statusTimer.current), [])
  const say = useCallback((message: string) => {
    clearTimeout(statusTimer.current)
    setStatus(message)
    statusTimer.current = setTimeout(() => setStatus(null), STATUS_MS)
  }, [])

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
      inert={closing}
      data-closing={closing || undefined}
      className={`fixed inset-0 z-50 m-0 h-(--app-height) max-h-none w-screen max-w-none flex-col overflow-hidden bg-bg p-0 text-fg outline-none open:flex backdrop:bg-overlay exit-discrete ease-standard starting:opacity-0 backdrop:exit-discrete backdrop:ease-standard backdrop:starting:opacity-0 ${closing ? 'pointer-events-none opacity-0 duration-(--duration-fast) backdrop:opacity-0 backdrop:duration-(--duration-fast)' : 'duration-(--duration-base) backdrop:duration-(--duration-base)'}`}
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
          aria-label={t('files.zoom.out')}
          title={t('files.zoom.outKey')}
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
          aria-label={t('files.zoom.in')}
          title={t('files.zoom.inKey')}
        >
          <Plus size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          onClick={reset}
          aria-label={t('files.zoom.fit')}
          title={t('files.zoom.fitKey')}
        >
          <Maximize size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          onClick={close}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <X size={18} aria-hidden="true" />
        </IconButton>
      </div>
      <div
        ref={stageRef}
        data-testid="viewer-stage"
        className={`relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing ${actions ? '' : 'pb-safe'}`}
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
      {actions && (
        <div className="flex shrink-0 items-center gap-1 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] pl-3">
          <span
            role="status"
            className="min-w-0 flex-1 truncate text-[13px] text-fg-muted"
          >
            {status}
          </span>
          {actions(say)}
        </div>
      )}
    </dialog>
  )
}
