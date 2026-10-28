import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  Columns2,
  LayoutGrid,
  Maximize2,
  Rows2,
  X,
} from 'lucide-react'
import {
  RequestError,
  type ResizeDirection,
  type SplitDirection,
} from '../hooks/use-mux-api'
import { Menu, MenuGroup, MenuItem, MenuSeparator } from './ui/menu'

// How many cells one Resize item moves the pane's edge
export const RESIZE_STEP = 5

interface Props {
  // Desktop: the Resize items are offered
  desktop: boolean
  // The pane has a pane after it to swap with (on Zellij, which turns the
  // panes around, any other pane)
  canSwapNext: boolean
  // The tab has another pane, so this one can be closed
  canClose: boolean
  onSplit: (direction: SplitDirection) => void
  onZoom: () => void
  onSwapNext: () => void
  onResize: (direction: ResizeDirection) => void
  // Asks to close the pane (the Close pane? confirmation)
  onClose: () => void
}

const ICON = 15

const RESIZE: {
  direction: ResizeDirection
  label: string
  icon: typeof ArrowLeft
}[] = [
  { direction: 'left', label: 'Resize left', icon: ArrowLeft },
  { direction: 'right', label: 'Resize right', icon: ArrowRight },
  { direction: 'up', label: 'Resize up', icon: ArrowUp },
  { direction: 'down', label: 'Resize down', icon: ArrowDown },
]

// The Pane menu of the header: what the pane shown can do to its tab's
// layout. Rendered only where the backend offers it to this device.
export function PaneLayoutMenu(p: Props) {
  return (
    <Menu
      label="Pane"
      trigger={<LayoutGrid size={16} aria-hidden="true" />}
      triggerSize="sm"
      align="end"
    >
      <MenuItem
        icon={<Columns2 size={ICON} />}
        onSelect={() => p.onSplit('right')}
      >
        Split right
      </MenuItem>
      <MenuItem icon={<Rows2 size={ICON} />} onSelect={() => p.onSplit('down')}>
        Split down
      </MenuItem>
      <MenuItem icon={<Maximize2 size={ICON} />} onSelect={p.onZoom}>
        Zoom
      </MenuItem>
      <MenuItem
        icon={<ArrowLeftRight size={ICON} />}
        disabled={!p.canSwapNext}
        onSelect={p.onSwapNext}
      >
        Swap with next pane
      </MenuItem>
      {p.desktop && (
        <MenuGroup label="Resize">
          {RESIZE.map(({ direction, label, icon: Icon }) => (
            <MenuItem
              key={direction}
              icon={<Icon size={ICON} />}
              keepOpen
              onSelect={() => p.onResize(direction)}
            >
              {label}
            </MenuItem>
          ))}
        </MenuGroup>
      )}
      {p.canClose && (
        <>
          <MenuSeparator />
          <MenuItem icon={<X size={ICON} />} danger onSelect={p.onClose}>
            Close pane
          </MenuItem>
        </>
      )}
    </Menu>
  )
}

// The message of a refused layout action, from the server's code
export function paneLayoutMessage(err: unknown): string {
  const code = err instanceof RequestError ? err.code : ''
  switch (code) {
    case 'unknown_pane':
      return 'The pane is gone'
    case 'no_neighbor':
      return 'No pane on that side'
    case 'no_room':
      return 'No room for another pane'
    case 'busy':
      return 'Busy, try again'
    case 'unsupported':
      return 'Not supported for this pane'
    case 'view_only':
      return 'This device is view-only'
  }
  return 'Could not change the panes'
}
