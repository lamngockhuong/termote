import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  Columns2,
  Maximize2,
  Rows2,
  X,
} from 'lucide-react'
import {
  RequestError,
  type ResizeDirection,
  type SplitDirection,
} from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { Menu, MenuGroup, MenuItem, MenuSeparator } from './ui/menu'

// How many cells one Resize item moves the pane's edge
export const RESIZE_STEP = 5

interface Props {
  // Desktop: the Resize items are offered
  desktop: boolean
  // Zoom, swap and resize are offered: the page shows the tab's layout
  // (not on Herdr, whose stream is one pane)
  arrange: boolean
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
  label: MessageKey
  icon: typeof ArrowLeft
}[] = [
  { direction: 'left', label: 'dialogs.paneMenu.resizeLeft', icon: ArrowLeft },
  {
    direction: 'right',
    label: 'dialogs.paneMenu.resizeRight',
    icon: ArrowRight,
  },
  { direction: 'up', label: 'dialogs.paneMenu.resizeUp', icon: ArrowUp },
  { direction: 'down', label: 'dialogs.paneMenu.resizeDown', icon: ArrowDown },
]

// The Pane menu of the header: what the pane shown can do to its tab's
// layout. Rendered only where the backend offers it to this device.
export function PaneLayoutMenu(p: Props) {
  const { t } = useT()
  return (
    <Menu
      label={t('dialogs.paneMenu.label')}
      trigger={<Columns2 size={16} aria-hidden="true" />}
      triggerSize="sm"
      align="end"
    >
      <MenuItem
        icon={<Columns2 size={ICON} />}
        onSelect={() => p.onSplit('right')}
      >
        {t('dialogs.paneMenu.splitRight')}
      </MenuItem>
      <MenuItem icon={<Rows2 size={ICON} />} onSelect={() => p.onSplit('down')}>
        {t('dialogs.paneMenu.splitDown')}
      </MenuItem>
      {p.arrange && (
        <>
          <MenuItem icon={<Maximize2 size={ICON} />} onSelect={p.onZoom}>
            {t('dialogs.paneMenu.zoom')}
          </MenuItem>
          <MenuItem
            icon={<ArrowLeftRight size={ICON} />}
            disabled={!p.canSwapNext}
            onSelect={p.onSwapNext}
          >
            {t('dialogs.paneMenu.swapNext')}
          </MenuItem>
        </>
      )}
      {p.arrange && p.desktop && (
        <MenuGroup label={t('dialogs.paneMenu.resize')}>
          {RESIZE.map(({ direction, label, icon: Icon }) => (
            <MenuItem
              key={direction}
              icon={<Icon size={ICON} />}
              keepOpen
              onSelect={() => p.onResize(direction)}
            >
              {t(label)}
            </MenuItem>
          ))}
        </MenuGroup>
      )}
      {p.canClose && (
        <>
          <MenuSeparator />
          <MenuItem icon={<X size={ICON} />} danger onSelect={p.onClose}>
            {t('dialogs.paneMenu.close')}
          </MenuItem>
        </>
      )}
    </Menu>
  )
}

// A refused layout action's message, by the server's code; any other code
// is told as the generic failure
const PANE_LAYOUT_REFUSED: Record<string, MessageKey> = {
  unknown_pane: 'errors.unknown_pane',
  no_neighbor: 'errors.no_neighbor',
  no_room: 'errors.no_room',
  busy: 'dialogs.paneLayout.busy',
  unsupported: 'dialogs.paneLayout.unsupported',
  view_only: 'errors.view_only',
}

// The message of a refused layout action, from the server's code
export function paneLayoutMessage(
  err: unknown,
  t: Translate<MessageKey>,
): string {
  const code = err instanceof RequestError ? err.code : ''
  return t(
    Object.hasOwn(PANE_LAYOUT_REFUSED, code)
      ? PANE_LAYOUT_REFUSED[code]
      : 'dialogs.paneLayout.failed',
  )
}
