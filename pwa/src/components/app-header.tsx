import { Maximize, Minimize } from 'lucide-react'
import type { ComponentProps } from 'react'
import type { Session } from '../types/session'
import {
  ConnectionIndicator,
  type ConnectionState,
} from './connection-indicator'
import { SessionSwitcherChip } from './session-switcher-chip'
import { SessionTabs } from './session-tabs'
import { SettingsMenu } from './settings-menu'
import { FOCUS_RING, IconButton } from './ui/button'
import { type ViewOption, ViewSwitcher } from './ui/view-switcher'

type MenuProps = Omit<ComponentProps<typeof SettingsMenu>, 'fontSize'>

interface Props {
  isMobile: boolean
  session: Session
  // Tabs of the session's group, and that group's name
  groupSessions: Session[]
  groupName?: string
  // Desktop: tabs in the header row; off, the row names the session only
  showSessionTabs: boolean
  canRemoveTab: boolean
  onSelectTab: (id: string) => void
  onAddTab: () => void
  onRemoveTab: (id: string) => void
  connectionState: ConnectionState
  onRetry: () => void
  // Mobile: the sessions sheet
  sessionsOpen: boolean
  onOpenSessions: () => void
  fontSize: number
  onDecreaseFont: () => void
  onIncreaseFont: () => void
  isFullscreen: boolean
  onToggleFullscreen: () => void
  // Views of the pane; the switcher shows once there are two
  views: ViewOption<string>[]
  viewId: string
  onViewChange: (id: string) => void
  viewPanelId: (id: string) => string
  menu: MenuProps
}

// The top bar. Mobile: the session chip, the view switcher and the overflow
// menu (which also holds the font size). Desktop: one row with the session
// tabs, the view switcher, font size, fullscreen, connection and the menu.
export function AppHeader(props: Props) {
  return props.isMobile ? (
    <MobileHeader {...props} />
  ) : (
    <DesktopHeader {...props} />
  )
}

function viewSwitcher(p: Props, showLabels: boolean) {
  return (
    <ViewSwitcher
      views={p.views}
      value={p.viewId}
      onChange={p.onViewChange}
      panelId={p.viewPanelId}
      showLabels={showLabels}
    />
  )
}

function MobileHeader(p: Props) {
  // The chip's dot shows the state; the retry button appears once it is down.
  const down =
    p.connectionState === 'disconnected' || p.connectionState === 'error'
  return (
    <header
      className="relative z-10 flex shrink-0 items-center gap-1 border-b border-border bg-bg px-2 ui-native:border-0"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        minHeight: 'calc(3rem + env(safe-area-inset-top))',
      }}
    >
      <SessionSwitcherChip
        session={p.session}
        groupName={p.groupName}
        sessionCount={p.groupSessions.length}
        connectionState={p.connectionState}
        expanded={p.sessionsOpen}
        onClick={p.onOpenSessions}
      />
      {down && (
        <ConnectionIndicator state={p.connectionState} onRetry={p.onRetry} />
      )}
      {viewSwitcher(p, false)}
      <SettingsMenu
        {...p.menu}
        fontSize={{
          value: p.fontSize,
          onDecrease: p.onDecreaseFont,
          onIncrease: p.onIncreaseFont,
        }}
      />
    </header>
  )
}

// The pseudo-element widens the hit area to 44px without growing the header
const FONT_BUTTON = `relative flex h-8 w-7 before:absolute before:-inset-2 before:content-[''] items-center justify-center text-[12px] text-fg-muted hover:text-fg rounded-[calc(var(--radius-control)-2px)] ${FOCUS_RING}`

function DesktopHeader(p: Props) {
  const { session } = p
  return (
    <header className="relative z-10 flex h-11 shrink-0 items-end gap-2 border-b border-border bg-surface px-2 ui-terminal:bg-bg">
      {p.showSessionTabs ? (
        <SessionTabs
          sessions={p.groupSessions}
          activeId={session.id}
          onSelect={p.onSelectTab}
          onAdd={p.onAddTab}
          onRemove={p.onRemoveTab}
          canRemove={p.canRemoveTab}
        />
      ) : (
        <div
          className="mb-2 flex min-w-0 flex-1 items-center gap-2 px-1"
          title={`${session.name}${session.description ? ` - ${session.description}` : ''}`}
        >
          <span className="shrink-0 text-lg leading-none">{session.icon}</span>
          <span className="truncate font-medium ui-terminal:font-label">
            {session.name}
          </span>
          {session.description && (
            <span className="truncate text-sm text-fg-muted">
              {session.description}
            </span>
          )}
        </div>
      )}
      <div className="mb-1 flex shrink-0 items-center gap-1">
        {viewSwitcher(p, true)}
        <div className="flex items-center gap-0.5 rounded-control border border-border px-1 ui-native:border-0 ui-native:bg-bg">
          <button
            type="button"
            onClick={p.onDecreaseFont}
            className={FONT_BUTTON}
            aria-label="Decrease font size"
          >
            A−
          </button>
          <span
            data-testid="font-size"
            className="w-6 text-center font-label text-[12px] text-fg"
          >
            {p.fontSize}
          </span>
          <button
            type="button"
            onClick={p.onIncreaseFont}
            className={FONT_BUTTON}
            aria-label="Increase font size"
          >
            A+
          </button>
        </div>
        <IconButton
          size="sm"
          onClick={p.onToggleFullscreen}
          aria-label={p.isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          title={p.isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {p.isFullscreen ? (
            <Minimize size={16} aria-hidden="true" />
          ) : (
            <Maximize size={16} aria-hidden="true" />
          )}
        </IconButton>
        <ConnectionIndicator state={p.connectionState} onRetry={p.onRetry} />
        <SettingsMenu {...p.menu} />
      </div>
    </header>
  )
}
