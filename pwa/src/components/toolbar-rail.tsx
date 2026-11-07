import { Command, Maximize, Minimize } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../i18n/i18n-context'
import { PanelToggles } from './panel-toggles'
import { IconButton } from './ui/button'
import { type ViewOption, ViewSwitcher } from './ui/view-switcher'

interface Props {
  // Views of the pane; the switcher shows once there are two
  views: ViewOption<string>[]
  viewId: string
  onViewChange: (id: string) => void
  viewPanelId: (id: string) => string
  // Views shown in the side panel, the one open, and its toggle
  panelViews?: ViewOption<string>[]
  sidePanelId?: string | null
  onTogglePanel?: (id: string | null) => void
  // The Pane menu, opening to its left; unset: no button
  paneMenu?: ReactNode
  isFullscreen: boolean
  // Unset (the browser cannot go fullscreen): no button
  onToggleFullscreen?: () => void
  // Its key as shown, if it has one
  fullscreenKey?: string
  // Unset: no button
  onOpenPalette?: () => void
  paletteKey?: string
}

// A name with its key, for a tooltip
const withKey = (name: string, key?: string) =>
  key ? `${name} (${key})` : name

// Desktop, with the toolbar on the right: a bar down the right edge holding
// the view switcher, the side panel toggles and the Pane menu at its top,
// fullscreen and the command palette at its foot, so the header keeps its
// room for the tabs. Icons only, each named in its tooltip. In a short
// window the top part scrolls, so fullscreen and the palette stay in reach
// (the palette may have no key). It sits beside
// the views and the side panel, not over them: a maximized panel leaves it
// in reach, and the terminal fits the width left.
export function ToolbarRail(p: Props) {
  const { t } = useT()
  const fullscreenName = p.isFullscreen
    ? t('shell.header.exitFullscreen')
    : t('shell.header.enterFullscreen')
  return (
    <nav
      aria-label={t('shell.toolbar')}
      className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-border bg-surface py-1.5 pointer-coarse:w-14 ui-terminal:bg-bg"
    >
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto scrollbar-hide">
        <ViewSwitcher
          views={p.views}
          value={p.viewId}
          onChange={p.onViewChange}
          panelId={p.viewPanelId}
          orientation="vertical"
        />
        {p.onTogglePanel && (
          <PanelToggles
            views={p.panelViews ?? []}
            open={p.sidePanelId ?? null}
            onToggle={p.onTogglePanel}
            orientation="vertical"
          />
        )}
        {p.paneMenu}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1">
        {p.onToggleFullscreen && (
          <IconButton
            size="sm"
            onClick={p.onToggleFullscreen}
            aria-label={fullscreenName}
            title={withKey(fullscreenName, p.fullscreenKey)}
          >
            {p.isFullscreen ? (
              <Minimize size={16} aria-hidden="true" />
            ) : (
              <Maximize size={16} aria-hidden="true" />
            )}
          </IconButton>
        )}
        {p.onOpenPalette && (
          <IconButton
            size="sm"
            onClick={p.onOpenPalette}
            data-tour="palette"
            aria-label={t('common.commandPalette')}
            title={withKey(t('common.commandPalette'), p.paletteKey)}
          >
            <Command size={16} aria-hidden="true" />
          </IconButton>
        )}
      </div>
    </nav>
  )
}
