import { Maximize2, Minimize2 } from 'lucide-react'
import {
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  clampPanelWidth,
  maxPanelWidth,
  SIDE_PANEL_DEFAULT,
  SIDE_PANEL_MIN,
  SIDE_PANEL_STEP,
} from '../utils/side-panel-width'
import { IconButton } from './ui/button'

interface PanelState {
  maximized: boolean
  toggleMaximized: () => void
}

// Set only inside the desktop side panel: the same views in the main area
// (mobile) have nothing to maximize.
const SidePanelContext = createContext<PanelState | null>(null)

interface Props {
  label: string
  // Saved width; the panel shows it within the limits of its row
  width: unknown
  onWidthChange: (width: number) => void
  maximized: boolean
  onMaximizedChange: (maximized: boolean) => void
  // True while the handle is dragged: the terminal next to the panel keeps
  // its size until the drag ends, so the tmux pane is resized once.
  onResizingChange: (resizing: boolean) => void
  children: ReactNode
}

// The desktop side panel (Files, Changes): resized from a handle on its left
// edge, or maximized over the main area. The row it sits in must be
// positioned (relative) for the maximized panel to cover it.
export function SidePanel({
  label,
  width,
  onWidthChange,
  maximized,
  onMaximizedChange,
  onResizingChange,
  children,
}: Props) {
  const asideRef = useRef<HTMLElement>(null)
  // Width of the row the panel shares with the main area: null until
  // measured, and with no ResizeObserver (tests) the panel has no maximum.
  const [rowWidth, setRowWidth] = useState<number | null>(null)
  // Before paint: a saved width too wide for the row never shows first.
  useLayoutEffect(() => {
    const row = asideRef.current?.parentElement
    if (!row || typeof ResizeObserver === 'undefined') return
    setRowWidth(row.clientWidth)
    const ro = new ResizeObserver(() => setRowWidth(row.clientWidth))
    ro.observe(row)
    return () => ro.disconnect()
  }, [])

  // While dragging, only this follows the pointer; it is saved on release.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const drag = useRef<{ x: number; width: number; last: number } | null>(null)
  const shown = clampPanelWidth(dragWidth ?? width, rowWidth)
  const max = maxPanelWidth(rowWidth)

  // A drag cut short by an unmount must not leave the terminal held.
  const resizingRef = useRef(onResizingChange)
  resizingRef.current = onResizingChange
  useEffect(
    () => () => {
      if (drag.current) resizingRef.current(false)
    },
    [],
  )

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // No text selection while dragging
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { x: e.clientX, width: shown, last: shown }
    setDragWidth(shown)
    onResizingChange(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    // The handle is on the left edge: moving left widens the panel.
    d.last = clampPanelWidth(d.width + d.x - e.clientX, rowWidth)
    setDragWidth(d.last)
  }
  const endDrag = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (d.last !== d.width) onWidthChange(d.last)
    setDragWidth(null)
    onResizingChange(false)
  }

  // Arrow keys step, Home/End go to the limits. Each step is saved at once:
  // the terminal waits for the size to settle before it is fitted again.
  const onHandleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number
    if (e.key === 'ArrowLeft') next = shown + SIDE_PANEL_STEP
    else if (e.key === 'ArrowRight') next = shown - SIDE_PANEL_STEP
    else if (e.key === 'Home') next = SIDE_PANEL_MIN
    else if (e.key === 'End' && Number.isFinite(max)) next = max
    else return
    e.preventDefault()
    const clamped = clampPanelWidth(next, rowWidth)
    if (clamped !== shown) onWidthChange(clamped)
  }

  // Escape restores a maximized panel, wherever the focus is (a click on the
  // panel's background leaves it on the body), unless something used the key
  // first: a dialog, or a list or field that calls preventDefault on it.
  const restoreRef = useRef(onMaximizedChange)
  restoreRef.current = onMaximizedChange
  useEffect(() => {
    if (!maximized) return
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (e.target instanceof Element && e.target.closest('dialog')) return
      restoreRef.current(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [maximized])

  const state: PanelState = {
    maximized,
    toggleMaximized: () => onMaximizedChange(!maximized),
  }
  return (
    <aside
      ref={asideRef}
      aria-label={label}
      style={maximized ? undefined : { width: shown }}
      className={`flex flex-col bg-bg ${
        maximized
          ? 'absolute inset-0 z-20'
          : 'relative shrink-0 border-l border-border'
      }`}
    >
      {!maximized && (
        // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focused or dragged
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label}`}
          aria-valuenow={shown}
          aria-valuemin={SIDE_PANEL_MIN}
          aria-valuemax={Number.isFinite(max) ? max : undefined}
          tabIndex={0}
          title="Drag to resize, double-click to reset"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={() => onWidthChange(SIDE_PANEL_DEFAULT)}
          onKeyDown={onHandleKeyDown}
          className={`absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none outline-none hover:bg-accent/40 focus-visible:bg-accent ${
            dragWidth !== null ? 'bg-accent/40' : ''
          }`}
        />
      )}
      <SidePanelContext.Provider value={state}>
        {children}
      </SidePanelContext.Provider>
    </aside>
  )
}

// Maximize/restore button for a view's header; nothing outside the side
// panel.
export function PanelMaximizeButton() {
  const panel = useContext(SidePanelContext)
  if (!panel) return null
  const label = panel.maximized ? 'Restore panel' : 'Maximize panel'
  const Icon = panel.maximized ? Minimize2 : Maximize2
  return (
    <IconButton
      size="sm"
      variant="ghost"
      onClick={panel.toggleMaximized}
      aria-label={label}
      title={panel.maximized ? `${label} (Esc)` : label}
    >
      <Icon size={15} aria-hidden="true" />
    </IconButton>
  )
}
