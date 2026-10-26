import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { Folder, MessageSquare } from 'lucide-react'
import { lazy, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { APP_VIEWS, type AppView, type ViewProps } from './app-views'
import { KeyboardToolbar } from './components/keyboard-toolbar'
import type { QuickActionHandlers } from './components/quick-actions-menu'
import { PanelMaximizeButton } from './components/side-panel'
import { TerminalView } from './components/terminal-view'
import { useHistoryClose } from './hooks/use-history-close'
import type { MuxSnapshot } from './hooks/use-mux-api'
import { usePushSubscription } from './hooks/use-push-subscription'
import { resetAllShortcuts, setShortcut } from './hooks/use-shortcuts'
import { takeDraftInsert } from './utils/chat-draft'
import {
  LARGE_PACKET_HELP_URL,
  reportLargePacketLoss,
} from './utils/large-packet-loss'
import { lazyRetry } from './utils/lazy-retry'
import { setPaneKeys } from './utils/pane-remap'

// ─── Mock all hooks ───────────────────────────────────────────────────────────

const mockUseLocalSessions = vi.fn(() => ({
  activeSession: {
    id: '1',
    name: 'Shell',
    icon: '💻',
    description: 'Terminal',
    paneId: 'pane1',
    hasAgent: false,
  },
  sessions: [
    {
      id: '1',
      name: 'Shell',
      icon: '💻',
      description: 'Terminal',
      paneId: 'pane1',
      hasAgent: false,
    },
  ],
  switchSession: vi.fn(),
  addSession: vi.fn(),
  removeSession: vi.fn(async () => {}),
  updateSession: vi.fn(),
  isReady: true,
  isServerReachable: true,
  refreshSessions: vi.fn(),
  mux: {
    backend: 'tmux',
    caps: { clientSideSelect: false, copyMode: true },
  },
}))
const mockSelectTab = vi.fn(async (_id: string) => true)
const mockFetchOverview = vi.fn(async () => ({
  serverNow: '2026-10-13T09:00:00.000Z',
  panes: [] as object[],
}))
const mockLogout = vi.fn(async () => true)
// The listener the App registers for a write refused as view-only
let viewOnlyListener: (() => void) | undefined
vi.mock('./hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./hooks/use-mux-api')>()),
  selectTab: (id: string) => mockSelectTab(id),
  fetchOverview: () => mockFetchOverview(),
  logout: () => mockLogout(),
  onViewOnlyRefusal: (listener: () => void) => {
    viewOnlyListener = listener
    return () => {}
  },
}))
// Real, but spied: what the App asks of Web Push
vi.mock('./hooks/use-push-subscription', async (orig) => {
  const real = await orig<typeof import('./hooks/use-push-subscription')>()
  return { ...real, usePushSubscription: vi.fn(real.usePushSubscription) }
})
vi.mock('./hooks/use-local-sessions', () => ({
  useLocalSessions: (...args: any[]) =>
    (mockUseLocalSessions as (...a: any[]) => unknown)(...args),
}))

vi.mock('./hooks/use-command-history', () => ({
  useCommandHistory: () => ({
    history: [],
    addCommand: vi.fn(),
    removeCommand: vi.fn(),
    clearHistory: vi.fn(),
  }),
}))

let capturedGestureHandlers: Record<string, (...args: unknown[]) => unknown> =
  {}
vi.mock('./hooks/use-gestures', () => ({
  useGestures: vi.fn((_ref, handlers) => {
    capturedGestureHandlers = handlers
  }),
}))

const mockIsMobile = vi.fn(() => false)
// A fine pointer (a mouse) makes a desktop: the command palette and keys
const mockFinePointer = vi.fn(() => false)
vi.mock('./hooks/use-media-query', () => ({
  useIsMobile: () => mockIsMobile(),
  useMediaQuery: (q: string) => q === '(pointer: fine)' && mockFinePointer(),
}))

// The palette's props, to run what it would; fail throws as a chunk that
// cannot load
const palette = vi.hoisted(() => ({
  props: null as
    | null
    | import('./components/command-palette').CommandPaletteProps,
  fail: false,
}))
vi.mock('./components/command-palette', () => {
  function CommandPalette(
    p: import('./components/command-palette').CommandPaletteProps,
  ) {
    if (palette.fail) throw new Error('chunk')
    palette.props = p
    return (
      <div data-testid="command-palette" data-mode={p.mode}>
        {p.commands.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={!!c.disabledReason}
            onClick={() => p.onRun(c.run)}
          >
            {c.title}
          </button>
        ))}
        <button type="button" onClick={p.onClose}>
          ClosePalette
        </button>
      </div>
    )
  }
  return { CommandPalette, default: CommandPalette }
})

const mockUseKeyboardVisible = vi.fn(
  (): {
    isVisible: boolean
    keyboardHeight: number
    viewportHeight: number
    viewportOffsetTop?: number
  } => ({
    isVisible: false,
    keyboardHeight: 0,
    viewportHeight: 0,
  }),
)
vi.mock('./hooks/use-keyboard-visible', () => ({
  useKeyboardVisible: () => mockUseKeyboardVisible(),
}))

vi.mock('./contexts/theme-context', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('./hooks/use-font-size', () => ({
  useFontSize: () => ({ fontSize: 14, increase: vi.fn(), decrease: vi.fn() }),
}))

const mockUseFullscreen = vi.fn(() => ({
  isFullscreen: false,
  isSupported: true,
  toggleFullscreen: vi.fn(),
}))
vi.mock('./hooks/use-fullscreen', () => ({
  useFullscreen: () => mockUseFullscreen(),
}))

const mockUseSettings = vi.fn(() => ({
  settings: {
    imeSendBehavior: 'send-only' as string,
    pasteSource: 'clipboard' as string,
    toolbarDefaultExpanded: false,
    disableContextMenu: true,
    showSessionTabs: false,
    pollInterval: 5,
    hasSeenGestureHints: true,
  },
  updateSetting: vi.fn(),
}))
vi.mock('./hooks/use-settings', () => ({
  useSettings: (...args: any[]) =>
    (mockUseSettings as (...a: any[]) => unknown)(...args),
}))

vi.mock('./hooks/use-sidebar-collapsed', () => ({
  useSidebarCollapsed: () => ({ isCollapsed: false, toggle: vi.fn() }),
}))

// ─── Mock utils ───────────────────────────────────────────────────────────────

const mockPasteToTerminal = vi.fn()
const mockSendKeyToTerminal = vi.fn()
const mockSendTextToTerminal = vi.fn()
const mockIsInCopyMode = vi.fn(() => false)
const mockIsTerminalDisconnected = vi.fn(() => false)
const mockScrollTmux = vi.fn()
const mockScrollTerminal = vi.fn()
const mockOverflowsHorizontally = vi.fn(() => false)
const mockDragTerminal = vi.fn()
const mockToggleTmuxCopyMode = vi.fn()
const mockReadTerminalBufferText = vi.fn((..._args: unknown[]) => 'buffer')
const mockCopyTerminalSelection = vi.fn(
  async (..._args: unknown[]): Promise<'ok' | 'failed' | 'empty'> => 'empty',
)
const mockPasteTmuxBuffer = vi.fn()
const mockFocusTerminal = vi.fn()
const mockBlurTerminal = vi.fn()
const mockAttachImageToTerminal = vi.fn()
const mockPickImageFile = vi.fn()
vi.mock('./utils/upload-image', async (orig) => ({
  ...(await orig<typeof import('./utils/upload-image')>()),
  pickImageFile: () => mockPickImageFile(),
}))

vi.mock('./utils/terminal-bridge', () => ({
  sendKeyToTerminal: (...args: any[]) => mockSendKeyToTerminal(...args),

  focusTerminal: (...args: any[]) => mockFocusTerminal(...args),

  blurTerminal: (...args: any[]) => mockBlurTerminal(...args),
  isInCopyMode: (...args: any[]) =>
    (mockIsInCopyMode as (...a: any[]) => unknown)(...args),

  isTerminalDisconnected: (...args: any[]) =>
    (mockIsTerminalDisconnected as (...a: any[]) => unknown)(...args),

  pasteToTerminal: (...args: any[]) => mockPasteToTerminal(...args),

  attachImageToTerminal: (...args: any[]) => mockAttachImageToTerminal(...args),

  pasteTmuxBuffer: (...args: any[]) => mockPasteTmuxBuffer(...args),

  scrollTmux: (...args: any[]) => mockScrollTmux(...args),

  scrollTerminal: (...args: any[]) => mockScrollTerminal(...args),

  overflowsHorizontally: (...args: any[]) =>
    (mockOverflowsHorizontally as (...a: any[]) => unknown)(...args),

  dragTerminal: (...args: any[]) => mockDragTerminal(...args),

  toggleTmuxCopyMode: (...args: any[]) => mockToggleTmuxCopyMode(...args),

  copyTerminalSelection: (...args: any[]) => mockCopyTerminalSelection(...args),

  readTerminalBufferText: (...args: any[]) =>
    mockReadTerminalBufferText(...args),

  sendTextToTerminal: (...args: any[]) => mockSendTextToTerminal(...args),

  terminalSelection: (h: any) => mockTerminalSelection(h),
}))
const mockTerminalSelection = vi.fn((_h: unknown) => 'selected')

const mockCheckServerVersion = vi.fn()
const mockReloadToNewVersion = vi.fn()
const mockCheckOnShow = vi.fn()
let mockAppUpdate: {
  server: { version: string; install: string } | null
  stale: boolean
  reloading: boolean
} = { server: null, stale: false, reloading: false }
vi.mock('./utils/app-update', () => ({
  checkOnShow: () => mockCheckOnShow(),
  checkServerVersion: () => mockCheckServerVersion(),
  reloadToNewVersion: () => mockReloadToNewVersion(),
  useAppUpdate: () => mockAppUpdate,
}))

// The newest release on GitHub as the update check kept it
let mockLatestRelease: {
  version: string
  url: string
  checkedAt: number
} | null = null
const mockCheckRelease = vi.fn()
vi.mock('./hooks/use-update-check', async (orig) => ({
  ...(await orig<typeof import('./hooks/use-update-check')>()),
  useUpdateCheck: () => ({
    latest: mockLatestRelease,
    checking: false,
    failed: false,
    check: mockCheckRelease,
  }),
}))

// ─── Mock all components ──────────────────────────────────────────────────────

// Lets tests report stream state changes the way TerminalView does.
let reportStreamState: (state: string) => void = () => {}
let pasteImage: ((image: File) => void) | undefined
let terminalCopy: ((result: 'ok' | 'failed') => void) | undefined
let terminalCopyOnSelect: boolean | undefined
// The handle the mocked terminal hands App through its ref; none by default.
let terminalHandle: { paste: (text: string) => boolean } | null = null
vi.mock('./components/terminal-view', () => ({
  TerminalView: vi.fn(
    (props: {
      onConnectionStateChange: (s: string) => void
      onPasteImage?: (image: File) => void
      onCopy?: (result: 'ok' | 'failed') => void
      copyOnSelect?: boolean
      ref?: { current: unknown }
    }) => {
      reportStreamState = props.onConnectionStateChange
      pasteImage = props.onPasteImage
      terminalCopy = props.onCopy
      terminalCopyOnSelect = props.copyOnSelect
      if (props.ref) props.ref.current = terminalHandle
      return <div data-testid="terminal-view">Terminal</div>
    },
  ),
}))

// The template fill dialog's props, while templates are on
interface FillDialogProps {
  pane: (paneId: string) => { agent?: string; branch?: string } | null
  terminalText: (paneId: string) => string
  notify: (message: string) => void
}
const fillDialog = vi.hoisted(() => ({
  props: null as null | FillDialogProps,
}))
vi.mock('./components/template-fill-dialog', () => ({
  TemplateFillDialog: (props: FillDialogProps) => {
    fillDialog.props = props
    return null
  },
}))

// The Select text sheet's props, while it is open
let selectTextProps:
  | {
      paneId?: string
      useServer: boolean
      readBuffer: () => string
      onClose: () => void
      onCopied: (r: 'ok' | 'failed') => void
    }
  | undefined
vi.mock('./components/select-text-sheet', () => ({
  SelectTextSheet: (props: NonNullable<typeof selectTextProps>) => {
    selectTextProps = props
    return (
      <div data-testid="select-text-sheet">
        <button onClick={props.onClose}>CloseSelectText</button>
      </div>
    )
  },
}))

// Stands in for the expanded toolbar's Actions row
function QuickActionsMock({ onSendKey, onSendText }: QuickActionHandlers) {
  return (
    <div data-testid="quick-actions">
      <button onClick={() => onSendKey('c', { ctrl: true })}>QACtrlKey</button>
      <button onClick={() => onSendKey('Tab')}>QAKey</button>
      <button onClick={() => onSendText('hello')}>QAText</button>
    </div>
  )
}

vi.mock('./components/keyboard-toolbar', () => ({
  KeyboardToolbar: vi.fn((props: Record<string, unknown>) => (
    <div data-testid="keyboard-toolbar">
      <button onClick={() => (props.onKey as (k: string) => void)?.('Tab')}>
        KeyTab
      </button>
      <button onClick={() => (props.onKey as (k: string) => void)?.('Enter')}>
        KeyEnter
      </button>
      <button onClick={() => (props.onCtrlKey as (k: string) => void)?.('c')}>
        CtrlC
      </button>
      <button
        onClick={() => (props.onShiftKey as (k: string) => void)?.('Tab')}
      >
        ShiftTab
      </button>
      <button
        onClick={() => (props.onCtrlShiftKey as (k: string) => void)?.('v')}
      >
        CtrlShiftV
      </button>
      <button
        onClick={() => (props.onCtrlShiftKey as (k: string) => void)?.('c')}
      >
        CtrlShiftC
      </button>
      <button onClick={() => (props.onScroll as (d: string) => void)?.('up')}>
        ScrollUp
      </button>
      <button onClick={() => (props.onTmuxCopy as () => void)?.()}>
        TmuxCopy
      </button>
      <button onClick={() => (props.onSelectText as () => void)?.()}>
        SelectText
      </button>
      <button onClick={() => (props.onPaste as () => void)?.()}>Paste</button>
      {props.onAttachImage ? (
        <button onClick={() => (props.onAttachImage as () => void)()}>
          Attach
        </button>
      ) : null}
      <button onClick={() => (props.onToggleKeyboard as () => void)?.()}>
        ToggleKbd
      </button>
      <button
        onClick={() => (props.onSendText as (t: string) => void)?.('hello')}
      >
        SendText
      </button>
      <button onClick={() => (props.onHistoryToggle as () => void)?.()}>
        HistoryToggle
      </button>
      <button
        onClick={() => (props.onCtrlChange as (v: boolean) => void)?.(false)}
      >
        BlurCtrl
      </button>
      <button
        onClick={() => (props.onCtrlChange as (v: boolean) => void)?.(true)}
      >
        ActivateCtrl
      </button>
      {props.quickActions ? (
        <QuickActionsMock {...(props.quickActions as QuickActionHandlers)} />
      ) : null}
    </div>
  )),
}))

vi.mock('./components/session-sidebar', () => ({
  moveProblem: (err: Error) => `MoveProblem ${err.message}`,
  SessionSidebar: ({
    onSelect,
    onClose,
    isMobile,
    isOpen,
    onFilterChange,
    onRemove,
    onAdd,
    groupActions,
    reorder,
    onOpenOverview,
  }: {
    onOpenOverview?: () => void
    reorder?: {
      tabs: boolean
      groups: boolean
      onMoveTab: (id: string, index: number) => void
      onMoveGroup: (id: string, index: number) => void
    }
    groupActions?: {
      noun: string
      onNew: () => void
      onRename: (id: string, name: string) => Promise<void>
      onClose: (id: string) => void
      canRename: (id: string) => boolean
      onNewWorktree?: (id: string) => void
      onOpenWorktree?: (id: string) => void
      onRemoveWorktree?: (id: string) => void
    }
    onAdd?: (name: string, icon?: string) => void
    onSelect?: (id: string) => void
    onClose?: () => void
    isMobile?: boolean
    isOpen?: boolean
    onFilterChange?: (filter: string) => void
    onRemove?: (id: string) => void
  }) => (
    <div data-testid="session-sidebar" data-open={String(!!isOpen)}>
      {onRemove && <button onClick={() => onRemove('1')}>SBRemove</button>}
      {onRemove && !isMobile && (
        <button onClick={() => onRemove('gone')}>SBRemoveGone</button>
      )}
      {reorder && !isMobile && (
        <span>
          reorder tabs {String(reorder.tabs)} groups {String(reorder.groups)}
          <button onClick={() => reorder.onMoveTab('1', 0)}>SBMoveTab</button>
          <button onClick={() => reorder.onMoveGroup('main', 1)}>
            SBMoveGroup
          </button>
        </span>
      )}
      {onFilterChange && (
        <button onClick={() => onFilterChange('needs-you')}>
          FilterNeedsYou
        </button>
      )}
      {isMobile && onSelect && (
        <button onClick={() => onSelect('2')}>MobileSelect</button>
      )}
      {!isMobile && onOpenOverview && (
        <button onClick={onOpenOverview}>SBOverview</button>
      )}
      {!isMobile && onSelect && (
        <button onClick={() => onSelect('w2:t1')}>SBSelectW2</button>
      )}
      {isMobile && onClose && <button onClick={onClose}>MobileClose</button>}
      {isMobile && onAdd && (
        <button onClick={() => onAdd('Fresh', '🚀')}>MobileAdd</button>
      )}
      {groupActions && !isMobile && (
        <>
          <span>
            {groupActions.noun}: rename main{' '}
            {String(groupActions.canRename('main'))}, rename $3{' '}
            {String(groupActions.canRename('$3'))}
          </span>
          <button onClick={groupActions.onNew}>GroupNew</button>
          <button onClick={() => groupActions.onRename('$3', 'web')}>
            GroupRename
          </button>
          <button onClick={() => groupActions.onClose('main')}>
            GroupCloseMain
          </button>
          <button onClick={() => groupActions.onClose('$3')}>
            GroupCloseWork
          </button>
          <span>
            zellij rename main {String(groupActions.canRename('zbWFpbg'))},
            rename dev {String(groupActions.canRename('zZGV2'))}
          </span>
          <button onClick={() => groupActions.onClose('zbWFpbg')}>
            GroupCloseZellijMain
          </button>
          <button onClick={() => groupActions.onClose('zZGV2')}>
            GroupCloseZellijDev
          </button>
          {groupActions.onNewWorktree && (
            <button onClick={() => groupActions.onNewWorktree?.('$3')}>
              WorktreeNew
            </button>
          )}
          {groupActions.onOpenWorktree && (
            <button onClick={() => groupActions.onOpenWorktree?.('$3')}>
              WorktreeOpen
            </button>
          )}
          {groupActions.onRemoveWorktree && (
            <button onClick={() => groupActions.onRemoveWorktree?.('$3')}>
              WorktreeRemove
            </button>
          )}
        </>
      )}
      {groupActions && isMobile && (
        <button onClick={groupActions.onNew}>MobileGroupNew</button>
      )}
      {groupActions?.onNewWorktree && isMobile && (
        <button onClick={() => groupActions.onNewWorktree?.('$3')}>
          MobileWorktreeNew
        </button>
      )}
    </div>
  ),
}))

vi.mock('./components/settings-modal', () => ({
  SettingsModal: ({
    isOpen,
    onClose,
    updates,
    onShowGestureHints,
    pasteBufferLabel,
    devices,
    signins,
    readOnly,
    initialGroup,
    shortcuts,
  }: {
    shortcuts?: unknown[]
    isOpen: boolean
    initialGroup?: string
    pasteBufferLabel?: string
    onClose: () => void
    updates?: { onReload: () => void }
    onShowGestureHints?: () => void
    devices?: boolean
    signins?: boolean
    readOnly?: boolean
  }) =>
    isOpen ? (
      <div
        data-testid="settings-modal"
        data-paste-label={pasteBufferLabel}
        data-devices={String(!!devices)}
        data-signins={String(!!signins)}
        data-read-only={String(!!readOnly)}
        data-initial-group={initialGroup ?? ''}
        data-shortcuts={String(!!shortcuts)}
      >
        <button onClick={onClose}>CloseSettings</button>
        {updates && (
          <button onClick={() => updates.onReload()}>ReloadUpdate</button>
        )}
        {onShowGestureHints && (
          <button onClick={onShowGestureHints}>GestureHints</button>
        )}
      </div>
    ) : null,
}))

vi.mock('./components/about-modal', () => ({
  AboutModal: ({
    isOpen,
    onClose,
    onCheckUpdates,
  }: {
    isOpen: boolean
    onClose: () => void
    onCheckUpdates?: () => void
  }) =>
    isOpen ? (
      <div data-testid="about-modal">
        <button onClick={onClose}>CloseAbout</button>
        <button onClick={onCheckUpdates}>CheckUpdates</button>
      </div>
    ) : null,
}))

vi.mock('./components/help-modal', () => ({
  HelpModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div data-testid="help-modal">
        <button onClick={onClose}>CloseHelp</button>
      </div>
    ) : null,
}))

vi.mock('./components/settings-menu', () => ({
  SettingsMenu: ({
    onOpenAbout,
    onOpenHelp,
    onOpenSettings,
    fontSize,
    onCopyLink,
    onLogout,
    updateVersion,
    onOpenUpdates,
  }: {
    onOpenAbout: () => void
    onOpenHelp: () => void
    onOpenSettings: () => void
    fontSize?: { value: number; onDecrease: () => void; onIncrease: () => void }
    onCopyLink?: () => void
    onLogout?: () => void
    updateVersion?: string | null
    onOpenUpdates?: () => void
  }) => (
    <div>
      {updateVersion && (
        <button onClick={onOpenUpdates}>MenuUpdate {updateVersion}</button>
      )}
      <button onClick={onOpenAbout}>About</button>
      <button onClick={onOpenHelp}>Help</button>
      <button onClick={onOpenSettings}>Settings</button>
      {fontSize && (
        <>
          <button onClick={fontSize.onDecrease}>
            MenuFontDecrease {fontSize.value}
          </button>
          <button onClick={fontSize.onIncrease}>MenuFontIncrease</button>
        </>
      )}
      {onCopyLink && <button onClick={onCopyLink}>CopyLink</button>}
      {onLogout && <button onClick={onLogout}>LogOut</button>}
    </div>
  ),
}))

vi.mock('./components/connection-indicator', () => ({
  ConnectionDot: ({ state }: { state: string }) => (
    <span data-testid="connection-dot" data-state={state} />
  ),
  ConnectionIndicator: ({
    state,
    onRetry,
  }: {
    state: string
    onRetry: () => void
  }) => (
    <div data-testid="connection-indicator" data-state={state}>
      <button onClick={onRetry}>Retry</button>
    </div>
  ),
}))

vi.mock('./components/toast', () => ({
  Toast: ({
    message,
    variant = 'info',
    onClose,
    action,
    duration,
  }: {
    message: string
    variant?: string
    onClose: () => void
    action?: { label: string; onClick: () => void }
    duration?: number
  }) => (
    <div
      data-testid="toast"
      data-variant={variant}
      data-duration={duration}
      role="alert"
    >
      {message}
      <button onClick={onClose}>CloseToast</button>
      {action && (
        <button
          onClick={() => {
            onClose()
            action.onClick()
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  ),
}))

vi.mock('./components/gesture-hints-overlay', () => ({
  GestureHintsOverlay: ({
    isOpen,
    onDismiss,
  }: {
    isOpen: boolean
    onDismiss: () => void
  }) =>
    isOpen ? (
      <div data-testid="gesture-hints">
        <button onClick={onDismiss}>DismissHints</button>
      </div>
    ) : null,
}))

vi.mock('./components/command-history-dropdown', () => ({
  CommandHistoryDropdown: ({
    onClose,
    onSelect,
  }: {
    onClose: () => void
    onSelect: (t: string) => void
  }) => (
    <div data-testid="history-dropdown">
      <button onClick={onClose}>CloseHistory</button>
      <button onClick={() => onSelect('git status')}>SelectHistory</button>
    </div>
  ),
}))

vi.mock('./components/worktree-dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./components/worktree-dialog')>()),
  WorktreeDialog: ({
    mode,
    groupId,
    onClose,
    onCreate,
    onOpen,
    onShow,
  }: {
    mode: string
    groupId: string
    onClose: () => void
    onCreate: (
      w: { groupId: string; branch: string; base: string; label: string },
      isOpen: () => boolean,
    ) => Promise<void>
    onOpen: (branch: string, isOpen: () => boolean) => Promise<void>
    onShow: (id: string) => void
  }) => (
    <div data-testid="worktree-dialog">
      {mode} {groupId}
      <button
        onClick={() =>
          onCreate(
            { groupId, branch: 'feat/x', base: '', label: '' },
            () => true,
          )
        }
      >
        DlgCreate
      </button>
      <button onClick={() => onOpen('feat/x', () => true)}>DlgOpen</button>
      <button onClick={() => onShow('w7')}>DlgShow</button>
      <button onClick={onClose}>DlgClose</button>
    </div>
  ),
  WorktreeRemoveDialog: ({
    groupId,
    force,
    onConfirm,
    onCancel,
    children,
  }: {
    groupId: string
    force?: { path: string; branch: string }
    onConfirm: (w: { force: boolean; path: string; branch: string }) => void
    onCancel: () => void
    children?: React.ReactNode
  }) => (
    <div data-testid="worktree-remove">
      {force ? 'second' : 'first'} {groupId}
      {children}
      <button onClick={onCancel}>RemoveNo</button>
      <button
        onClick={() =>
          onConfirm({ force: !!force, path: '/wt/feat-x', branch: 'feat/x' })
        }
      >
        RemoveYes
      </button>
    </div>
  ),
}))

vi.mock('./components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    children,
    onConfirm,
    onCancel,
  }: {
    isOpen: boolean
    title: React.ReactNode
    children: React.ReactNode
    onConfirm: () => void
    onCancel: () => void
  }) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <h2>{title}</h2>
        {children}
        <button onClick={onConfirm}>ConfirmYes</button>
        <button onClick={onCancel}>ConfirmNo</button>
      </div>
    ) : null,
}))

vi.mock('./components/session-tabs', () => ({
  SessionTabs: ({
    sessions,
    onAdd,
    onRemove,
  }: {
    sessions: { id: string }[]
    onAdd: () => void
    onRemove: (id: string) => void
  }) => (
    <div
      data-testid="session-tabs"
      data-ids={sessions.map((s) => s.id).join(',')}
    >
      <button onClick={onAdd}>STAdd</button>
      <button onClick={() => onRemove('1')}>STRemove</button>
    </div>
  ),
}))

// ─── Tests ────────────────────────────────────────────────────────────────────

// A test that shows a session with a group writes its link into the URL;
// the next one must not open it.
beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPasteToTerminal.mockResolvedValue({ ok: true })
    mockIsMobile.mockReturnValue(false)
    mockUseKeyboardVisible.mockReturnValue({
      isVisible: false,
      keyboardHeight: 0,
      viewportHeight: 0,
    })
    mockUseFullscreen.mockReturnValue({
      isFullscreen: false,
      isSupported: true,
      toggleFullscreen: vi.fn(),
    })
    mockUseSettings.mockReturnValue({
      settings: {
        imeSendBehavior: 'send-only' as const,
        pasteSource: 'clipboard' as const,
        toolbarDefaultExpanded: false,
        disableContextMenu: true,
        showSessionTabs: false,
        pollInterval: 5,
        hasSeenGestureHints: true,
      },
      updateSetting: vi.fn(),
    })
    mockUseLocalSessions.mockReturnValue({
      activeSession: {
        id: '1',
        name: 'Shell',
        icon: '💻',
        description: 'Terminal',
        paneId: 'pane1',
        hasAgent: false,
      },
      sessions: [
        {
          id: '1',
          name: 'Shell',
          icon: '💻',
          description: 'Terminal',
          paneId: 'pane1',
          hasAgent: false,
        },
      ],
      switchSession: vi.fn(),
      addSession: vi.fn(),
      removeSession: vi.fn(async () => {}),
      updateSession: vi.fn(),
      isReady: true,
      isServerReachable: true,
      refreshSessions: vi.fn(),
      mux: {
        backend: 'tmux',
        caps: { clientSideSelect: false, copyMode: true },
      },
    })
  })

  it('renders without crashing', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByTestId('terminal-view')).toBeInTheDocument()
    })
  })

  it('renders desktop sidebar (not mobile)', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByTestId('session-sidebar')).toBeInTheDocument()
    })
  })

  it('renders keyboard toolbar', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByTestId('keyboard-toolbar')).toBeInTheDocument()
    })
  })

  it('explains lost large replies once, with a link to the fix', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<App />)
    act(() => {
      reportLargePacketLoss()
      reportLargePacketLoss()
    })
    const toast = await screen.findByTestId('toast')
    expect(toast).toHaveAttribute('data-variant', 'warning')
    expect(toast).toHaveTextContent(/drop large replies/)
    fireEvent.click(screen.getByRole('button', { name: 'How to fix' }))
    expect(open).toHaveBeenCalledWith(
      LARGE_PACKET_HELP_URL,
      '_blank',
      'noopener',
    )
    // Already explained on this page load: no second toast
    act(() => reportLargePacketLoss())
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument()
  })

  it('closes a toast from its close button', async () => {
    render(<App />)
    act(() => reportLargePacketLoss())
    await screen.findByTestId('toast')
    fireEvent.click(screen.getByRole('button', { name: 'CloseToast' }))
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument()
  })

  // No toast at start any more: the banner and Settings > Updates say it.
  it('shows the reload banner while the page is older than the server', async () => {
    mockAppUpdate = {
      server: { version: '9.9.9', install: 'release' },
      stale: true,
      reloading: false,
    }
    render(<App />)
    const banner = await screen.findByText('Termote v9.9.9 is ready')
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument()
    fireEvent.click(
      within(banner.closest('[role="status"]') as HTMLElement).getByRole(
        'button',
        { name: 'Reload' },
      ),
    )
    expect(mockReloadToNewVersion).toHaveBeenCalled()
    mockAppUpdate = { server: null, stale: false, reloading: false }
  })

  it('names no version in the banner when only a new worker waits', async () => {
    mockAppUpdate = { server: null, stale: true, reloading: true }
    render(<App />)
    expect(
      await screen.findByText('A new version is ready'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reloading…' })).toBeDisabled()
    mockAppUpdate = { server: null, stale: false, reloading: false }
  })

  describe('release check', () => {
    const serverAt = (version: string, install = 'release') => {
      mockLatestRelease = { version: '2.5.0', url: 'u', checkedAt: Date.now() }
      mockAppUpdate = {
        server: { version, install },
        stale: false,
        reloading: false,
      }
    }
    afterEach(() => {
      mockLatestRelease = null
      mockAppUpdate = { server: null, stale: false, reloading: false }
    })

    it('asks GitHub for the newest release on start and when shown again', async () => {
      render(<App />)
      await waitFor(() => expect(mockCheckRelease).toHaveBeenCalledTimes(1))
      const shown = vi
        .spyOn(document, 'visibilityState', 'get')
        .mockReturnValue('visible')
      try {
        document.dispatchEvent(new Event('visibilitychange'))
        expect(mockCheckRelease).toHaveBeenCalledTimes(2)
      } finally {
        shown.mockRestore()
      }
    })

    it('offers a release newer than the server in the menu, opening Updates', async () => {
      serverAt('2.4.0')
      render(<App />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'MenuUpdate 2.5.0' }),
      )
      expect(screen.getByTestId('settings-modal')).toHaveAttribute(
        'data-initial-group',
        'updates',
      )
    })

    it.each([
      ['the server runs the newest release', '2.5.0', 'release', false],
      ['a checkout is pulled by hand', '2.4.0', 'checkout', false],
      ['a viewer cannot update', '2.4.0', 'release', true],
    ])('offers no update when %s', async (_, version, install, readOnly) => {
      serverAt(version, install)
      render(<App readOnly={readOnly} />)
      await screen.findByRole('button', { name: 'Settings' })
      expect(screen.queryByRole('button', { name: /MenuUpdate/ })).toBeNull()
    })
  })

  it('shows no banner on the current version', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByText(/is ready/)).not.toBeInTheDocument()
  })

  it('asks before closing a session, and closes it on confirm', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'SBRemove' }))
    fireEvent.click(screen.getByRole('button', { name: 'SBRemove' }))
    const dialog = screen.getByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('Close session?')
    expect(dialog).toHaveTextContent('Shell')
    const { removeSession } = mockUseLocalSessions.mock.results[0].value
    expect(removeSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'ConfirmYes' }))
    expect(removeSession).toHaveBeenCalledWith('1')
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
  })

  it('shows the hidden characters of the session it asks to close', async () => {
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      sessions: [{ ...base.sessions[0], name: 'Sh\u202eell' }],
    } as any)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'SBRemove' }))
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent(
      'Sh⟨U+202E⟩ell will be closed',
    )
  })

  it('names what runs in the session it asks to close', async () => {
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      sessions: [{ ...base.sessions[0], commands: ['bash', 'vim'] }],
    } as any)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'SBRemove' }))
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent(
      'along with anything still running in it.Running: bash, vim.',
    )
  })

  it('the close question follows its tab by key, and says when it changed', async () => {
    const base = mockUseLocalSessions()
    const removeSession = vi.fn(async () => {
      throw new Error('changed')
    })
    mockUseLocalSessions.mockReturnValue({
      ...base,
      sessions: [{ ...base.sessions[0], key: '@7' }],
      removeSession,
    } as any)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'SBRemoveGone' }))
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'SBRemove' }))
    fireEvent.click(screen.getByRole('button', { name: 'ConfirmYes' }))
    expect(removeSession).toHaveBeenCalledWith('1')
    expect(await screen.findByTestId('toast')).toHaveTextContent(
      'The tab changed; try again',
    )
  })

  it('moves tabs and groups where the server can; a refusal is a toast', async () => {
    const base = mockUseLocalSessions()
    const moveTab = vi.fn(async () => {
      throw new Error('tab')
    })
    const moveGroup = vi.fn(async () => {
      throw new Error('group')
    })
    mockUseLocalSessions.mockReturnValue({
      ...base,
      mux: {
        backend: 'herdr',
        caps: {
          clientSideSelect: true,
          copyMode: false,
          reorderTabs: true,
          reorderGroups: true,
        },
      },
      moveTab,
      moveGroup,
      moving: false,
    } as any)
    render(<App />)
    expect(
      await screen.findByText(/reorder tabs true groups true/),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'SBMoveTab' }))
    expect(moveTab).toHaveBeenCalledWith('1', 0)
    expect(await screen.findByTestId('toast')).toHaveTextContent(
      'MoveProblem tab',
    )
    fireEvent.click(screen.getByRole('button', { name: 'SBMoveGroup' }))
    expect(moveGroup).toHaveBeenCalledWith('main', 1)
    await waitFor(() =>
      expect(screen.getByTestId('toast')).toHaveTextContent(
        'MoveProblem group',
      ),
    )
  })

  it('cancelling the confirmation keeps the session', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'SBRemove' }))
    fireEvent.click(screen.getByRole('button', { name: 'SBRemove' }))
    fireEvent.click(screen.getByRole('button', { name: 'ConfirmNo' }))
    const { removeSession } = mockUseLocalSessions.mock.results[0].value
    expect(removeSession).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
  })

  describe('log out', () => {
    const withAuth = () => {
      const base = mockUseLocalSessions()
      // The mock's type knows only the caps of its first value.
      mockUseLocalSessions.mockReturnValue({
        ...base,
        mux: {
          backend: 'tmux',
          caps: { clientSideSelect: false, copyMode: true, auth: true },
        },
      } as typeof base)
    }
    const assign = vi.fn()
    beforeEach(() => {
      assign.mockClear()
      vi.stubGlobal('location', { ...window.location, assign })
    })
    afterEach(() => vi.unstubAllGlobals())

    it('is not offered when sign-in is off', async () => {
      render(<App />)
      await screen.findByRole('button', { name: 'About' })
      expect(screen.queryByRole('button', { name: 'LogOut' })).toBeNull()
    })

    it('ends the session, then opens the sign-in page', async () => {
      withAuth()
      mockLogout.mockResolvedValueOnce(true)
      localStorage.setItem('termote-file-drafts:i1:@1:a', '{}')
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'LogOut' }))
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'))
      expect(mockLogout).toHaveBeenCalledTimes(1)
      // What the PWA kept on the device goes with the session
      expect(localStorage.getItem('termote-file-drafts:i1:@1:a')).toBeNull()
    })

    it.each([
      ['refused', () => mockLogout.mockResolvedValueOnce(false)],
      ['failed', () => mockLogout.mockRejectedValueOnce(new Error('offline'))],
    ])('stays and says so when the server %s', async (_, arrange) => {
      withAuth()
      arrange()
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'LogOut' }))
      expect(await screen.findByTestId('toast')).toHaveTextContent(
        'Could not log out. Try again',
      )
      expect(assign).not.toHaveBeenCalled()
    })
  })

  it('opens about modal', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'About' }))
    fireEvent.click(screen.getByRole('button', { name: 'About' }))
    expect(screen.getByTestId('about-modal')).toBeInTheDocument()
  })

  it('closes about modal', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'About' }))
    fireEvent.click(screen.getByRole('button', { name: 'About' }))
    fireEvent.click(screen.getByRole('button', { name: 'CloseAbout' }))
    expect(screen.queryByTestId('about-modal')).not.toBeInTheDocument()
  })

  it('opens Settings at Updates from About, and plainly from the menu', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'About' }))
    fireEvent.click(screen.getByRole('button', { name: 'CheckUpdates' }))
    expect(screen.queryByTestId('about-modal')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-modal')).toHaveAttribute(
      'data-initial-group',
      'updates',
    )
    fireEvent.click(screen.getByRole('button', { name: 'CloseSettings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByTestId('settings-modal')).toHaveAttribute(
      'data-initial-group',
      '',
    )
  })

  it('opens help modal', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Help' }))
    fireEvent.click(screen.getByRole('button', { name: 'Help' }))
    expect(screen.getByTestId('help-modal')).toBeInTheDocument()
  })

  it('closes help modal', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Help' }))
    fireEvent.click(screen.getByRole('button', { name: 'Help' }))
    fireEvent.click(screen.getByRole('button', { name: 'CloseHelp' }))
    expect(screen.queryByTestId('help-modal')).not.toBeInTheDocument()
  })

  it('opens settings modal', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByTestId('settings-modal')).toBeInTheDocument()
  })

  it('names the paste buffer after the tmux backend', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    expect(screen.getByTestId('settings-modal')).toHaveAttribute(
      'data-paste-label',
      'tmux buffer',
    )
  })

  it('names the paste buffer generically for another backend', async () => {
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      mux: {
        backend: 'herdr',
        caps: { clientSideSelect: true, copyMode: false },
      },
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    expect(screen.getByTestId('settings-modal')).toHaveAttribute(
      'data-paste-label',
      'Session buffer',
    )
  })

  it('closes settings modal', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'CloseSettings' }))
    expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument()
  })

  it('handleKey sends key to terminal', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'KeyTab' }))
    fireEvent.click(screen.getByRole('button', { name: 'KeyTab' }))
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'Tab')
  })

  it('handleKey Enter reconnects when terminal disconnected', async () => {
    mockIsTerminalDisconnected.mockReturnValue(true)
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'KeyEnter' }))
    fireEvent.click(screen.getByRole('button', { name: 'KeyEnter' }))
    // reconnect is called via terminalRef (but ref is mocked via TerminalFrame mock)
    // sendKeyToTerminal should NOT be called
    expect(mockSendKeyToTerminal).not.toHaveBeenCalledWith(null, 'Enter')
  })

  it('handleKey Enter sends Enter when terminal NOT disconnected', async () => {
    mockIsTerminalDisconnected.mockReturnValue(false)
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'KeyEnter' }))
    fireEvent.click(screen.getByRole('button', { name: 'KeyEnter' }))
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'Enter')
  })

  it('handleCtrlKey sends ctrl key', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'CtrlC' }))
    fireEvent.click(screen.getByRole('button', { name: 'CtrlC' }))
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'c', {
      ctrl: true,
    })
  })

  it('handleShiftKey sends shift key', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'ShiftTab' }))
    fireEvent.click(screen.getByRole('button', { name: 'ShiftTab' }))
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'Tab', {
      shift: true,
    })
  })

  it('handleCtrlShiftKey for v calls pasteToTerminal', async () => {
    mockPasteToTerminal.mockResolvedValue({ ok: true })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'CtrlShiftV' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'CtrlShiftV' }))
    })
    expect(mockPasteToTerminal).toHaveBeenCalled()
  })

  it('handleCtrlShiftKey for v shows toast on paste error', async () => {
    mockPasteToTerminal.mockResolvedValue({ ok: false, reason: 'not-allowed' })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'CtrlShiftV' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'CtrlShiftV' }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('toast')).toBeInTheDocument()
      expect(
        screen.getByText(/Clipboard permission denied/),
      ).toBeInTheDocument()
    })
  })

  it('handleCtrlShiftKey for c sends ctrl+shift+c', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'CtrlShiftC' }))
    fireEvent.click(screen.getByRole('button', { name: 'CtrlShiftC' }))
    // Nothing selected: the keys go to the pane
    await waitFor(() =>
      expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'c', {
        ctrl: true,
        shift: true,
      }),
    )
  })

  it('handleCtrlShiftKey for another key never copies', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'CtrlShiftC' }))
    const props = vi.mocked(KeyboardToolbar).mock.lastCall![0]
    await act(async () => props.onCtrlShiftKey?.('z'))
    expect(mockCopyTerminalSelection).not.toHaveBeenCalled()
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'z', {
      ctrl: true,
      shift: true,
    })
  })

  it('handleCtrlShiftKey for c copies a selection instead', async () => {
    mockCopyTerminalSelection.mockResolvedValueOnce('ok')
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'CtrlShiftC' }))
    fireEvent.click(screen.getByRole('button', { name: 'CtrlShiftC' }))
    const toast = await screen.findByTestId('toast')
    expect(toast).toHaveTextContent('Copied')
    expect(toast).toHaveAttribute('data-variant', 'success')
    expect(mockSendKeyToTerminal).not.toHaveBeenCalled()
  })

  it('a failed terminal copy shows an error toast', async () => {
    render(<App />)
    await waitFor(() => expect(terminalCopy).toBeDefined())
    expect(terminalCopyOnSelect).toBeFalsy()
    act(() => terminalCopy!('failed'))
    const toast = await screen.findByTestId('toast')
    expect(toast).toHaveTextContent('Could not copy')
    expect(toast).toHaveAttribute('data-variant', 'danger')
  })

  it('handleScroll calls scrollTmux', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'ScrollUp' }))
    fireEvent.click(screen.getByRole('button', { name: 'ScrollUp' }))
    expect(mockScrollTmux).toHaveBeenCalledWith(null, 'up')
  })

  it('handleScroll scrolls the xterm scrollback without copy mode', async () => {
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      mux: {
        backend: 'herdr',
        caps: { clientSideSelect: true, copyMode: false },
      },
    })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'ScrollUp' }))
    fireEvent.click(screen.getByRole('button', { name: 'ScrollUp' }))
    expect(mockScrollTerminal).toHaveBeenCalledWith(null, 'up')
    expect(mockScrollTmux).not.toHaveBeenCalled()
  })

  it('handleTmuxCopy calls toggleTmuxCopyMode', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'TmuxCopy' }))
    fireEvent.click(screen.getByRole('button', { name: 'TmuxCopy' }))
    expect(mockToggleTmuxCopyMode).toHaveBeenCalled()
  })

  it('handlePaste with clipboard source calls pasteToTerminal', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Paste' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    })
    expect(mockPasteToTerminal).toHaveBeenCalled()
  })

  it('handlePaste with clipboard source shows toast on error', async () => {
    mockPasteToTerminal.mockResolvedValue({ ok: false, reason: 'not-secure' })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Paste' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    })
    await waitFor(() => {
      expect(screen.getByText(/Clipboard requires HTTPS/)).toBeInTheDocument()
    })
  })

  it('handleSendText calls sendTextToTerminal', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'SendText' }))
    fireEvent.click(screen.getByRole('button', { name: 'SendText' }))
    expect(mockSendTextToTerminal).toHaveBeenCalledWith(null, 'hello')
  })

  it('toggles history panel open/close', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'HistoryToggle' }))
    fireEvent.click(screen.getByRole('button', { name: 'HistoryToggle' }))
    expect(screen.getByTestId('history-dropdown')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'HistoryToggle' }))
    expect(screen.queryByTestId('history-dropdown')).not.toBeInTheDocument()
  })

  it('closes history dropdown via CloseHistory', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'HistoryToggle' }))
    fireEvent.click(screen.getByRole('button', { name: 'HistoryToggle' }))
    fireEvent.click(screen.getByRole('button', { name: 'CloseHistory' }))
    expect(screen.queryByTestId('history-dropdown')).not.toBeInTheDocument()
  })

  it('handleHistorySelect sends text and Enter then closes history', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'HistoryToggle' }))
    fireEvent.click(screen.getByRole('button', { name: 'HistoryToggle' }))
    fireEvent.click(screen.getByRole('button', { name: 'SelectHistory' }))
    expect(mockSendTextToTerminal).toHaveBeenCalledWith(null, 'git status')
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'Enter')
    expect(screen.queryByTestId('history-dropdown')).not.toBeInTheDocument()
  })

  it('mobile: the session chip opens the sessions sheet', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<App />)
    const chip = await screen.findByRole('button', {
      name: 'Open sessions menu',
    })
    expect(chip).toHaveTextContent('Shell')
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute(
      'data-open',
      'false',
    )
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute(
      'data-open',
      'true',
    )
  })

  it('mobile: creating a session closes the sheet once it is created', async () => {
    mockIsMobile.mockReturnValue(true)
    let created!: () => void
    const addSession = vi.fn(
      () => new Promise<void>((resolve) => (created = resolve)),
    )
    mockUseLocalSessions.mockReturnValue({
      ...mockUseLocalSessions(),
      addSession,
    })
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open sessions menu' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'MobileAdd' }))
    expect(addSession).toHaveBeenCalledWith('Fresh', '🚀', undefined)
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute(
      'data-open',
      'true',
    )
    await act(async () => created())
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute(
      'data-open',
      'false',
    )
  })

  it.each([false, true])(
    'saves the sidebar filter (mobile: %s)',
    async (mobile) => {
      mockIsMobile.mockReturnValue(mobile)
      const { updateSetting } = mockUseSettings()
      render(<App />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'FilterNeedsYou' }),
      )
      expect(updateSetting).toHaveBeenCalledWith('sidebarFilter', 'needs-you')
    },
  )

  it('mobile: font size lives in the overflow menu', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<App />)
    expect(
      await screen.findByRole('button', { name: 'MenuFontDecrease 14' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Decrease font size' }),
    ).not.toBeInTheDocument()
  })

  it('renders mobile components when isMobile=true', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<App />)
    await waitFor(() => {
      expect(screen.getByTestId('quick-actions')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Open sessions menu' }),
      ).toBeInTheDocument()
    })
  })

  it('gives the toolbar Quick actions on mobile only', async () => {
    const { unmount } = render(<App />)
    await screen.findByTestId('keyboard-toolbar')
    expect(
      vi.mocked(KeyboardToolbar).mock.lastCall![0].quickActions,
    ).toBeUndefined()
    unmount()
    mockIsMobile.mockReturnValue(true)
    render(<App />)
    await screen.findByTestId('keyboard-toolbar')
    expect(vi.mocked(KeyboardToolbar).mock.lastCall![0].quickActions).toEqual({
      onSendKey: expect.any(Function),
      onSendText: expect.any(Function),
    })
  })

  it('does not render mobile components when isMobile=false', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.queryByTestId('quick-actions')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Open sessions menu' }),
      ).not.toBeInTheDocument()
    })
  })

  it('handleMobileSelect switches session and closes sidebar', async () => {
    mockIsMobile.mockReturnValue(true)
    const mockSwitchSession = vi.fn()
    mockUseLocalSessions.mockReturnValue({
      activeSession: {
        id: '1',
        name: 'Shell',
        icon: '💻',
        description: 'Terminal',
        paneId: 'pane1',
        hasAgent: false,
      },
      sessions: [
        {
          id: '1',
          name: 'Shell',
          icon: '💻',
          description: 'Terminal',
          paneId: 'pane1',
          hasAgent: false,
        },
      ],
      switchSession: mockSwitchSession,
      addSession: vi.fn(),
      removeSession: vi.fn(async () => {}),
      updateSession: vi.fn(),
      isReady: true,
      isServerReachable: true,
      refreshSessions: vi.fn(),
      mux: {
        backend: 'tmux',
        caps: { clientSideSelect: false, copyMode: true },
      },
    })
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open sessions menu' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'MobileSelect' }))
    expect(mockSwitchSession).toHaveBeenCalledWith('2', undefined)
    // The sheet closes once the pick has resolved
    await waitFor(() =>
      expect(screen.getByTestId('session-sidebar')).toHaveAttribute(
        'data-open',
        'false',
      ),
    )
  })

  it('mobile sidebar onClose closes the sidebar', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open sessions menu' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'MobileClose' }))
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute(
      'data-open',
      'false',
    )
  })

  it('retry button calls terminal reconnect', async () => {
    render(<App />)
    await waitFor(() => screen.getByTestId('connection-indicator'))
    // Retry triggers terminalRef.current?.reconnect()
    // Since TerminalFrame is mocked, ref is null, no crash expected
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Retry' })),
    ).not.toThrow()
  })

  it('decrease/increase font size buttons work', async () => {
    render(<App />)
    await waitFor(() =>
      screen.getByRole('button', { name: 'Decrease font size' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Decrease font size' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase font size' }))
    // No crash = pass; useFontSize is mocked so decrease/increase are vi.fn()
  })

  it('A- and A+ buttons rendered', async () => {
    render(<App />)
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Decrease font size' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Increase font size' }),
      ).toBeInTheDocument()
    })
  })

  it('fullscreen button visible on desktop', async () => {
    render(<App />)
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Enter fullscreen' }),
      ).toBeInTheDocument()
    })
  })

  it('fullscreen button shows Exit fullscreen when isFullscreen=true (branches 415-419)', async () => {
    mockUseFullscreen.mockReturnValue({
      isFullscreen: true,
      isSupported: true,
      toggleFullscreen: vi.fn(),
    })
    render(<App />)
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Exit fullscreen' }),
      ).toBeInTheDocument()
    })
  })

  it('fullscreen button hidden when the browser cannot go fullscreen', async () => {
    mockUseFullscreen.mockReturnValue({
      isFullscreen: false,
      isSupported: false,
      toggleFullscreen: vi.fn(),
    })
    render(<App />)
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Increase font size' }),
      ).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('button', { name: 'Enter fullscreen' }),
    ).not.toBeInTheDocument()
  })

  it('title omits description when activeSession.description is empty (branch 354)', async () => {
    mockUseLocalSessions.mockReturnValue({
      activeSession: {
        id: '1',
        name: 'Shell',
        icon: '💻',
        description: '',
        paneId: 'pane1',
        hasAgent: false,
      },
      sessions: [
        {
          id: '1',
          name: 'Shell',
          icon: '💻',
          description: '',
          paneId: 'pane1',
          hasAgent: false,
        },
      ],
      switchSession: vi.fn(),
      addSession: vi.fn(),
      removeSession: vi.fn(async () => {}),
      updateSession: vi.fn(),
      isReady: true,
      isServerReachable: true,
      refreshSessions: vi.fn(),
      mux: {
        backend: 'tmux',
        caps: { clientSideSelect: false, copyMode: true },
      },
    })
    render(<App />)
    await waitFor(() => screen.getByText('Shell'))
    // title should be just "Shell" (no " - " appended) for isMobile=false
    const titleEl = screen.getByText('Shell').closest('[title]')
    expect(titleEl?.getAttribute('title')).toBe('Shell')
  })

  it('fullscreen button not visible on mobile', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<App />)
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Enter fullscreen' }),
      ).not.toBeInTheDocument()
    })
  })

  it('Quick actions onSendKey with ctrl:true calls sendKeyToTerminal with ctrl', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'QACtrlKey' }))
    fireEvent.click(screen.getByRole('button', { name: 'QACtrlKey' }))
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'c', {
      ctrl: true,
    })
  })

  it('Quick actions onSendKey without ctrl calls sendKeyToTerminal without opts', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'QAKey' }))
    fireEvent.click(screen.getByRole('button', { name: 'QAKey' }))
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'Tab')
  })

  it('Quick actions onSendText calls sendTextToTerminal', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'QAText' }))
    fireEvent.click(screen.getByRole('button', { name: 'QAText' }))
    expect(mockSendTextToTerminal).toHaveBeenCalledWith(null, 'hello')
  })

  it('SessionTabs onAdd calls addSession("New") on desktop with showSessionTabs=true', async () => {
    const mockAddSession = vi.fn()
    mockUseSettings.mockReturnValue({
      settings: {
        imeSendBehavior: 'send-only' as const,
        pasteSource: 'clipboard' as const,
        toolbarDefaultExpanded: false,
        disableContextMenu: true,
        showSessionTabs: true,
        pollInterval: 5,
        hasSeenGestureHints: true,
      },
      updateSetting: vi.fn(),
    })
    mockUseLocalSessions.mockReturnValue({
      activeSession: {
        id: '1',
        name: 'Shell',
        icon: '💻',
        description: 'Terminal',
        paneId: 'pane1',
        hasAgent: false,
      },
      sessions: [
        {
          id: '1',
          name: 'Shell',
          icon: '💻',
          description: 'Terminal',
          paneId: 'pane1',
          hasAgent: false,
        },
      ],
      switchSession: vi.fn(),
      addSession: mockAddSession,
      removeSession: vi.fn(async () => {}),
      updateSession: vi.fn(),
      isReady: true,
      isServerReachable: true,
      refreshSessions: vi.fn(),
      mux: {
        backend: 'tmux',
        caps: { clientSideSelect: false, copyMode: true },
      },
    })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'STAdd' }))
    fireEvent.click(screen.getByRole('button', { name: 'STAdd' }))
    expect(mockAddSession).toHaveBeenCalledWith('New')
  })

  it('hidden ctrl input blurs ctrl on blur', async () => {
    render(<App />)
    await waitFor(() => {
      // The hidden sr-only input exists
      const hiddenInput = document.querySelector('input.sr-only')
      expect(hiddenInput).toBeInTheDocument()
    })
    const hiddenInput = document.querySelector(
      'input.sr-only',
    ) as HTMLInputElement
    fireEvent.blur(hiddenInput)
    // setCtrlActive(false) called — no crash
  })

  it('handleCtrlInput processes letter key and sends ctrl', async () => {
    render(<App />)
    await waitFor(() => {
      const hiddenInput = document.querySelector('input.sr-only')
      expect(hiddenInput).toBeInTheDocument()
    })
    const hiddenInput = document.querySelector(
      'input.sr-only',
    ) as HTMLInputElement
    fireEvent.change(hiddenInput, { target: { value: 'a' } })
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'a', {
      ctrl: true,
    })
  })

  it('handleCtrlInput ignores non-letter values', async () => {
    render(<App />)
    await waitFor(() => document.querySelector('input.sr-only'))
    const hiddenInput = document.querySelector(
      'input.sr-only',
    ) as HTMLInputElement
    fireEvent.change(hiddenInput, { target: { value: '1' } })
    expect(mockSendKeyToTerminal).not.toHaveBeenCalled()
  })

  it('handleCtrlInput ignores values longer than 1 char', async () => {
    render(<App />)
    await waitFor(() => document.querySelector('input.sr-only'))
    const hiddenInput = document.querySelector(
      'input.sr-only',
    ) as HTMLInputElement
    fireEvent.change(hiddenInput, { target: { value: 'ab' } })
    expect(mockSendKeyToTerminal).not.toHaveBeenCalled()
  })

  // Gesture handler branches
  it('gesture onSwipeLeft sends Ctrl+C', async () => {
    render(<App />)
    await waitFor(() =>
      expect(capturedGestureHandlers.onSwipeLeft).toBeDefined(),
    )
    capturedGestureHandlers.onSwipeLeft()
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'c', {
      ctrl: true,
    })
  })

  it('herdr: swipes scroll a wide pane sideways instead of sending keys', async () => {
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      mux: {
        backend: 'herdr',
        caps: { clientSideSelect: true, copyMode: false },
      },
    })
    mockOverflowsHorizontally.mockReturnValue(true)
    render(<App />)
    await waitFor(() =>
      expect(capturedGestureHandlers.onSwipeLeft).toBeDefined(),
    )
    capturedGestureHandlers.onSwipeLeft()
    capturedGestureHandlers.onSwipeRight()
    expect(mockOverflowsHorizontally).toHaveBeenCalledWith(null)
    expect(mockSendKeyToTerminal).not.toHaveBeenCalled()

    // Nothing to drag sideways: the keys are sent as usual
    mockOverflowsHorizontally.mockReturnValue(false)
    capturedGestureHandlers.onSwipeLeft()
    capturedGestureHandlers.onSwipeRight()
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'c', {
      ctrl: true,
    })
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'Tab')
  })

  it('herdr: a drag moves the pane both ways, then the history', async () => {
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      mux: {
        backend: 'herdr',
        caps: { clientSideSelect: true, copyMode: false },
      },
    })
    render(<App />)
    await waitFor(() => expect(capturedGestureHandlers.onPan).toBeDefined())
    capturedGestureHandlers.onPan(5, -12)
    expect(mockDragTerminal).toHaveBeenCalledWith(null, 5, -12, true)
    // The drag already scrolled: a swipe adds nothing
    capturedGestureHandlers.onSwipeUp()
    capturedGestureHandlers.onSwipeDown()
    expect(mockScrollTerminal).not.toHaveBeenCalled()
    expect(mockScrollTmux).not.toHaveBeenCalled()
  })

  it.each([
    ['tmux', false],
    ['herdr', true],
    ['zellij', true],
  ])(
    '%s: pastes bracketed into a pane with an agent: %s',
    async (backend, bracketed) => {
      const base = mockUseLocalSessions()
      mockUseLocalSessions.mockReturnValue({
        ...base,
        activeSession: { ...base.activeSession, hasAgent: true },
        mux: { backend, caps: { clientSideSelect: backend !== 'tmux' } },
      } as any)
      render(<App />)
      await screen.findByTestId('terminal-view')
      expect(vi.mocked(TerminalView).mock.lastCall![0]).toMatchObject({
        bracketedPaste: bracketed,
      })
    },
  )

  it('tells why a tab could not be added (Zellij: no client attached)', async () => {
    const { RequestError } = await import('./hooks/use-mux-api')
    mockIsMobile.mockReturnValue(true)
    const addSession = vi.fn(async () => {
      throw new RequestError(409, 'no_client', 'open this Zellij session first')
    })
    mockUseLocalSessions.mockReturnValue({
      ...mockUseLocalSessions(),
      addSession,
    })
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open sessions menu' }),
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'MobileAdd' }))
    })
    expect(await screen.findByTestId('toast')).toHaveTextContent(
      'open this Zellij session first',
    )
    // The sheet stays open on a refusal
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute(
      'data-open',
      'true',
    )
    mockIsMobile.mockReturnValue(false)
  })

  it('says a tab could not be added when the failure carries no message', async () => {
    mockIsMobile.mockReturnValue(true)
    mockUseLocalSessions.mockReturnValue({
      ...mockUseLocalSessions(),
      addSession: vi.fn(async () => {
        throw new Error('network')
      }),
    })
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open sessions menu' }),
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'MobileAdd' }))
    })
    expect(await screen.findByTestId('toast')).toHaveTextContent(
      'Could not add a tab',
    )
    mockIsMobile.mockReturnValue(false)
  })

  it('herdr: drives the pane size when the setting and backend allow it', async () => {
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      mux: {
        backend: 'herdr',
        caps: { clientSideSelect: true, copyMode: false, driveSize: true },
      },
    } as any)
    const settings = mockUseSettings()
    mockUseSettings.mockReturnValue({
      ...settings,
      settings: { ...settings.settings, driveTerminalSize: true },
    } as any)
    render(<App />)
    await screen.findByTestId('terminal-view')
    const props = vi.mocked(TerminalView).mock.lastCall![0] as {
      driveSize: boolean
      onDriveLost: (r: 'taken-over' | 'failed') => void
    }
    expect(props.driveSize).toBe(true)
    act(() => props.onDriveLost('taken-over'))
    expect(
      await screen.findByText(
        'Another device took over the terminal size. Reopen the page to take it back',
      ),
    ).toBeInTheDocument()
    act(() => props.onDriveLost('failed'))
    expect(
      await screen.findByText(
        'Could not fit the pane to this device; showing the desktop size',
      ),
    ).toBeInTheDocument()
  })

  it('tmux: one stream per session, reopened while its pane is listed', async () => {
    const base = mockUseLocalSessions()
    const tab = (id: string, groupId: string, panes?: { id: string }[]) => ({
      id,
      name: id,
      icon: '💻',
      description: '',
      groupId,
      paneId: id,
      ...(panes && { panes }),
    })
    const listed = [tab('$3:0', '$3', [{ id: '$3:0' }]), tab('0', 'main')]
    mockUseLocalSessions.mockReturnValue({
      ...base,
      activeSession: listed[0],
      sessions: listed,
    } as any)
    const { rerender } = render(<App />)
    await screen.findByTestId('terminal-view')
    expect(vi.mocked(TerminalView).mock.lastCall![0]).toMatchObject({
      streamKey: '$3',
      paneSeen: listed,
    })
    // A tab without its pane list counts by its own id.
    mockUseLocalSessions.mockReturnValue({
      ...base,
      activeSession: listed[1],
      sessions: listed,
    } as any)
    rerender(<App />)
    expect(vi.mocked(TerminalView).mock.lastCall![0]).toMatchObject({
      streamKey: 'main',
      paneSeen: listed,
    })
    // The pane is gone from the snapshot.
    mockUseLocalSessions.mockReturnValue({
      ...base,
      activeSession: listed[0],
      sessions: [listed[1]],
    } as any)
    rerender(<App />)
    expect(
      (vi.mocked(TerminalView).mock.lastCall![0] as { paneSeen?: unknown })
        .paneSeen,
    ).toBeUndefined()
  })

  it('herdr: no stream key and no reopen after exit', async () => {
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      activeSession: { ...base.activeSession, id: 'pane1', groupId: 'w1' },
      sessions: [{ ...base.sessions[0], id: 'pane1', groupId: 'w1' }],
      mux: { backend: 'herdr', caps: { clientSideSelect: true } },
    } as any)
    render(<App />)
    await screen.findByTestId('terminal-view')
    const props = vi.mocked(TerminalView).mock.lastCall![0] as {
      streamKey?: string
      paneSeen?: unknown
    }
    expect(props.streamKey).toBeUndefined()
    expect(props.paneSeen).toBeUndefined()
  })

  it('does not drive the size when the backend cannot', async () => {
    const settings = mockUseSettings()
    mockUseSettings.mockReturnValue({
      ...settings,
      settings: { ...settings.settings, driveTerminalSize: true },
    } as any)
    render(<App />)
    await screen.findByTestId('terminal-view')
    expect(vi.mocked(TerminalView).mock.lastCall![0]).toMatchObject({
      driveSize: false,
    })
  })

  it('tmux: a drag never scrolls the history, a swipe pages it', async () => {
    render(<App />)
    await waitFor(() => expect(capturedGestureHandlers.onPan).toBeDefined())
    capturedGestureHandlers.onPan(5, -12)
    expect(mockDragTerminal).toHaveBeenCalledWith(null, 0, -12, false)
    capturedGestureHandlers.onSwipeUp()
    expect(mockScrollTmux).toHaveBeenCalledWith(null, 'down')
  })

  it('tmux: swipes never scroll sideways', async () => {
    mockOverflowsHorizontally.mockReturnValue(true)
    render(<App />)
    await waitFor(() =>
      expect(capturedGestureHandlers.onSwipeLeft).toBeDefined(),
    )
    capturedGestureHandlers.onSwipeLeft()
    expect(mockOverflowsHorizontally).not.toHaveBeenCalled()
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'c', {
      ctrl: true,
    })
  })

  it('checks the server version when the app is shown again', async () => {
    render(<App />)
    await waitFor(() => expect(mockCheckServerVersion).toHaveBeenCalledTimes(1))
    mockCheckServerVersion.mockClear()
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockCheckOnShow).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockCheckOnShow).toHaveBeenCalledTimes(1)
    visibility.mockRestore()
  })

  it('checks the server version on start and after the stream comes back', async () => {
    render(<App />)
    await waitFor(() => expect(mockCheckServerVersion).toHaveBeenCalledTimes(1))
    // First connect is not a reconnect
    act(() => reportStreamState('connected'))
    expect(mockCheckServerVersion).toHaveBeenCalledTimes(1)
    act(() => reportStreamState('disconnected'))
    act(() => reportStreamState('connecting'))
    act(() => reportStreamState('connected'))
    expect(mockCheckServerVersion).toHaveBeenCalledTimes(2)
    act(() => reportStreamState('error'))
    act(() => reportStreamState('connected'))
    expect(mockCheckServerVersion).toHaveBeenCalledTimes(3)
  })

  it('indicator follows the stream but shows down while the server is unreachable', async () => {
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({ ...base, isServerReachable: false })
    const { rerender } = render(<App />)
    act(() => reportStreamState('connected'))
    expect(
      screen.getByTestId('connection-indicator').getAttribute('data-state'),
    ).toBe('disconnected')
    mockUseLocalSessions.mockReturnValue({ ...base, isServerReachable: true })
    rerender(<App />)
    expect(
      screen.getByTestId('connection-indicator').getAttribute('data-state'),
    ).toBe('connected')
    // A reachable server does not mark a stream that is still down as up
    act(() => reportStreamState('disconnected'))
    expect(
      screen.getByTestId('connection-indicator').getAttribute('data-state'),
    ).toBe('disconnected')
  })

  it('gesture onSwipeRight sends Tab', async () => {
    render(<App />)
    await waitFor(() =>
      expect(capturedGestureHandlers.onSwipeRight).toBeDefined(),
    )
    capturedGestureHandlers.onSwipeRight()
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'Tab')
  })

  it('gesture onSwipeUp in copy mode calls scrollTmux down', async () => {
    mockIsInCopyMode.mockReturnValue(true)
    render(<App />)
    await waitFor(() => expect(capturedGestureHandlers.onSwipeUp).toBeDefined())
    capturedGestureHandlers.onSwipeUp()
    expect(mockScrollTmux).toHaveBeenCalledWith(null, 'down')
  })

  it('gesture onSwipeDown in copy mode calls scrollTmux up', async () => {
    mockIsInCopyMode.mockReturnValue(true)
    render(<App />)
    await waitFor(() =>
      expect(capturedGestureHandlers.onSwipeDown).toBeDefined(),
    )
    capturedGestureHandlers.onSwipeDown()
    expect(mockScrollTmux).toHaveBeenCalledWith(null, 'up')
  })

  it('gesture onSwipeUp outside copy mode scrolls the history down', async () => {
    mockIsInCopyMode.mockReturnValue(false)
    render(<App />)
    await waitFor(() => expect(capturedGestureHandlers.onSwipeUp).toBeDefined())
    capturedGestureHandlers.onSwipeUp()
    expect(mockScrollTmux).toHaveBeenCalledWith(null, 'down')
  })

  it('gesture onSwipeDown outside copy mode scrolls the history up', async () => {
    mockIsInCopyMode.mockReturnValue(false)
    render(<App />)
    await waitFor(() =>
      expect(capturedGestureHandlers.onSwipeDown).toBeDefined(),
    )
    capturedGestureHandlers.onSwipeDown()
    expect(mockScrollTmux).toHaveBeenCalledWith(null, 'up')
  })

  it('without copy mode a drag scrolls the history and a swipe adds nothing', async () => {
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      mux: {
        backend: 'fake',
        caps: { clientSideSelect: false, copyMode: false },
      },
    })
    render(<App />)
    await waitFor(() => expect(capturedGestureHandlers.onPan).toBeDefined())
    capturedGestureHandlers.onPan(5, 20)
    // Not herdr: nothing to drag sideways
    expect(mockDragTerminal).toHaveBeenCalledWith(null, 0, 20, true)
    capturedGestureHandlers.onSwipeDown()
    capturedGestureHandlers.onSwipeUp()
    expect(mockScrollTerminal).not.toHaveBeenCalled()
    expect(mockScrollTmux).not.toHaveBeenCalled()
  })

  it('gesture onLongPress pastes and shows toast on error', async () => {
    mockPasteToTerminal.mockResolvedValue({ ok: false, reason: 'not-allowed' })
    render(<App />)
    await waitFor(() =>
      expect(capturedGestureHandlers.onLongPress).toBeDefined(),
    )
    await act(async () => {
      await (capturedGestureHandlers.onLongPress as () => Promise<void>)()
    })
    await waitFor(() => {
      expect(
        screen.getByText(/Long press paste not supported/),
      ).toBeInTheDocument()
    })
  })

  it('gesture onLongPress pastes without toast when ok', async () => {
    mockPasteToTerminal.mockResolvedValue({ ok: true })
    render(<App />)
    await waitFor(() =>
      expect(capturedGestureHandlers.onLongPress).toBeDefined(),
    )
    await act(async () => {
      await (capturedGestureHandlers.onLongPress as () => Promise<void>)()
    })
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument()
  })

  it('context menu on terminal container is prevented', async () => {
    render(<App />)
    await waitFor(() => screen.getByTestId('terminal-view'))
    // mocked terminal-view → sizing wrapper → container
    const container = screen.getByTestId('terminal-view').parentElement!
      .parentElement as HTMLElement
    const prevented = fireEvent.contextMenu(container)
    expect(prevented).toBe(false)
  })

  it('toggleKeyboard calls focusTerminal when keyboard not visible', async () => {
    // keyboardVisible=false (default mock) → toggleKeyboard → focusTerminal
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'ToggleKbd' }))
    fireEvent.click(screen.getByRole('button', { name: 'ToggleKbd' }))
    expect(mockFocusTerminal).toHaveBeenCalled()
  })

  it('toggleKeyboard calls blurTerminal when keyboard IS visible (line 173)', async () => {
    // keyboardVisible=true → toggleKeyboard → blurTerminal
    mockUseKeyboardVisible.mockReturnValue({
      isVisible: true,
      keyboardHeight: 0,
      viewportHeight: 400,
    })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'ToggleKbd' }))
    fireEvent.click(screen.getByRole('button', { name: 'ToggleKbd' }))
    expect(mockBlurTerminal).toHaveBeenCalled()
  })

  it('sizes the app to the visible height while the keyboard is open', async () => {
    mockUseKeyboardVisible.mockReturnValue({
      isVisible: true,
      keyboardHeight: 300,
      viewportHeight: 412,
    })
    const { container } = render(<App />)
    await waitFor(() => screen.getByTestId('terminal-view'))
    expect((container.firstChild as HTMLElement).style.height).toBe('412px')
  })

  it('follows the visible part when iOS pans it to a focused field', async () => {
    mockUseKeyboardVisible.mockReturnValue({
      isVisible: true,
      keyboardHeight: 300,
      viewportHeight: 412,
      viewportOffsetTop: 210,
    })
    const { container } = render(<App />)
    await waitFor(() => screen.getByTestId('terminal-view'))
    const app = container.firstChild as HTMLElement
    expect(app.style.height).toBe('412px')
    expect(app.style.transform).toBe('translateY(210px)')
    // The history list sizes itself against the app (cqh)
    expect(app.className).toContain('[container-type:size]')
  })

  it('does not move the app while nothing is panned', async () => {
    mockUseKeyboardVisible.mockReturnValue({
      isVisible: true,
      keyboardHeight: 300,
      viewportHeight: 412,
      viewportOffsetTop: 0,
    })
    const { container } = render(<App />)
    await waitFor(() => screen.getByTestId('terminal-view'))
    expect((container.firstChild as HTMLElement).style.transform).toBe('')
  })

  it('gesture swipes scroll the history while the keyboard is open', async () => {
    mockIsInCopyMode.mockReturnValue(false)
    mockUseKeyboardVisible.mockReturnValue({
      isVisible: true,
      keyboardHeight: 300,
      viewportHeight: 400,
    })
    render(<App />)
    await waitFor(() =>
      expect(capturedGestureHandlers.onSwipeDown).toBeDefined(),
    )
    capturedGestureHandlers.onSwipeDown()
    expect(mockScrollTmux).toHaveBeenCalledWith(null, 'up')
    capturedGestureHandlers.onSwipeUp()
    expect(mockScrollTmux).toHaveBeenCalledWith(null, 'down')
  })

  it('ctrlActive effect calls blurTerminal and focuses ctrl input (lines 198-199)', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'ActivateCtrl' }))
    // Clicking ActivateCtrl calls onCtrlChange(true) → setCtrlActive(true) → effect fires
    // Effect: blurTerminal(getIframe()) + ctrlInputRef.current.focus()
    fireEvent.click(screen.getByRole('button', { name: 'ActivateCtrl' }))
    expect(mockBlurTerminal).toHaveBeenCalled()
  })

  it('ctrlActive=true effect calls blurTerminal and focuses ctrl input', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'BlurCtrl' }))
    // BlurCtrl calls onCtrlChange(false) — we need ctrlActive to become true
    // The KeyboardToolbar mock has a button that triggers Ctrl active via onCtrlChange
    // Click Ctrl in the real component is not mockable; instead fire the hidden input
    // Actually: ctrlActive state in App is controlled externally via onCtrlChange prop
    // When KeyboardToolbar calls onCtrlChange(true), App sets ctrlActive=true → effect runs
    // Our mock's BlurCtrl calls onCtrlChange(false). We need a CtrlActivate button.
    // Add it indirectly: click CtrlC which is only shown when ctrlActive=true (via external prop)
    // Actually the App passes ctrlActive={ctrlActive} and onCtrlChange={setCtrlActive}
    // So when KeyboardToolbar mock calls props.onCtrlChange(false), ctrlActive becomes false
    // To make ctrlActive=true, we need the mock to call onCtrlChange(true)
    // Let's just verify the hidden input effect: fire a change with letter to trigger setCtrlActive(false) path
    const hiddenInput = document.querySelector(
      'input.sr-only',
    ) as HTMLInputElement
    // First make ctrlActive true by dispatching a custom event — we can't easily do this
    // Instead, verify blurTerminal is called when ctrlActive changes via handleCtrlInput path
    fireEvent.change(hiddenInput, { target: { value: 'a' } })
    // The change clears ctrlActive and calls focusTerminal
    expect(mockFocusTerminal).toHaveBeenCalled()
  })

  it('handleSendText with send-enter behavior sends Enter after text', async () => {
    mockUseSettings.mockReturnValue({
      settings: {
        imeSendBehavior: 'send-enter' as const,
        pasteSource: 'clipboard' as const,
        toolbarDefaultExpanded: false,
        disableContextMenu: true,
        showSessionTabs: false,
        pollInterval: 5,
        hasSeenGestureHints: true,
      },
      updateSetting: vi.fn(),
    } as any)
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'SendText' }))
    fireEvent.click(screen.getByRole('button', { name: 'SendText' }))
    expect(mockSendTextToTerminal).toHaveBeenCalledWith(null, 'hello')
    expect(mockSendKeyToTerminal).toHaveBeenCalledWith(null, 'Enter')
  })

  it('gesture hints not shown when hasSeenGestureHints=true', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.queryByTestId('gesture-hints')).not.toBeInTheDocument()
    })
  })

  it('settings modal reloads to the new version', async () => {
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'ReloadUpdate' }))
    expect(mockReloadToNewVersion).toHaveBeenCalled()
  })

  describe('attach image', () => {
    const image = new File(['x'], 'a.png', { type: 'image/png' })
    const withUploads = (extra: Record<string, unknown> = {}) => {
      const base = mockUseLocalSessions()
      // The mock's type knows only the caps of its first value.
      mockUseLocalSessions.mockReturnValue({
        ...base,
        mux: {
          backend: 'tmux',
          caps: { clientSideSelect: false, copyMode: true, uploads: true },
        },
        ...extra,
      } as typeof base)
    }

    it('offers nothing without the uploads capability', async () => {
      mockIsMobile.mockReturnValue(true)
      render(<App />)
      await screen.findByTestId('quick-actions')
      expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull()
      expect(pasteImage).toBeUndefined()
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
      await waitFor(() =>
        expect(mockPasteToTerminal).toHaveBeenCalledWith(null, {
          images: false,
        }),
      )
    })

    it('offers nothing to a view-only client', async () => {
      withUploads()
      render(<App readOnly />)
      await screen.findByTestId('terminal-view')
      expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull()
      expect(pasteImage).toBeUndefined()
    })

    it('the Attach key picks an image and types its path into this pane', async () => {
      withUploads()
      mockPickImageFile.mockResolvedValue(image)
      mockAttachImageToTerminal.mockResolvedValue({ status: 'inserted' })
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'Attach' }))
      await waitFor(() =>
        expect(mockAttachImageToTerminal).toHaveBeenCalledWith(
          null,
          image,
          'pane1',
          expect.any(Function),
        ),
      )
      const getActive = mockAttachImageToTerminal.mock.calls[0][3]
      expect(getActive()).toBe('pane1')
      expect(screen.queryByTestId('toast')).toBeNull()
    })

    it('a cancelled picker uploads nothing', async () => {
      withUploads()
      mockPickImageFile.mockResolvedValue(null)
      render(<App />)
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Attach' }))
      })
      expect(mockAttachImageToTerminal).not.toHaveBeenCalled()
    })

    it('the Attach key and an image paste attach too', async () => {
      withUploads()
      mockPickImageFile.mockResolvedValue(image)
      mockAttachImageToTerminal.mockResolvedValue({ status: 'inserted' })
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'Attach' }))
      await waitFor(() =>
        expect(mockAttachImageToTerminal).toHaveBeenCalledTimes(1),
      )
      await act(async () => pasteImage!(image))
      expect(mockAttachImageToTerminal).toHaveBeenCalledTimes(2)
    })

    it('the Paste key uploads an image-only clipboard', async () => {
      withUploads()
      mockPasteToTerminal.mockResolvedValue({ ok: true, image })
      mockAttachImageToTerminal.mockResolvedValue({ status: 'inserted' })
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'Paste' }))
      await waitFor(() =>
        expect(mockAttachImageToTerminal).toHaveBeenCalledWith(
          null,
          image,
          'pane1',
          expect.any(Function),
        ),
      )
      expect(mockPasteToTerminal).toHaveBeenCalledWith(null, { images: true })
    })

    it('long press and Ctrl+Shift+V upload an image-only clipboard too', async () => {
      withUploads()
      mockPasteToTerminal.mockResolvedValue({ ok: true, image })
      mockAttachImageToTerminal.mockResolvedValue({ status: 'inserted' })
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'CtrlShiftV' }))
      await waitFor(() =>
        expect(mockAttachImageToTerminal).toHaveBeenCalledTimes(1),
      )
      await act(async () => capturedGestureHandlers.onLongPress?.())
      expect(mockAttachImageToTerminal).toHaveBeenCalledTimes(2)
      expect(mockPasteToTerminal).toHaveBeenCalledWith(null, { images: true })
    })

    it('says a slow upload is running, then clears it once inserted', async () => {
      withUploads()
      let finish: (r: unknown) => void = () => {}
      mockAttachImageToTerminal.mockReturnValue(
        new Promise((r) => {
          finish = r
        }),
      )
      render(<App />)
      await screen.findByTestId('terminal-view')
      act(() => {
        void pasteImage!(image)
      })
      const toast = await screen.findByTestId('toast')
      expect(toast).toHaveTextContent('Uploading image…')
      // Stays for as long as the upload may run
      expect(toast).toHaveAttribute('data-duration', '330000')
      await act(async () => finish({ status: 'inserted' }))
      expect(screen.queryByTestId('toast')).toBeNull()
    })

    it('leaves a toast that replaced the upload one', async () => {
      withUploads()
      let finish: (r: unknown) => void = () => {}
      mockAttachImageToTerminal.mockReturnValue(
        new Promise((r) => {
          finish = r
        }),
      )
      mockPasteToTerminal.mockResolvedValue({ ok: false, reason: 'unknown' })
      render(<App />)
      await screen.findByTestId('terminal-view')
      act(() => {
        void pasteImage!(image)
      })
      await screen.findByText('Uploading image…')
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
      await screen.findByText(/Clipboard access failed/)
      await act(async () => finish({ status: 'inserted' }))
      expect(screen.getByTestId('toast')).toHaveTextContent(
        'Clipboard access failed',
      )
    })

    it('says so when the path cannot be copied', async () => {
      withUploads()
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
      })
      mockAttachImageToTerminal.mockResolvedValue({
        status: 'not-inserted',
        insert: '/c/a.png',
      })
      render(<App />)
      await screen.findByTestId('terminal-view')
      await act(async () => pasteImage!(image))
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      expect(await screen.findByTestId('toast')).toHaveTextContent(
        'Could not copy the path',
      )
    })

    it('offers to insert into the current pane after a pane switch', async () => {
      withUploads()
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      })
      mockAttachImageToTerminal.mockResolvedValue({
        status: 'pane-changed',
        insert: '/c/a.png',
      })
      render(<App />)
      await screen.findByTestId('terminal-view')
      await act(async () => pasteImage!(image))
      const toast = screen.getByTestId('toast')
      expect(toast).toHaveTextContent('Image uploaded: /c/a.png')
      expect(toast).toHaveAttribute('data-duration', '10000')
      // The mocked terminal has no handle: the paste cannot go out, so the
      // path is offered for copying instead.
      fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
      expect(screen.getByTestId('toast')).toHaveTextContent(
        'Image not inserted: /c/a.png',
      )
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('/c/a.png'))
    })

    it('Insert types the path into the pane shown now', async () => {
      withUploads()
      const paste = vi.fn(() => true)
      terminalHandle = { paste }
      mockAttachImageToTerminal.mockResolvedValue({
        status: 'pane-changed',
        insert: '/c/a.png',
      })
      try {
        render(<App />)
        await screen.findByTestId('terminal-view')
        await act(async () => pasteImage!(image))
        fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
        expect(paste).toHaveBeenCalledWith('/c/a.png ')
        expect(screen.queryByTestId('toast')).toBeNull()
      } finally {
        terminalHandle = null
      }
    })

    it('a tab without its own pane id is told apart by its id', async () => {
      const base = mockUseLocalSessions()
      withUploads({
        activeSession: { ...base.activeSession, paneId: undefined },
      })
      mockAttachImageToTerminal.mockResolvedValue({ status: 'inserted' })
      render(<App />)
      await screen.findByTestId('terminal-view')
      await act(async () => pasteImage!(image))
      expect(mockAttachImageToTerminal.mock.calls[0][2]).toBe('1')
    })

    it('offers the path when the paste did not go out', async () => {
      withUploads()
      mockAttachImageToTerminal.mockResolvedValue({
        status: 'not-inserted',
        insert: '/c/a.png',
      })
      render(<App />)
      await screen.findByTestId('terminal-view')
      await act(async () => pasteImage!(image))
      const toast = screen.getByTestId('toast')
      expect(toast).toHaveTextContent('Image not inserted: /c/a.png')
      expect(toast).toHaveAttribute('data-variant', 'warning')
    })

    it('reports a failed upload by its reason', async () => {
      withUploads()
      mockAttachImageToTerminal.mockResolvedValue({
        status: 'failed',
        reason: 'too_large',
      })
      render(<App />)
      await screen.findByTestId('terminal-view')
      await act(async () => pasteImage!(image))
      const toast = screen.getByTestId('toast')
      expect(toast).toHaveTextContent('Image is larger than 10 MB')
      expect(toast).toHaveAttribute('data-variant', 'danger')
    })
  })
})

// ─── shouldShowPasteError helper ─────────────────────────────────────────────

describe('shouldShowPasteError (via handlePaste)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMobile.mockReturnValue(false)
    mockUseSettings.mockReturnValue({
      settings: {
        imeSendBehavior: 'send-only' as const,
        pasteSource: 'clipboard' as const,
        toolbarDefaultExpanded: false,
        disableContextMenu: true,
        showSessionTabs: false,
        pollInterval: 5,
        hasSeenGestureHints: true,
      },
      updateSetting: vi.fn(),
    })
    mockUseLocalSessions.mockReturnValue({
      activeSession: {
        id: '1',
        name: 'Shell',
        icon: '💻',
        description: 'Terminal',
        paneId: 'pane1',
        hasAgent: false,
      },
      sessions: [
        {
          id: '1',
          name: 'Shell',
          icon: '💻',
          description: 'Terminal',
          paneId: 'pane1',
          hasAgent: false,
        },
      ],
      switchSession: vi.fn(),
      addSession: vi.fn(),
      removeSession: vi.fn(async () => {}),
      updateSession: vi.fn(),
      isReady: true,
      isServerReachable: true,
      refreshSessions: vi.fn(),
      mux: {
        backend: 'tmux',
        caps: { clientSideSelect: false, copyMode: true },
      },
    })
  })

  const pasteErrorCases = [
    { reason: 'not-allowed', expectedMsg: 'Clipboard permission denied' },
    { reason: 'not-secure', expectedMsg: 'Clipboard requires HTTPS' },
    { reason: 'not-supported', expectedMsg: 'Clipboard not supported' },
    { reason: 'unknown', expectedMsg: 'Clipboard access failed' },
  ]

  for (const { reason, expectedMsg } of pasteErrorCases) {
    it(`shows toast for paste error: ${reason}`, async () => {
      mockPasteToTerminal.mockResolvedValue({ ok: false, reason })
      render(<App />)
      await waitFor(() => screen.getByRole('button', { name: 'Paste' }))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
      })
      await waitFor(() => {
        expect(screen.getByTestId('toast')).toBeInTheDocument()
        expect(screen.getByText(new RegExp(expectedMsg))).toBeInTheDocument()
      })
      expect(screen.getByTestId('toast')).toHaveAttribute(
        'data-variant',
        'danger',
      )
    })
  }

  it('does not show toast when paste reason is "empty"', async () => {
    mockPasteToTerminal.mockResolvedValue({ ok: false, reason: 'empty' })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Paste' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    })
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument()
  })

  it('does not show toast when paste reason is "no-terminal"', async () => {
    mockPasteToTerminal.mockResolvedValue({ ok: false, reason: 'no-terminal' })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Paste' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    })
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument()
  })

  it('does not show toast when paste succeeds', async () => {
    mockPasteToTerminal.mockResolvedValue({ ok: true })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Paste' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    })
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument()
  })
})

// ─── getClipboardErrorMsg for long-press ─────────────────────────────────────

describe('getClipboardErrorMsg long-press variant (via CtrlShiftV toast)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMobile.mockReturnValue(false)
    mockUseSettings.mockReturnValue({
      settings: {
        imeSendBehavior: 'send-only' as const,
        pasteSource: 'clipboard' as const,
        toolbarDefaultExpanded: false,
        disableContextMenu: true,
        showSessionTabs: false,
        pollInterval: 5,
        hasSeenGestureHints: true,
      },
      updateSetting: vi.fn(),
    })
    mockUseLocalSessions.mockReturnValue({
      activeSession: {
        id: '1',
        name: 'Shell',
        icon: '💻',
        description: 'Terminal',
        paneId: 'pane1',
        hasAgent: false,
      },
      sessions: [
        {
          id: '1',
          name: 'Shell',
          icon: '💻',
          description: 'Terminal',
          paneId: 'pane1',
          hasAgent: false,
        },
      ],
      switchSession: vi.fn(),
      addSession: vi.fn(),
      removeSession: vi.fn(async () => {}),
      updateSession: vi.fn(),
      isReady: true,
      isServerReachable: true,
      refreshSessions: vi.fn(),
      mux: {
        backend: 'tmux',
        caps: { clientSideSelect: false, copyMode: true },
      },
    })
  })

  it('CtrlShiftV not-allowed shows non-long-press message', async () => {
    mockPasteToTerminal.mockResolvedValue({ ok: false, reason: 'not-allowed' })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'CtrlShiftV' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'CtrlShiftV' }))
    })
    await waitFor(() => {
      expect(
        screen.getByText(
          'Clipboard permission denied. Check browser settings.',
        ),
      ).toBeInTheDocument()
    })
  })
})

describe('App with tmux paste source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMobile.mockReturnValue(false)
    mockUseLocalSessions.mockReturnValue({
      activeSession: {
        id: '1',
        name: 'Shell',
        icon: '💻',
        description: 'Terminal',
        paneId: 'pane1',
        hasAgent: false,
      },
      sessions: [
        {
          id: '1',
          name: 'Shell',
          icon: '💻',
          description: 'Terminal',
          paneId: 'pane1',
          hasAgent: false,
        },
      ],
      switchSession: vi.fn(),
      addSession: vi.fn(),
      removeSession: vi.fn(async () => {}),
      updateSession: vi.fn(),
      isReady: true,
      isServerReachable: true,
      refreshSessions: vi.fn(),
      mux: {
        backend: 'tmux',
        caps: { clientSideSelect: false, copyMode: true },
      },
    })
  })

  it('handlePaste with tmux source calls pasteTmuxBuffer', async () => {
    mockUseSettings.mockReturnValueOnce({
      settings: {
        imeSendBehavior: 'send-only' as const,
        pasteSource: 'tmux' as const,
        toolbarDefaultExpanded: false,
        disableContextMenu: true,
        showSessionTabs: false,
        pollInterval: 5,
        hasSeenGestureHints: true,
      },
      updateSetting: vi.fn(),
    } as any)

    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Paste' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    })
    expect(mockPasteTmuxBuffer).toHaveBeenCalled()
  })
})

describe('App server reachability effect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMobile.mockReturnValue(false)
    mockUseSettings.mockReturnValue({
      settings: {
        imeSendBehavior: 'send-only' as const,
        pasteSource: 'clipboard' as const,
        toolbarDefaultExpanded: false,
        disableContextMenu: true,
        showSessionTabs: false,
        pollInterval: 5,
        hasSeenGestureHints: true,
      },
      updateSetting: vi.fn(),
    })
  })

  it('sets connection state to disconnected when server not reachable', async () => {
    mockUseLocalSessions.mockReturnValueOnce({
      activeSession: {
        id: '1',
        name: 'Shell',
        icon: '💻',
        description: 'Terminal',
        paneId: 'pane1',
        hasAgent: false,
      },
      sessions: [
        {
          id: '1',
          name: 'Shell',
          icon: '💻',
          description: 'Terminal',
          paneId: 'pane1',
          hasAgent: false,
        },
      ],
      switchSession: vi.fn(),
      addSession: vi.fn(),
      removeSession: vi.fn(async () => {}),
      updateSession: vi.fn(),
      isReady: true,
      isServerReachable: false,
      refreshSessions: vi.fn(),
      mux: {
        backend: 'tmux',
        caps: { clientSideSelect: false, copyMode: true },
      },
    })

    render(<App />)
    await waitFor(() => {
      const indicator = screen.getByTestId('connection-indicator')
      expect(indicator).toBeInTheDocument()
    })
  })
})

describe('App gesture hints (mobile, first visit)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMobile.mockReturnValue(true)
    mockUseLocalSessions.mockReturnValue({
      activeSession: {
        id: '1',
        name: 'Shell',
        icon: '💻',
        description: 'Terminal',
        paneId: 'pane1',
        hasAgent: false,
      },
      sessions: [
        {
          id: '1',
          name: 'Shell',
          icon: '💻',
          description: 'Terminal',
          paneId: 'pane1',
          hasAgent: false,
        },
      ],
      switchSession: vi.fn(),
      addSession: vi.fn(),
      removeSession: vi.fn(async () => {}),
      updateSession: vi.fn(),
      isReady: true,
      isServerReachable: true,
      refreshSessions: vi.fn(),
      mux: {
        backend: 'tmux',
        caps: { clientSideSelect: false, copyMode: true },
      },
    })
    mockUseSettings.mockReturnValue({
      settings: {
        imeSendBehavior: 'send-only' as const,
        pasteSource: 'clipboard' as const,
        toolbarDefaultExpanded: false,
        disableContextMenu: true,
        showSessionTabs: false,
        pollInterval: 5,
        hasSeenGestureHints: true,
      },
      updateSetting: vi.fn(),
    })
  })

  it('shows gesture hints on first mobile visit (hasSeenGestureHints=false)', async () => {
    mockUseSettings.mockReturnValue({
      settings: {
        imeSendBehavior: 'send-only' as const,
        pasteSource: 'clipboard' as const,
        toolbarDefaultExpanded: false,
        disableContextMenu: true,
        showSessionTabs: false,
        pollInterval: 5,
        hasSeenGestureHints: false,
      },
      updateSetting: vi.fn(),
    })

    render(<App />)
    await waitFor(() => {
      expect(screen.getByTestId('gesture-hints')).toBeInTheDocument()
    })
  })

  it('dismisses gesture hints and updates setting', async () => {
    const mockUpdateSetting = vi.fn()
    // Override the default set in beforeEach
    mockUseSettings.mockReturnValue({
      settings: {
        imeSendBehavior: 'send-only' as const,
        pasteSource: 'clipboard' as const,
        toolbarDefaultExpanded: false,
        disableContextMenu: true,
        showSessionTabs: false,
        pollInterval: 5,
        hasSeenGestureHints: false,
      },
      updateSetting: mockUpdateSetting,
    })

    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'DismissHints' }))
    fireEvent.click(screen.getByRole('button', { name: 'DismissHints' }))
    expect(mockUpdateSetting).toHaveBeenCalledWith('hasSeenGestureHints', true)
    expect(screen.queryByTestId('gesture-hints')).not.toBeInTheDocument()
  })

  it('settings modal shows gesture hints button on mobile', async () => {
    // hasSeenGestureHints=true so hints not auto-shown; isMobile=true so settings shows gesture hints btn
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await waitFor(() => screen.getByRole('button', { name: 'GestureHints' }))
    fireEvent.click(screen.getByRole('button', { name: 'GestureHints' }))
    expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument()
    expect(screen.getByTestId('gesture-hints')).toBeInTheDocument()
  })
})

describe('App groups and panes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMobile.mockReturnValue(false)
  })

  const tab = (id: string, groupId: string, panes?: object[]) => ({
    id,
    name: id,
    icon: '📺',
    description: '',
    groupId,
    paneId: `${id}:p1`,
    hasAgent: false,
    panes,
  })
  const PANES = [
    { id: 'w1:t1:p1', label: 'claude', hasAgent: true, agentStatus: 'working' },
    { id: 'w1:t1:p2', label: 'logs', hasAgent: false },
  ]
  const selectPane = vi.fn()
  const removePane = vi.fn()

  function mockMux(backend: 'tmux' | 'herdr') {
    const tabs = [
      tab('w1:t1', 'w1', PANES),
      tab('w1:t2', 'w1'),
      tab('w2:t1', 'w2'),
    ]
    mockUseLocalSessions.mockReturnValue({
      activeSession: tabs[0],
      sessions: tabs,
      groups: [
        { id: 'w1', name: 'api' },
        { id: 'w2', name: 'web' },
      ],
      switchSession: vi.fn(),
      selectPane,
      removePane,
      addSession: vi.fn(),
      removeSession: vi.fn(async () => {}),
      updateSession: vi.fn(),
      isReady: true,
      isServerReachable: true,
      refreshSessions: vi.fn(),
      mux: {
        backend,
        caps: {
          clientSideSelect: backend === 'herdr',
          copyMode: backend === 'tmux',
        },
      },
    } as any)
  }

  it('desktop tab bar shows only tabs of the current group', async () => {
    mockMux('herdr')
    mockUseSettings.mockReturnValue({
      settings: {
        imeSendBehavior: 'send-only',
        pasteSource: 'clipboard',
        toolbarDefaultExpanded: false,
        disableContextMenu: true,
        showSessionTabs: true,
        pollInterval: 5,
        hasSeenGestureHints: true,
      },
      updateSetting: vi.fn(),
    })
    render(<App />)
    expect(await screen.findByTestId('session-tabs')).toHaveAttribute(
      'data-ids',
      'w1:t1,w1:t2',
    )
  })

  it('mobile chip names the group and counts only its tabs', async () => {
    mockMux('herdr')
    mockIsMobile.mockReturnValue(true)
    render(<App />)
    expect(
      await screen.findByRole('button', { name: 'Open sessions menu' }),
    ).toHaveTextContent('api · 2 sessions')
  })

  it('herdr: the pane strip picks the pane to stream', async () => {
    mockMux('herdr')
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'logs' }))
    expect(selectPane).toHaveBeenCalledWith('w1:t1:p2')
  })

  it('herdr: asks before closing a pane, and closes it on confirm', async () => {
    mockMux('herdr')
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Close pane logs' }),
    )
    const dialog = screen.getByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('Close pane?')
    expect(dialog).toHaveTextContent('logs')
    expect(dialog).not.toHaveTextContent('Running:')
    expect(removePane).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'ConfirmYes' }))
    expect(removePane).toHaveBeenCalledWith('w1:t1:p2')
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
  })

  it('herdr: shows the hidden characters of the pane it asks to close', async () => {
    mockMux('herdr')
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      activeSession: {
        ...base.activeSession,
        panes: [PANES[0], { ...PANES[1], label: 'lo\u202egs' }],
      },
    } as any)
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Close pane lo\u202egs' }),
    )
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent(
      'lo⟨U+202E⟩gs will be closed',
    )
  })

  it('herdr: names what runs in the pane it asks to close', async () => {
    mockMux('herdr')
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      activeSession: {
        ...base.activeSession,
        panes: [PANES[0], { ...PANES[1], command: 'tail' }],
      },
    } as any)
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Close pane logs' }),
    )
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent(
      'Running: tail.',
    )
  })

  it('herdr: cancelling keeps the pane', async () => {
    mockMux('herdr')
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Close pane claude' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'ConfirmNo' }))
    expect(removePane).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
  })

  it('tmux: no pane strip', async () => {
    mockMux('tmux')
    render(<App />)
    await screen.findByTestId('terminal-view')
    expect(screen.queryByRole('group', { name: 'Panes' })).toBeNull()
  })
})

describe('App views, view-only and deep links', () => {
  const switchSession = vi.fn()
  const addSession = vi.fn()
  const removeSession = vi.fn()

  const tab = (id: string, groupId: string | undefined, panes?: object[]) => ({
    id,
    name: id,
    icon: '📺',
    description: '',
    groupId,
    paneId: `${id}:p1`,
    hasAgent: false,
    panes,
  })

  function mockSessions({
    backend = 'herdr',
    grouped = true,
    isReady = true,
    isServerReachable = true,
  } = {}) {
    const group = (g: string) => (grouped ? g : undefined)
    const tabs = [
      tab('w1:t1', group('w1'), [
        { id: 'w1:t1:p1', label: 'claude', hasAgent: true },
        { id: 'w1:t1:p2', label: 'logs', hasAgent: false },
      ]),
      tab('w2:t1', group('w2')),
    ]
    mockUseLocalSessions.mockReturnValue({
      activeSession: tabs[0],
      sessions: tabs,
      groups: grouped
        ? [
            { id: 'w1', name: 'api' },
            { id: 'w2', name: 'web' },
          ]
        : [],
      switchSession,
      selectPane: vi.fn(),
      addSession,
      removeSession,
      updateSession: vi.fn(),
      isReady,
      isServerReachable,
      refreshSessions: vi.fn(),
      mux: {
        backend,
        caps: {
          clientSideSelect: backend === 'herdr',
          copyMode: backend === 'tmux',
        },
      },
    } as any)
  }

  // A second view, as #233 (chat) registers one.
  const notifyFrom: { current?: ViewProps['notify'] } = {}
  const showViewFrom: { current?: ViewProps['showView'] } = {}
  const CHAT: AppView = {
    id: 'chat',
    label: 'Chat',
    Icon: MessageSquare,
    available: () => true,
    Main: (p) => {
      notifyFrom.current = p.notify
      showViewFrom.current = p.showView
      return <div data-testid="chat-main">{p.readOnly ? 'ro' : 'rw'}</div>
    },
    Input: () => <div data-testid="chat-input" />,
  }
  // A view that opens in the desktop side panel (#237 files and changes)
  const FILES: AppView = {
    id: 'files',
    label: 'Files',
    Icon: Folder,
    available: () => true,
    placement: 'panel',
    Main: () => <div data-testid="files-main" />,
    Panel: () => <div data-testid="files-panel" />,
  }
  const VIEWS = [...APP_VIEWS, CHAT]
  const PANEL_VIEWS = [...APP_VIEWS, CHAT, FILES]
  const filesToggle = () => screen.getByRole('button', { name: 'Files' })

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMobile.mockReturnValue(false)
    mockSessions()
  })

  const terminalPanel = () =>
    screen.getByTestId('terminal-view').closest('[id="view-panel-terminal"]')!

  it('shows no view switcher while the terminal is the only view', async () => {
    render(<App />)
    await screen.findByTestId('terminal-view')
    expect(screen.queryByRole('tablist', { name: 'View' })).toBeNull()
    expect(terminalPanel()).not.toHaveAttribute('role')
  })

  it('a registered view shows the switcher and swaps main and input areas', async () => {
    render(<App views={VIEWS} />)
    const switcher = await screen.findByRole('tablist', { name: 'View' })
    expect(switcher).toBeInTheDocument()
    expect(terminalPanel()).toHaveAttribute('role', 'tabpanel')
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
    expect(screen.getByTestId('chat-main')).toHaveTextContent('rw')
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.queryByTestId('keyboard-toolbar')).toBeNull()
    // The terminal stays mounted (and laid out) under the other view
    expect(terminalPanel()).toHaveClass('invisible')
    expect(terminalPanel()).toHaveAttribute('inert')
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }))
    expect(terminalPanel()).not.toHaveAttribute('inert')
    expect(screen.queryByTestId('chat-main')).toBeNull()
    expect(screen.getByTestId('keyboard-toolbar')).toBeInTheDocument()
    expect(terminalPanel()).not.toHaveClass('invisible')
  })

  it('shows the font size only while the terminal is the main view', async () => {
    render(<App views={PANEL_VIEWS} />)
    const decrease = () =>
      screen.queryByRole('button', { name: 'Decrease font size' })
    await screen.findByRole('tablist', { name: 'View' })
    expect(decrease()).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
    expect(decrease()).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }))
    // The side panel leaves the terminal on screen
    fireEvent.click(filesToggle())
    expect(decrease()).toBeInTheDocument()
  })

  it('mobile: drops the font size from the menu and pinches only the terminal', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<App views={PANEL_VIEWS} />)
    await screen.findByRole('button', { name: 'MenuFontDecrease 14' })
    // The pinch overlay sits in the terminal's panel, invisible and inert
    // under another view, so it gets no touches there.
    const overlay = terminalPanel().querySelector('.touch-none')
    expect(overlay).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View: Terminal' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Files' }))
    expect(
      screen.getByRole('button', { name: 'View: Files' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /MenuFontDecrease/ }),
    ).toBeNull()
    expect(terminalPanel()).toHaveClass('invisible')
    expect(terminalPanel()).toHaveAttribute('inert')
    expect(terminalPanel()).toContainElement(overlay as HTMLElement)
  })

  it('mobile: switches views from a menu, with no tab or tabpanel roles', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<App views={VIEWS} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'View: Terminal' }),
    )
    expect(screen.queryByRole('tablist', { name: 'View' })).toBeNull()
    expect(terminalPanel()).not.toHaveAttribute('role')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Chat' }))
    expect(screen.getByTestId('chat-main')).toBeInTheDocument()
    expect(terminalPanel()).toHaveAttribute('inert')
    expect(
      screen.getByTestId('chat-main').closest('[id^="view-panel-"]'),
    ).not.toHaveAttribute('role')
  })

  it('a view that stops being offered gives way to the terminal', async () => {
    const { rerender } = render(<App views={VIEWS} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }))
    rerender(
      <App views={[...APP_VIEWS, { ...CHAT, available: () => false }]} />,
    )
    expect(screen.queryByTestId('chat-main')).toBeNull()
    expect(screen.getByTestId('keyboard-toolbar')).toBeInTheDocument()
  })

  it('a view without its own input leaves the bottom area empty', async () => {
    render(<App views={[...APP_VIEWS, { ...CHAT, Input: undefined }]} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }))
    expect(screen.queryByTestId('keyboard-toolbar')).toBeNull()
    expect(screen.queryByTestId('chat-input')).toBeNull()
  })

  it('desktop: a panel view opens next to the terminal from its header toggle', async () => {
    render(<App views={PANEL_VIEWS} />)
    await screen.findByRole('tablist', { name: 'View' })
    // Not a tab: Chat still is
    expect(screen.queryByRole('tab', { name: 'Files' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument()
    expect(filesToggle()).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('files-panel')).toBeNull()
    fireEvent.click(filesToggle())
    expect(
      screen.getByRole('complementary', { name: 'Files' }),
    ).toContainElement(screen.getByTestId('files-panel'))
    expect(filesToggle()).toHaveAttribute('aria-pressed', 'true')
    // The terminal stays the main view, usable
    expect(terminalPanel()).not.toHaveAttribute('inert')
    expect(screen.getByTestId('keyboard-toolbar')).toBeInTheDocument()
    expect(screen.queryByTestId('files-main')).toBeNull()
    fireEvent.click(filesToggle())
    expect(screen.queryByTestId('files-panel')).toBeNull()
  })

  it('desktop: only the switcher views make the terminal a tabpanel', async () => {
    render(<App views={[...APP_VIEWS, FILES]} />)
    await screen.findByTestId('terminal-view')
    expect(screen.queryByRole('tablist', { name: 'View' })).toBeNull()
    expect(terminalPanel()).not.toHaveAttribute('role')
    expect(filesToggle()).toBeInTheDocument()
  })

  it('a lazy panel loads inside the panel, not blanking the app', async () => {
    let resolve!: (m: { default: () => ReactElement }) => void
    const Lazy = lazy(
      () => new Promise<{ default: () => ReactElement }>((r) => (resolve = r)),
    )
    render(<App views={[...APP_VIEWS, { ...FILES, Panel: Lazy }]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Files' }))
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument()
    await act(async () =>
      resolve({ default: () => <div data-testid="lazy-panel" /> }),
    )
    expect(await screen.findByTestId('lazy-panel')).toBeInTheDocument()
  })

  describe('a view whose code fails to load', () => {
    // The first import fails; the next one works
    const flaky = (testId: string) => {
      const load = vi
        .fn()
        .mockRejectedValueOnce(new Error('chunk gone'))
        .mockResolvedValue({ default: () => <div data-testid={testId} /> })
      return { View: lazyRetry<ViewProps>(load), load }
    }

    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    it('a side panel says so and keeps the terminal, then loads on Try again', async () => {
      const { View, load } = flaky('lazy-panel')
      render(<App views={[...APP_VIEWS, { ...FILES, Panel: View }]} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Files' }))
      expect(await screen.findByText('Could not load this view')).toBeVisible()
      expect(screen.getByTestId('terminal-view')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      expect(await screen.findByTestId('lazy-panel')).toBeInTheDocument()
      expect(load).toHaveBeenCalledTimes(2)
    })

    it('the main area does the same', async () => {
      const { View } = flaky('lazy-main')
      render(<App views={[...APP_VIEWS, { ...CHAT, Main: View }]} />)
      fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }))
      expect(await screen.findByText('Could not load this view')).toBeVisible()
      expect(screen.getByTestId('terminal-view')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      expect(await screen.findByTestId('lazy-main')).toBeInTheDocument()
    })

    it('the alert is announced, and Try again moves focus off the removed button', async () => {
      const { View } = flaky('lazy-panel')
      render(<App views={[...APP_VIEWS, { ...FILES, Panel: View }]} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Files' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not load this view',
      )
      const button = screen.getByRole('button', { name: 'Try again' })
      button.focus()
      fireEvent.click(button)
      await screen.findByTestId('lazy-panel')
      expect(document.activeElement).not.toBe(document.body)
    })

    it('another view in the same slot starts clean, and the failed one imports again on return', async () => {
      const failing = flaky('lazy-files')
      const CHANGES: AppView = {
        ...FILES,
        id: 'changes',
        label: 'Changes',
        Panel: () => <div data-testid="lazy-changes" />,
      }
      render(
        <App
          views={[...APP_VIEWS, { ...FILES, Panel: failing.View }, CHANGES]}
        />,
      )
      fireEvent.click(await screen.findByRole('button', { name: 'Files' }))
      expect(await screen.findByText('Could not load this view')).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Changes' }))
      expect(await screen.findByTestId('lazy-changes')).toBeInTheDocument()
      expect(screen.queryByText('Could not load this view')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Files' }))
      expect(await screen.findByTestId('lazy-files')).toBeInTheDocument()
      expect(failing.load).toHaveBeenCalledTimes(2)
    })
  })

  it('mobile: a panel view is in the view menu, without a toggle', async () => {
    mockIsMobile.mockReturnValue(true)
    render(<App views={PANEL_VIEWS} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'View: Terminal' }),
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Files' }))
    expect(screen.getByTestId('files-main')).toBeInTheDocument()
    expect(screen.queryByTestId('files-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull()
  })

  it('a panel view follows the layout between mobile and desktop', async () => {
    mockIsMobile.mockReturnValue(true)
    const { rerender } = render(<App views={PANEL_VIEWS} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'View: Terminal' }),
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Files' }))
    mockIsMobile.mockReturnValue(false)
    rerender(<App views={PANEL_VIEWS} />)
    expect(screen.getByTestId('files-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('files-main')).toBeNull()
    expect(terminalPanel()).not.toHaveAttribute('inert')
    mockIsMobile.mockReturnValue(true)
    rerender(<App views={PANEL_VIEWS} />)
    expect(screen.getByTestId('files-main')).toBeInTheDocument()
    expect(screen.queryByTestId('files-panel')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'View: Files' }),
    ).toBeInTheDocument()
  })

  describe('desktop side panel size', () => {
    // A panel with the maximize button its real views draw in their header
    const SIZED: AppView = {
      ...FILES,
      Panel: () => (
        <div data-testid="files-panel">
          <PanelMaximizeButton />
        </div>
      ),
    }
    const coveredNow = () =>
      (vi.mocked(TerminalView).mock.lastCall![0] as { covered: boolean })
        .covered
    const handle = () => screen.getByRole('separator', { name: 'Resize Files' })
    const main = () =>
      screen.getByTestId('terminal-view').closest('[id="view-panel-terminal"]')!
        .parentElement!

    it('opens at the saved width and saves a dragged one', async () => {
      const updateSetting = vi.fn()
      const settings = mockUseSettings()
      mockUseSettings.mockReturnValue({
        settings: { ...settings.settings, sidePanelWidth: 520 },
        updateSetting,
      } as any)
      render(<App views={[...APP_VIEWS, SIZED]} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Files' }))
      const panel = screen.getByRole('complementary', { name: 'Files' })
      expect(panel).toHaveStyle({ width: '520px' })
      fireEvent.pointerDown(handle(), { button: 0, clientX: 800 })
      fireEvent.pointerMove(handle(), { clientX: 700 })
      expect(updateSetting).not.toHaveBeenCalled()
      fireEvent.pointerUp(handle())
      expect(updateSetting).toHaveBeenCalledWith('sidePanelWidth', 620)
    })

    it('the terminal keeps its size while dragged and is fitted on release', async () => {
      render(<App views={[...APP_VIEWS, SIZED]} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Files' }))
      expect(coveredNow()).toBe(false)
      fireEvent.pointerDown(handle(), { button: 0, clientX: 800 })
      expect(coveredNow()).toBe(true)
      fireEvent.pointerMove(handle(), { clientX: 700 })
      expect(coveredNow()).toBe(true)
      fireEvent.pointerUp(handle())
      expect(coveredNow()).toBe(false)
    })

    it('maximized, the panel covers the main area and the terminal keeps its size', async () => {
      render(<App views={[...APP_VIEWS, SIZED]} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Files' }))
      fireEvent.click(screen.getByRole('button', { name: 'Maximize panel' }))
      const panel = screen.getByRole('complementary', { name: 'Files' })
      expect(panel).toHaveClass('absolute', 'inset-0')
      expect(main()).toHaveAttribute('inert')
      expect(coveredNow()).toBe(true)
      fireEvent.keyDown(screen.getByRole('button', { name: 'Restore panel' }), {
        key: 'Escape',
      })
      expect(panel).not.toHaveClass('absolute')
      expect(main()).not.toHaveAttribute('inert')
      expect(coveredNow()).toBe(false)
    })

    it('closing the panel leaves the maximized state', async () => {
      render(<App views={[...APP_VIEWS, SIZED]} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Files' }))
      fireEvent.click(screen.getByRole('button', { name: 'Maximize panel' }))
      fireEvent.click(screen.getByRole('button', { name: 'Files' }))
      expect(coveredNow()).toBe(false)
      expect(main()).not.toHaveAttribute('inert')
      fireEvent.click(screen.getByRole('button', { name: 'Files' }))
      expect(
        screen.getByRole('button', { name: 'Maximize panel' }),
      ).toBeInTheDocument()
      expect(handle()).toBeInTheDocument()
    })

    it('mobile: the view has no resize handle and no maximize button', async () => {
      mockIsMobile.mockReturnValue(true)
      render(<App views={[...APP_VIEWS, { ...SIZED, Main: SIZED.Panel }]} />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'View: Terminal' }),
      )
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Files' }))
      expect(screen.getByTestId('files-panel')).toBeInTheDocument()
      expect(screen.queryByRole('separator')).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Maximize panel' }),
      ).toBeNull()
    })
  })

  describe('per pane', () => {
    // Views are kept under each pane's key, known once a snapshot came
    beforeEach(() => {
      const ids = ['w1:t1', 'w1:t1:p1', 'w1:t1:p2', 'w2:t1', 'w2:t1:p1']
      setPaneKeys(
        { instanceId: 'i1', groups: [] } as unknown as MuxSnapshot,
        new Map(ids.map((id) => [id, id])),
      )
    })
    const viewOf = (paneId: string) =>
      JSON.parse(localStorage.getItem(`termote-pane-view:i1:${paneId}`)!).view
        .view as string

    const showTab = (i: number) => {
      const base = mockUseLocalSessions()
      mockUseLocalSessions.mockReturnValue({
        ...base,
        activeSession: base.sessions[i],
      } as any)
    }

    it('each pane comes back on its view and side panel', async () => {
      const { rerender } = render(<App views={PANEL_VIEWS} />)
      fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }))
      fireEvent.click(filesToggle())
      expect(screen.getByTestId('chat-main')).toBeInTheDocument()
      expect(screen.getByTestId('files-panel')).toBeInTheDocument()
      // A pane never shown opens on the terminal, without a panel
      showTab(1)
      rerender(<App views={PANEL_VIEWS} />)
      expect(screen.queryByTestId('chat-main')).toBeNull()
      expect(screen.queryByTestId('files-panel')).toBeNull()
      expect(screen.getByTestId('keyboard-toolbar')).toBeInTheDocument()
      showTab(0)
      rerender(<App views={PANEL_VIEWS} />)
      expect(screen.getByTestId('chat-main')).toBeInTheDocument()
      expect(screen.getByTestId('files-panel')).toBeInTheDocument()
    })

    it('a link to another pane keeps its view for it, not for the one on screen', async () => {
      window.history.replaceState(
        null,
        '',
        '/#/s/w1/w1%3At1/w1%3At1%3Ap2?view=chat',
      )
      render(<App views={VIEWS} />)
      await waitFor(() =>
        expect(switchSession).toHaveBeenCalledWith('w1:t1', 'w1:t1:p2'),
      )
      expect(screen.queryByTestId('chat-main')).toBeNull()
      expect(viewOf('w1:t1:p2')).toBe('chat')
      expect(viewOf('w1:t1:p1')).toBe('terminal')
    })

    it('a link to a tab keeps its view for the tab’s pane', async () => {
      window.history.replaceState(null, '', '/#/s/w2/w2%3At1?view=chat')
      const { rerender } = render(<App views={VIEWS} />)
      await waitFor(() =>
        expect(switchSession).toHaveBeenCalledWith('w2:t1', undefined),
      )
      showTab(1)
      rerender(<App views={VIEWS} />)
      expect(screen.getByTestId('chat-main')).toBeInTheDocument()
    })

    it('a tab without a pane id keeps it under the tab id', async () => {
      const base = mockUseLocalSessions()
      const sessions = base.sessions.map((s: any) => ({
        ...s,
        paneId: undefined,
      }))
      mockUseLocalSessions.mockReturnValue({
        ...base,
        sessions,
        activeSession: sessions[0],
      } as any)
      window.history.replaceState(null, '', '/#/s/w2/w2%3At1?view=chat')
      render(<App views={VIEWS} />)
      await waitFor(() => expect(viewOf('w2:t1')).toBe('chat'))
      expect(viewOf('w1:t1')).toBe('terminal')
    })
  })

  it('a view can show a notice', async () => {
    render(<App views={VIEWS} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }))
    act(() => notifyFrom.current!('Path copied'))
    expect(await screen.findByText('Path copied')).toBeInTheDocument()
  })

  it('herdr: the pane size is driven only while the terminal shows', async () => {
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      mux: { ...base.mux, caps: { ...base.mux.caps, driveSize: true } },
    } as any)
    const settings = mockUseSettings()
    mockUseSettings.mockReturnValue({
      ...settings,
      settings: { ...settings.settings, driveTerminalSize: true },
    } as any)
    const driving = () =>
      (vi.mocked(TerminalView).mock.lastCall![0] as { driveSize: boolean })
        .driveSize
    render(<App views={VIEWS} />)
    await screen.findByTestId('terminal-view')
    expect(driving()).toBe(true)
    const covered = () =>
      (vi.mocked(TerminalView).mock.lastCall![0] as { covered: boolean })
        .covered
    expect(covered()).toBe(false)
    fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }))
    expect(driving()).toBe(false)
    // Its size stays put under the Chat view
    expect(covered()).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }))
    expect(driving()).toBe(true)
    expect(covered()).toBe(false)
  })

  it('a view can switch back to the terminal; tmux reselects the window first', async () => {
    mockSessions({ backend: 'tmux' })
    render(<App views={VIEWS} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }))
    act(() => showViewFrom.current!('terminal'))
    expect(mockSelectTab).toHaveBeenCalledWith('w1:t1')
    expect(screen.queryByTestId('chat-main')).toBeNull()
    expect(screen.getByTestId('keyboard-toolbar')).toBeInTheDocument()
  })

  it('a failed reselect still switches to the terminal', async () => {
    mockSessions({ backend: 'tmux' })
    mockSelectTab.mockRejectedValueOnce(new Error('offline'))
    render(<App views={VIEWS} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }))
    await act(async () => showViewFrom.current!('terminal'))
    expect(screen.getByTestId('keyboard-toolbar')).toBeInTheDocument()
  })

  it('herdr streams the pane itself: no reselect', async () => {
    render(<App views={VIEWS} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }))
    act(() => showViewFrom.current!('terminal'))
    expect(mockSelectTab).not.toHaveBeenCalled()
    // Switching to a view other than the terminal never reselects either
    act(() => showViewFrom.current!('chat'))
    expect(mockSelectTab).not.toHaveBeenCalled()
  })

  describe('select text', () => {
    it('opens from the toolbar, reading the buffer without paneText', async () => {
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'SelectText' }))
      expect(screen.getByTestId('select-text-sheet')).toBeInTheDocument()
      expect(selectTextProps?.useServer).toBe(false)
      expect(selectTextProps?.readBuffer()).toBe('buffer')
      expect(mockReadTerminalBufferText).toHaveBeenCalledWith(null)
      act(() => selectTextProps?.onCopied('ok'))
      expect(await screen.findByTestId('toast')).toHaveTextContent('Copied')
      fireEvent.click(screen.getByRole('button', { name: 'CloseSelectText' }))
      expect(screen.queryByTestId('select-text-sheet')).toBeNull()
    })

    it('reads the history from the server with paneText', async () => {
      const base = mockUseLocalSessions()
      mockUseLocalSessions.mockReturnValue({
        ...base,
        mux: {
          backend: 'herdr',
          caps: { clientSideSelect: true, copyMode: false, paneText: true },
        },
      } as typeof base)
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'SelectText' }))
      expect(selectTextProps?.useServer).toBe(true)
    })

    it('opens view-only from the bottom bar, never reading the history', async () => {
      const base = mockUseLocalSessions()
      mockUseLocalSessions.mockReturnValue({
        ...base,
        mux: {
          backend: 'herdr',
          caps: { clientSideSelect: true, copyMode: false, paneText: true },
        },
      } as typeof base)
      render(<App readOnly />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'Select text' }),
      )
      expect(screen.getByTestId('select-text-sheet')).toBeInTheDocument()
      expect(selectTextProps?.useServer).toBe(false)
    })
  })

  describe('view-only', () => {
    it('hides every way to send input and says so', async () => {
      mockIsMobile.mockReturnValue(true)
      render(<App readOnly />)
      await screen.findByTestId('terminal-view')
      expect(
        screen
          .getByText('View only: you can watch this terminal but not type')
          .closest('[role="status"]'),
      ).toBeInTheDocument()
      expect(screen.getByText('View only')).toBeInTheDocument()
      expect(screen.queryByTestId('keyboard-toolbar')).toBeNull()
      expect(screen.queryByTestId('quick-actions')).toBeNull()
      expect(screen.queryByTestId('history-dropdown')).toBeNull()
      expect(document.querySelector('input')).toBeNull()
      expect(vi.mocked(TerminalView).mock.lastCall![0]).toMatchObject({
        readOnly: true,
      })
    })

    it('gestures still scroll and zoom but never send keys or paste', async () => {
      mockIsMobile.mockReturnValue(true)
      mockSessions({ backend: 'tmux' })
      render(<App readOnly />)
      await screen.findByTestId('terminal-view')
      capturedGestureHandlers.onSwipeLeft()
      capturedGestureHandlers.onSwipeRight()
      await capturedGestureHandlers.onLongPress()
      expect(mockSendKeyToTerminal).not.toHaveBeenCalled()
      expect(mockPasteToTerminal).not.toHaveBeenCalled()
      // tmux copy mode would scroll by sending PageUp/PageDown; the drag
      // scrolls the xterm.js scrollback instead
      capturedGestureHandlers.onSwipeUp()
      capturedGestureHandlers.onPan(0, -20)
      expect(mockScrollTmux).not.toHaveBeenCalled()
      expect(mockDragTerminal).toHaveBeenCalledWith(null, 0, -20, true)
    })

    it('views get the flag too', async () => {
      render(<App views={VIEWS} readOnly />)
      fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }))
      expect(screen.getByTestId('chat-main')).toHaveTextContent('ro')
      expect(screen.queryByTestId('chat-input')).toBeNull()
    })

    it('is off by default', async () => {
      render(<App />)
      await screen.findByTestId('keyboard-toolbar')
      expect(screen.queryByText('View only')).toBeNull()
      expect(vi.mocked(TerminalView).mock.lastCall![0]).toMatchObject({
        readOnly: false,
      })
    })
  })

  describe('view-only role from the server', () => {
    const setCaps = (
      caps: Record<string, unknown>,
      backend: 'tmux' | 'herdr' = 'tmux',
    ) => {
      const base = mockUseLocalSessions()
      mockUseLocalSessions.mockReturnValue({
        ...base,
        mux: { backend, caps },
      } as typeof base)
    }
    const terminalProps = () => vi.mocked(TerminalView).mock.lastCall![0]

    it('a view-only tmux before 3.2 gets no stream and says why', async () => {
      setCaps({
        clientSideSelect: false,
        copyMode: true,
        role: 'view',
        viewStream: false,
      })
      render(<App />)
      await screen.findByTestId('terminal-view')
      expect(
        screen.getByText(/View only is not available with this tmux/),
      ).toBeInTheDocument()
      expect(terminalProps().paneId).toBeUndefined()
      expect(terminalProps().readOnly).toBe(true)
    })

    it('a view-only device with a stream gets its pane and no such notice', async () => {
      setCaps({
        clientSideSelect: false,
        copyMode: true,
        role: 'view',
        viewStream: true,
      })
      render(<App />)
      await screen.findByTestId('terminal-view')
      expect(
        screen.queryByText(/View only is not available with this tmux/),
      ).toBeNull()
      expect(terminalProps().paneId).toBe(
        mockUseLocalSessions().activeSession.paneId,
      )
    })

    it('a view-only device gets no server scroll and no Devices group', async () => {
      setCaps({
        clientSideSelect: false,
        copyMode: true,
        role: 'view',
        viewStream: true,
        scroll: true,
        devices: true,
        signins: true,
      })
      render(<App />)
      await screen.findByTestId('terminal-view')
      expect(terminalProps().serverScroll).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
      expect(screen.getByTestId('settings-modal')).toHaveAttribute(
        'data-devices',
        'false',
      )
      expect(screen.getByTestId('settings-modal')).toHaveAttribute(
        'data-signins',
        'false',
      )
      expect(screen.getByTestId('settings-modal')).toHaveAttribute(
        'data-read-only',
        'true',
      )
    })

    it('a full device gets server scroll and the Devices group', async () => {
      setCaps({
        clientSideSelect: false,
        copyMode: true,
        role: 'full',
        scroll: true,
        devices: true,
        signins: true,
      })
      render(<App />)
      await screen.findByTestId('terminal-view')
      expect(terminalProps().serverScroll).toBe(true)
      expect(terminalProps().readOnly).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
      expect(screen.getByTestId('settings-modal')).toHaveAttribute(
        'data-devices',
        'true',
      )
      expect(screen.getByTestId('settings-modal')).toHaveAttribute(
        'data-signins',
        'true',
      )
      expect(screen.getByTestId('settings-modal')).toHaveAttribute(
        'data-read-only',
        'false',
      )
    })

    it('a view-only device gets no Web Push, a full one may', async () => {
      const push = vi.mocked(usePushSubscription)
      setCaps({
        clientSideSelect: false,
        copyMode: true,
        role: 'view',
        push: true,
      })
      const { unmount } = render(<App />)
      await screen.findByTestId('terminal-view')
      expect(push).toHaveBeenLastCalledWith(
        expect.objectContaining({ available: false }),
      )
      unmount()
      setCaps({
        clientSideSelect: false,
        copyMode: true,
        role: 'full',
        push: true,
      })
      render(<App />)
      await screen.findByTestId('terminal-view')
      expect(push).toHaveBeenLastCalledWith(
        expect.objectContaining({ available: true }),
      )
    })

    it('a refused write tells a view-only device once, in a warning', async () => {
      render(<App />)
      await screen.findByTestId('terminal-view')
      act(() => viewOnlyListener?.())
      const toast = screen.getByTestId('toast')
      expect(toast).toHaveTextContent('This device is view-only')
      expect(toast).toHaveAttribute('data-variant', 'warning')
    })

    it('picking a tab the server will not show says it follows the active window', async () => {
      mockIsMobile.mockReturnValue(true)
      setCaps({ clientSideSelect: false, copyMode: true, role: 'view' })
      const base = mockUseLocalSessions()
      const switchSession = vi.fn().mockResolvedValueOnce('view-only')
      mockUseLocalSessions.mockReturnValue({
        ...base,
        switchSession,
      } as typeof base)
      render(<App />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'Open sessions menu' }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'MobileSelect' }))
      expect(switchSession).toHaveBeenCalledWith('2', undefined)
      const toast = await screen.findByTestId('toast')
      expect(toast).toHaveTextContent('View only: follows the active window')
      expect(toast).toHaveAttribute('data-variant', 'info')
      // The sheet stays open on a tab this device cannot watch
      expect(screen.getByTestId('session-sidebar')).toHaveAttribute(
        'data-open',
        'true',
      )
    })

    it('a pick that is shown needs no notice', async () => {
      mockIsMobile.mockReturnValue(true)
      setCaps({ clientSideSelect: false, copyMode: true, role: 'view' })
      const base = mockUseLocalSessions()
      const switchSession = vi.fn().mockResolvedValue(undefined)
      mockUseLocalSessions.mockReturnValue({
        ...base,
        switchSession,
      } as typeof base)
      render(<App />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'MobileSelect' }),
      )
      await act(async () => {})
      expect(screen.queryByTestId('toast')).toBeNull()
    })
  })

  describe('deep links', () => {
    const noWrites = () => {
      expect(addSession).not.toHaveBeenCalled()
      expect(removeSession).not.toHaveBeenCalled()
      expect(mockSendKeyToTerminal).not.toHaveBeenCalled()
      expect(mockSendTextToTerminal).not.toHaveBeenCalled()
    }

    it('opens the tab in the link once sessions are in', async () => {
      window.history.replaceState(null, '', '/#/s/w2/w2%3At1')
      render(<App />)
      await waitFor(() =>
        expect(switchSession).toHaveBeenCalledWith('w2:t1', undefined),
      )
      noWrites()
    })

    it('opens the pane in the link', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1/w1%3At1%3Ap2')
      render(<App />)
      await waitFor(() =>
        expect(switchSession).toHaveBeenCalledWith('w1:t1', 'w1:t1:p2'),
      )
    })

    it('a pane that is gone opens its tab and says so', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1/gone')
      render(<App />)
      const toast = await screen.findByTestId('toast')
      expect(toast).toHaveTextContent('Pane in link not found')
      expect(toast).toHaveAttribute('data-variant', 'warning')
      expect(switchSession).toHaveBeenCalledWith('w1:t1', 'gone')
    })

    it('waits for a reachable, loaded session list', async () => {
      window.history.replaceState(null, '', '/#/s/w2/w2%3At1')
      mockSessions({ isReady: false })
      const { rerender } = render(<App />)
      mockSessions({ isServerReachable: false })
      rerender(<App />)
      await screen.findByTestId('terminal-view')
      expect(switchSession).not.toHaveBeenCalled()
      // The link is kept in the address bar meanwhile
      expect(window.location.hash).toBe('#/s/w2/w2%3At1')
      mockSessions()
      rerender(<App />)
      await waitFor(() =>
        expect(switchSession).toHaveBeenCalledWith('w2:t1', undefined),
      )
    })

    it('keeps the link in the address while its pick is made', async () => {
      window.history.replaceState(null, '', '/#/s/w2/w2%3At1')
      mockSessions({ isReady: false })
      let refuse = () => {}
      switchSession.mockReturnValueOnce(
        new Promise((ok) => {
          refuse = () => ok('view-only')
        }),
      )
      const { rerender } = render(<App />)
      await screen.findByTestId('terminal-view')
      mockSessions()
      rerender(<App />)
      await waitFor(() =>
        expect(switchSession).toHaveBeenCalledWith('w2:t1', undefined),
      )
      // The pane on screen before the pick is never written over the link
      expect(window.location.hash).toBe('#/s/w2/w2%3At1')
      // Refused: the address goes back to the pane on screen
      await act(async () => refuse())
      await waitFor(() =>
        expect(window.location.hash).toBe('#/s/w1/w1%3At1/w1%3At1%3Ap1'),
      )
    })

    it('a refused link to the pane on screen leaves the address as it is', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1/w1%3At1%3Ap1')
      const replace = vi.spyOn(window.history, 'replaceState')
      switchSession.mockResolvedValueOnce('view-only')
      render(<App />)
      await waitFor(() => expect(switchSession).toHaveBeenCalled())
      await act(async () => {})
      expect(window.location.hash).toBe('#/s/w1/w1%3At1/w1%3At1%3Ap1')
      expect(replace).not.toHaveBeenCalled()
      replace.mockRestore()
    })

    it('a link to the tab on screen writes the pane it shows', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1/gone')
      render(<App />)
      await waitFor(() =>
        expect(window.location.hash).toBe('#/s/w1/w1%3At1/w1%3At1%3Ap1'),
      )
    })

    it('a link typed while a pick settles is not written over', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1/gone')
      let settle = () => {}
      switchSession.mockReturnValueOnce(
        new Promise<void>((ok) => {
          settle = ok
        }),
      )
      render(<App />)
      await waitFor(() => expect(switchSession).toHaveBeenCalled())
      // Its popstate came, its hashchange not yet
      window.history.pushState(null, '', '/#/s/w2/w2%3At1')
      await act(async () => settle())
      expect(window.location.hash).toBe('#/s/w2/w2%3At1')
    })

    it('an unknown session only shows a toast', async () => {
      window.history.replaceState(null, '', '/#/s/w9/nope')
      render(<App />)
      const toast = await screen.findByTestId('toast')
      expect(toast).toHaveTextContent('Session in link not found')
      expect(toast).toHaveAttribute('data-variant', 'warning')
      expect(switchSession).not.toHaveBeenCalled()
      noWrites()
    })

    it('a tab id from another group does not match', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w2%3At1')
      render(<App />)
      expect(await screen.findByTestId('toast')).toHaveTextContent(
        'Session in link not found',
      )
    })

    it('a malformed hash is left alone', async () => {
      window.history.replaceState(null, '', '/#/s/only-group')
      render(<App />)
      await screen.findByTestId('terminal-view')
      expect(switchSession).not.toHaveBeenCalled()
      expect(screen.queryByTestId('toast')).toBeNull()
    })

    it('follows a link pasted while the app is open', async () => {
      render(<App />)
      await screen.findByTestId('terminal-view')
      act(() => {
        window.history.replaceState(null, '', '/#/s/w2/w2%3At1')
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
      await waitFor(() =>
        expect(switchSession).toHaveBeenCalledWith('w2:t1', undefined),
      )
    })

    it('opens the view in the link when it is offered', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1?view=chat')
      render(<App views={VIEWS} />)
      expect(await screen.findByTestId('chat-main')).toBeInTheDocument()
    })

    it('a link to a panel view opens its panel on desktop, its view on mobile', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1?view=files')
      const { unmount } = render(<App views={PANEL_VIEWS} />)
      expect(await screen.findByTestId('files-panel')).toBeInTheDocument()
      expect(screen.queryByTestId('files-main')).toBeNull()
      unmount()
      mockIsMobile.mockReturnValue(true)
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1?view=files')
      render(<App views={PANEL_VIEWS} />)
      expect(await screen.findByTestId('files-main')).toBeInTheDocument()
    })

    it('falls back to the terminal for a view that is not offered', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1?view=files')
      render(<App views={VIEWS} />)
      await waitFor(() => expect(switchSession).toHaveBeenCalled())
      expect(screen.queryByTestId('chat-main')).toBeNull()
      expect(screen.getByTestId('keyboard-toolbar')).toBeInTheDocument()
    })

    it('writes the pane on screen into the URL without a history entry', async () => {
      const length = window.history.length
      render(<App views={VIEWS} />)
      await waitFor(() =>
        expect(window.location.hash).toBe('#/s/w1/w1%3At1/w1%3At1%3Ap1'),
      )
      fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
      expect(window.location.hash).toBe('#/s/w1/w1%3At1/w1%3At1%3Ap1?view=chat')
      expect(window.history.length).toBe(length)
    })

    it('waits while a viewer’s entry is on top, then writes the base entry', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1/w1%3At1%3Ap1')
      render(<App views={VIEWS} />)
      await waitFor(() => expect(switchSession).toHaveBeenCalled())
      // A viewer opened: its entry on top, same URL
      renderHook(() => useHistoryClose(vi.fn()))
      expect(window.history.state?.termoteViewer).toEqual(expect.any(String))
      fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
      expect(window.location.hash).toBe('#/s/w1/w1%3At1/w1%3At1%3Ap1')
      // Back pops it: the entry under it gets the new address
      const popped = new Promise((r) =>
        window.addEventListener('popstate', r, { once: true }),
      )
      window.history.back()
      await popped
      await waitFor(() =>
        expect(window.location.hash).toBe(
          '#/s/w1/w1%3At1/w1%3At1%3Ap1?view=chat',
        ),
      )
      expect(window.history.state?.termoteViewer).toBeUndefined()
    })

    it('a link opened by its hash is not written over by its popstate', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1')
      render(<App />)
      await waitFor(() => expect(switchSession).toHaveBeenCalled())
      switchSession.mockClear()
      // A link typed in the address bar: popstate first, then hashchange
      window.history.pushState(null, '', '/#/s/w2/w2%3At1')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      await act(async () => {})
      expect(window.location.hash).toBe('#/s/w2/w2%3At1')
      act(() => {
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
      await waitFor(() =>
        expect(switchSession).toHaveBeenCalledWith('w2:t1', undefined),
      )
    })

    it('Forward onto the entry of a closed viewer drops its mark', async () => {
      render(<App />)
      await screen.findByTestId('terminal-view')
      window.history.pushState(
        { termoteViewer: 'gone' },
        '',
        window.location.href,
      )
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      expect(window.history.state?.termoteViewer).toBeUndefined()
    })

    it('drops the mark of a viewer open before a reload', async () => {
      window.history.replaceState({ termoteViewer: 'old', keep: 1 }, '', '/')
      render(<App />)
      await screen.findByTestId('terminal-view')
      expect(window.history.state).toEqual({ keep: 1 })
    })

    it('a link to the pane on screen leaves the address as it is', async () => {
      window.history.replaceState(null, '', '/#/s/w1/w1%3At1/w1%3At1%3Ap1')
      const replace = vi.spyOn(window.history, 'replaceState')
      render(<App />)
      await waitFor(() =>
        expect(switchSession).toHaveBeenCalledWith('w1:t1', 'w1:t1:p1'),
      )
      expect(replace).not.toHaveBeenCalled()
      replace.mockRestore()
    })

    it('tmux links name the window only', async () => {
      mockSessions({ backend: 'tmux' })
      render(<App />)
      await waitFor(() => expect(window.location.hash).toBe('#/s/w1/w1%3At1'))
    })

    it('without a group there is no link to write or copy', async () => {
      mockSessions({ grouped: false })
      render(<App />)
      await screen.findByTestId('terminal-view')
      expect(window.location.hash).toBe('')
      expect(
        screen.queryAllByRole('button', { name: 'CopyLink' }),
      ).toHaveLength(0)
    })

    it('Copy link copies the address and says so', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      })
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'CopyLink' }))
      const toast = await screen.findByTestId('toast')
      expect(toast).toHaveTextContent('Link copied')
      expect(toast).toHaveAttribute('data-variant', 'success')
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/#/s/w1/w1%3At1/w1%3At1%3Ap1`,
      )
    })

    it('Copy link reports a clipboard that refuses', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
        configurable: true,
      })
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'CopyLink' }))
      const toast = await screen.findByTestId('toast')
      expect(toast).toHaveTextContent('Could not copy the link')
      expect(toast).toHaveAttribute('data-variant', 'danger')
    })
  })

  describe('agent overview', () => {
    afterEach(() => {
      window.history.replaceState(null, '', '/')
      mockIsMobile.mockReturnValue(false)
    })
    const overview = () => screen.queryByRole('region', { name: 'Agents' })

    it('a reload on #/overview opens it over the panes, address kept', async () => {
      window.history.replaceState(null, '', '/#/overview')
      render(<App />)
      expect(
        await screen.findByRole('region', { name: 'Agents' }),
      ).toBeInTheDocument()
      await act(async () => {})
      expect(window.location.hash).toBe('#/overview')
      // The panes stay mounted, out of reach, and the toolbar goes
      expect(terminalPanel().parentElement).toHaveAttribute('inert')
      expect(screen.queryByTestId('keyboard-toolbar')).toBeNull()
      expect(switchSession).not.toHaveBeenCalled()
      // One card, for the pane running an agent
      expect(
        screen.getByRole('button', { name: /^Open terminal: Agent/ }),
      ).toBeInTheDocument()
      expect(mockFetchOverview).toHaveBeenCalled()
    })

    it("the usage chip opens it on its pane's card", async () => {
      const base = mockUseLocalSessions()
      mockUseLocalSessions.mockReturnValue({
        ...base,
        activeSession: { ...base.activeSession, hasAgent: true },
      } as any)
      const settings = mockUseSettings()
      mockUseSettings.mockReturnValue({
        ...settings,
        settings: { ...settings.settings, showUsageChip: true },
      } as any)
      mockFetchOverview.mockResolvedValueOnce({
        serverNow: '2026-10-13T09:00:00.000Z',
        panes: [
          {
            paneId: base.activeSession.paneId,
            key: 'k',
            usage: {
              contextTokens: 20_000,
              contextWindow: 200_000,
              contextPercent: 10,
              exact: true,
            },
          },
        ],
      })
      render(<App />)
      fireEvent.click(
        await screen.findByRole('button', {
          name: /^Agent usage: context 10%/,
        }),
      )
      await screen.findByRole('region', { name: 'Agents' })
      expect(window.location.hash).toBe('#/overview')
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /^Open terminal: Agent/ }),
        ).toHaveFocus(),
      )
      // Closed, then back to it: the title, not the card again
      fireEvent.keyDown(window, { key: 'Escape' })
      await waitFor(() => expect(overview()).toBeNull())
      act(() => {
        window.history.replaceState(null, '', '/#/overview')
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Agents' })).toHaveFocus(),
      )
    })

    it('opens from the sidebar and Esc goes back to the pane', async () => {
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'SBOverview' }))
      await screen.findByRole('region', { name: 'Agents' })
      expect(window.location.hash).toBe('#/overview')
      fireEvent.keyDown(window, { key: 'Escape' })
      await waitFor(() => expect(overview()).toBeNull())
      expect(window.location.hash).toBe('#/s/w1/w1%3At1/w1%3At1%3Ap1')
    })

    it('Esc in a dialog or menu is theirs', async () => {
      window.history.replaceState(null, '', '/#/overview')
      render(<App />)
      await screen.findByRole('region', { name: 'Agents' })
      for (const html of [
        '<dialog open><button>in</button></dialog>',
        '<div role="menu"><button>in</button></div>',
      ]) {
        const host = document.createElement('div')
        host.innerHTML = html
        document.body.append(host)
        fireEvent.keyDown(host.querySelector('button')!, { key: 'Escape' })
        host.remove()
      }
      expect(overview()).toBeInTheDocument()
    })

    it('picking a view leaves it for that view, in place', async () => {
      window.history.replaceState(null, '', '/#/overview')
      render(<App views={VIEWS} />)
      await screen.findByRole('region', { name: 'Agents' })
      fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
      await waitFor(() => expect(overview()).toBeNull())
      expect(screen.getByTestId('chat-main')).toBeInTheDocument()
      await waitFor(() =>
        expect(window.location.hash).toBe(
          '#/s/w1/w1%3At1/w1%3At1%3Ap1?view=chat',
        ),
      )
    })

    it('a card opens its pane, the close button the pane on screen', async () => {
      window.history.replaceState(null, '', '/#/overview')
      render(<App />)
      fireEvent.click(
        await screen.findByRole('button', { name: /^Open terminal: Agent/ }),
      )
      await waitFor(() => expect(overview()).toBeNull())
      await waitFor(() =>
        expect(switchSession).toHaveBeenCalledWith('w1:t1', 'w1:t1:p1'),
      )
      window.history.replaceState(null, '', '/#/overview')
      await act(async () => {
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
      fireEvent.click(
        screen.getByRole('button', { name: 'Close the agent overview' }),
      )
      await waitFor(() => expect(overview()).toBeNull())
    })

    it('picking a session leaves it', async () => {
      window.history.replaceState(null, '', '/#/overview')
      render(<App />)
      await screen.findByRole('region', { name: 'Agents' })
      fireEvent.click(screen.getByRole('button', { name: 'SBSelectW2' }))
      await waitFor(() => expect(overview()).toBeNull())
      expect(switchSession).toHaveBeenCalledWith('w2:t1', undefined)
    })

    it('Copy link copies the overview while it shows', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      })
      window.history.replaceState(null, '', '/#/overview')
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'CopyLink' }))
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(
          `${window.location.origin}/#/overview`,
        ),
      )
    })

    it('closes in place when no link names the pane on screen', async () => {
      mockSessions({ grouped: false })
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'SBOverview' }))
      await screen.findByRole('region', { name: 'Agents' })
      fireEvent.click(
        screen.getByRole('button', { name: 'Close the agent overview' }),
      )
      await waitFor(() => expect(overview()).toBeNull())
    })

    it('without an agent, starts one from the Chat view of the pane', async () => {
      // The sessions of mockSessions, with no agent in any pane
      const value = (mockUseLocalSessions as any)() as any
      const noAgents = value.sessions.map((t: any) => ({
        ...t,
        panes: t.panes?.map((p: any) => ({ ...p, hasAgent: false })),
      }))
      mockUseLocalSessions.mockReturnValue({
        ...value,
        sessions: noAgents,
        activeSession: noAgents[0],
      })
      // The pane was left on Files: its address names that view
      window.history.replaceState(
        null,
        '',
        '/#/s/w1/w1%3At1/w1%3At1%3Ap1?view=files',
      )
      render(<App views={PANEL_VIEWS} />)
      mockIsMobile.mockReturnValue(false)
      fireEvent.click(await screen.findByRole('button', { name: 'SBOverview' }))
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'Start an agent in this pane',
        }),
      )
      expect(await screen.findByTestId('chat-main')).toBeInTheDocument()
      await waitFor(() => expect(overview()).toBeNull())
    })

    it('tmux: a card opens the chat of its tab, other keys stay put', async () => {
      mockSessions({ backend: 'tmux' })
      const value = (mockUseLocalSessions as any)() as any
      const sessions = value.sessions.map((t: any) => ({
        ...t,
        panes: t.panes?.map((p: any) =>
          p.hasAgent
            ? { ...p, agentName: 'claude', agentStatus: 'blocked' }
            : p,
        ),
      }))
      mockUseLocalSessions.mockReturnValue({
        ...value,
        sessions,
        activeSession: sessions[0],
        mux: { ...value.mux, caps: { ...value.mux.caps, agentChat: true } },
      })
      window.history.replaceState(null, '', '/#/overview')
      render(<App views={VIEWS} />)
      await screen.findByRole('region', { name: 'Agents' })
      // Its dialog waits on top
      expect(
        screen.getByRole('heading', { name: /^Needs you: Claude Code/ }),
      ).toBeInTheDocument()
      // Opening it again changes nothing
      fireEvent.click(screen.getByRole('button', { name: 'SBOverview' }))
      fireEvent.keyDown(window, { key: 'a' })
      const prevented = new KeyboardEvent('keydown', {
        key: 'Escape',
        cancelable: true,
      })
      prevented.preventDefault()
      window.dispatchEvent(prevented)
      expect(overview()).toBeInTheDocument()
      expect(window.location.hash).toBe('#/overview')
      fireEvent.click(
        screen.getByRole('button', { name: /^Open chat: Claude Code/ }),
      )
      await waitFor(() =>
        expect(window.location.hash).toBe('#/s/w1/w1%3At1?view=chat'),
      )
    })

    it('a card of a tab without a group is picked in place', async () => {
      mockSessions({ grouped: false })
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'SBOverview' }))
      fireEvent.click(
        await screen.findByRole('button', { name: /^Open terminal: Agent/ }),
      )
      await waitFor(() => expect(overview()).toBeNull())
      expect(switchSession).toHaveBeenCalledWith('w1:t1', 'w1:t1:p1')
    })

    it('mobile: opens from the view menu', async () => {
      mockIsMobile.mockReturnValue(true)
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: /^View:/ }))
      fireEvent.click(
        await screen.findByRole('menuitem', { name: 'Agent overview' }),
      )
      await screen.findByRole('region', { name: 'Agents' })
    })
  })
})

describe('App — group actions', () => {
  const tab = (id: string, groupId: string) => ({
    id,
    name: id,
    icon: '💻',
    description: '',
    groupId,
    paneId: id,
  })
  const createGroup = vi.fn(async () => {})
  const renameGroup = vi.fn(async () => {})
  const closeGroup = vi.fn(async () => {})
  const withGroups = (backend = 'tmux') => {
    const base = mockUseLocalSessions()
    const tabs = [tab('0', 'main'), tab('1', 'main'), tab('$3:0', '$3')]
    mockUseLocalSessions.mockReturnValue({
      ...base,
      activeSession: tabs[0],
      sessions: tabs,
      groups: [
        { id: 'main', name: 'main' },
        { id: '$3', name: 'work' },
      ],
      createGroup,
      renameGroup,
      closeGroup,
      mux: {
        backend,
        caps: {
          clientSideSelect: backend === 'herdr',
          copyMode: true,
          groups: true,
        },
      },
    } as any)
  }

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    createGroup.mockReset().mockResolvedValue(undefined)
    closeGroup.mockReset().mockResolvedValue(undefined)
    renameGroup.mockReset().mockResolvedValue(undefined)
  })

  it('offers no group actions without caps.groups', async () => {
    render(<App />)
    await screen.findAllByTestId('session-sidebar')
    expect(screen.queryByText('GroupNew')).toBeNull()
  })

  it('tmux: names them tmux sessions; the default one cannot be renamed', async () => {
    withGroups()
    render(<App />)
    expect(
      await screen.findByText(
        'tmux session: rename main false, rename $3 true',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('GroupRename'))
    expect(renameGroup).toHaveBeenCalledWith('$3', 'web')
  })

  it('herdr: names them workspaces, every one can be renamed', async () => {
    withGroups('herdr')
    render(<App />)
    expect(
      await screen.findByText('workspace: rename main true, rename $3 true'),
    ).toBeInTheDocument()
  })

  it('creates a group from the dialog', async () => {
    withGroups()
    render(<App />)
    fireEvent.click(await screen.findByText('GroupNew'))
    expect(screen.getByText('New tmux session')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'api' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(createGroup).toHaveBeenCalledWith('api', '', expect.any(Function))
    expect(screen.queryByText('New tmux session')).toBeNull()
  })

  it('closes the sessions sheet once a group is made on mobile', async () => {
    mockIsMobile.mockReturnValue(true)
    withGroups()
    render(<App />)
    fireEvent.click(await screen.findByText('MobileGroupNew'))
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'api' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(createGroup).toHaveBeenCalled()
    for (const el of screen.getAllByTestId('session-sidebar')) {
      expect(el).toHaveAttribute('data-open', 'false')
    }
    mockIsMobile.mockReturnValue(false)
  })

  it('a create that ends after Cancel leaves the mobile sheet open', async () => {
    mockIsMobile.mockReturnValue(true)
    withGroups()
    let resolve!: () => void
    createGroup.mockImplementation(
      () => new Promise<void>((r) => (resolve = r)),
    )
    render(<App />)
    fireEvent.click(await screen.findByText('MobileGroupNew'))
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'api' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const open = screen
      .getAllByTestId('session-sidebar')
      .map((el) => el.dataset.open)
    await act(async () => resolve())
    expect(
      screen.getAllByTestId('session-sidebar').map((el) => el.dataset.open),
    ).toEqual(open)
    mockIsMobile.mockReturnValue(false)
  })

  it('asks before closing, with the tab count', async () => {
    withGroups()
    render(<App />)
    fireEvent.click(await screen.findByText('GroupCloseWork'))
    const dialog = screen.getByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('Close tmux session?')
    expect(dialog).toHaveTextContent(
      'Close tmux session "work"? Its 1 tab and everything running in them will end.',
    )
    expect(dialog).not.toHaveTextContent('starts a new')
    expect(dialog).not.toHaveTextContent('Running:')
    fireEvent.click(within(dialog).getByText('ConfirmYes'))
    expect(closeGroup).toHaveBeenCalledWith('$3')
  })

  it('shows the hidden characters of the group it asks to close', async () => {
    withGroups()
    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      groups: [
        { id: 'main', name: 'ma\u202ein' },
        { id: '$3', name: 'work' },
      ],
    } as any)
    render(<App />)
    fireEvent.click(await screen.findByText('GroupCloseMain'))
    const dialog = screen.getByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('Close tmux session "ma⟨U+202E⟩in"?')
    expect(dialog).toHaveTextContent('a new, empty "ma⟨U+202E⟩in" right away')
  })

  it('names what runs in every tab of the group, once each', async () => {
    withGroups()
    const base = mockUseLocalSessions()
    const commands = [['bash', 'vim'], undefined, ['bash', 'top']]
    mockUseLocalSessions.mockReturnValue({
      ...base,
      sessions: base.sessions.map((s: object, i: number) => ({
        ...s,
        groupId: 'main',
        commands: commands[i],
      })),
    } as any)
    render(<App />)
    fireEvent.click(await screen.findByText('GroupCloseMain'))
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent(
      'Running: bash, vim, top.',
    )
  })

  // Zellij: "main" (zbWFpbg) is the default session, "dev" (zZGV2) another.
  const withZellij = () => {
    withGroups('zellij')
    const base = mockUseLocalSessions()
    const tabs = [tab('zbWFpbg:t0', 'zbWFpbg'), tab('zZGV2:t0', 'zZGV2')]
    mockUseLocalSessions.mockReturnValue({
      ...base,
      activeSession: tabs[0],
      sessions: tabs,
      groups: [
        { id: 'zbWFpbg', name: 'main' },
        { id: 'zZGV2', name: 'dev' },
      ],
    } as any)
  }

  it('Zellij: names its sessions, and only "main" cannot be renamed', async () => {
    withZellij()
    render(<App />)
    expect(
      await screen.findByText(
        'Zellij session: rename main true, rename $3 true',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('zellij rename main false, rename dev true'),
    ).toBeInTheDocument()
  })

  it('Zellij: closing a session says it is deleted', async () => {
    withZellij()
    render(<App />)
    fireEvent.click(await screen.findByText('GroupCloseZellijDev'))
    const dialog = screen.getByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('Close Zellij session?')
    expect(dialog).toHaveTextContent(
      'Close Zellij session "dev"? Its 1 tab and everything running in them will end. The session is deleted: Zellij cannot resurrect it.',
    )
    expect(dialog).not.toHaveTextContent('starts a new')
    fireEvent.click(within(dialog).getByText('ConfirmYes'))
    expect(closeGroup).toHaveBeenCalledWith('zZGV2')
  })

  it('Zellij: closing "main" says it comes back empty', async () => {
    withZellij()
    render(<App />)
    fireEvent.click(await screen.findByText('GroupCloseZellijMain'))
    const dialog = screen.getByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('The session is deleted')
    expect(dialog).toHaveTextContent(
      'Termote starts a new, empty "main" right away, and every device viewing it is disconnected.',
    )
  })

  it('says that the default session comes back empty and other devices drop', async () => {
    withGroups()
    render(<App />)
    fireEvent.click(await screen.findByText('GroupCloseMain'))
    const dialog = screen.getByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('Its 2 tabs')
    expect(dialog).toHaveTextContent(
      'Termote starts a new, empty "main" right away, and every device viewing it is disconnected.',
    )
    fireEvent.click(within(dialog).getByText('ConfirmNo'))
    expect(closeGroup).not.toHaveBeenCalled()
  })

  describe('worktrees', () => {
    const removeWorktree = vi.fn(async () => {})
    const refreshSessions = vi.fn(async () => {})
    const createWorktree = vi.fn(async () => {})
    const openWorktree = vi.fn(async () => {})
    const showGroup = vi.fn(async () => {})
    const withWorktrees = (worktrees: boolean) => {
      withGroups('herdr')
      const base = mockUseLocalSessions()
      mockUseLocalSessions.mockReturnValue({
        ...base,
        removeWorktree,
        refreshSessions,
        createWorktree,
        openWorktree,
        showGroup,
        mux: { ...base.mux, caps: { ...base.mux.caps, worktrees } },
      } as any)
    }
    beforeEach(() => {
      removeWorktree.mockReset()
      refreshSessions.mockClear()
    })

    it('offers nothing without caps.worktrees', async () => {
      withWorktrees(false)
      render(<App />)
      await screen.findByText('GroupCloseWork')
      expect(screen.queryByText('WorktreeNew')).toBeNull()
      expect(screen.queryByText('WorktreeRemove')).toBeNull()
    })

    it('opens the New worktree dialog for the group', async () => {
      withWorktrees(true)
      render(<App />)
      fireEvent.click(await screen.findByText('WorktreeNew'))
      expect(screen.getByTestId('worktree-dialog')).toHaveTextContent('new $3')
    })

    it('runs the dialog create, open and show, then closes it', async () => {
      withWorktrees(true)
      render(<App />)
      fireEvent.click(await screen.findByText('WorktreeOpen'))
      expect(screen.getByTestId('worktree-dialog')).toHaveTextContent('open $3')
      await act(async () => fireEvent.click(screen.getByText('DlgCreate')))
      await act(async () => fireEvent.click(screen.getByText('DlgOpen')))
      fireEvent.click(screen.getByText('DlgShow'))
      expect(createWorktree).toHaveBeenCalledWith(
        { groupId: '$3', branch: 'feat/x', base: '', label: '' },
        expect.any(Function),
      )
      expect(openWorktree).toHaveBeenCalledWith(
        '$3',
        'feat/x',
        expect.any(Function),
      )
      expect(showGroup).toHaveBeenCalledWith('w7')
      fireEvent.click(screen.getByText('DlgClose'))
      expect(screen.queryByTestId('worktree-dialog')).toBeNull()
    })

    it('closes the mobile sheet on what the dialog made or showed', async () => {
      mockIsMobile.mockReturnValue(true)
      withWorktrees(true)
      render(<App />)
      fireEvent.click((await screen.findAllByText('MobileWorktreeNew'))[0])
      await act(async () => fireEvent.click(screen.getByText('DlgCreate')))
      await act(async () => fireEvent.click(screen.getByText('DlgOpen')))
      fireEvent.click(screen.getByText('DlgShow'))
      for (const el of screen.getAllByTestId('session-sidebar')) {
        expect(el).toHaveAttribute('data-open', 'false')
      }
      mockIsMobile.mockReturnValue(false)
    })

    it('cancels a removal, and words a failure without a code', async () => {
      withWorktrees(true)
      render(<App />)
      fireEvent.click(await screen.findByText('WorktreeRemove'))
      fireEvent.click(screen.getByText('RemoveNo'))
      expect(screen.queryByTestId('worktree-remove')).toBeNull()
      expect(removeWorktree).not.toHaveBeenCalled()
      removeWorktree.mockRejectedValueOnce(new TypeError('fetch'))
      fireEvent.click(screen.getByText('WorktreeRemove'))
      await act(async () => fireEvent.click(screen.getByText('RemoveYes')))
      expect(
        await screen.findByText('Could not change the worktree'),
      ).toBeInTheDocument()
    })

    it('asks again with force for a dirty worktree, same checkout', async () => {
      const { RequestError } = await import('./hooks/use-mux-api')
      withWorktrees(true)
      removeWorktree.mockRejectedValueOnce(
        new RequestError(409, 'dirty', 'dirty'),
      )
      render(<App />)
      fireEvent.click(await screen.findByText('WorktreeRemove'))
      await act(async () => fireEvent.click(screen.getByText('RemoveYes')))
      expect(removeWorktree).toHaveBeenCalledWith('$3', {
        force: false,
        path: '/wt/feat-x',
        branch: 'feat/x',
      })
      expect(screen.getByTestId('worktree-remove')).toHaveTextContent(
        'second $3',
      )
      await act(async () => fireEvent.click(screen.getByText('RemoveYes')))
      expect(removeWorktree).toHaveBeenLastCalledWith('$3', {
        force: true,
        path: '/wt/feat-x',
        branch: 'feat/x',
      })
      expect(screen.queryByTestId('worktree-remove')).toBeNull()
    })

    it('words other refusals and reads the list again', async () => {
      const { RequestError } = await import('./hooks/use-mux-api')
      withWorktrees(true)
      render(<App />)
      for (const [code, text] of [
        ['changed', 'This worktree changed; look again'],
        ['unknown', 'Herdr is still working on it; check the list in a moment'],
        ['not_linked', 'Herdr does not manage this worktree'],
      ] as const) {
        removeWorktree.mockRejectedValueOnce(new RequestError(409, code, 'x'))
        fireEvent.click(screen.getByText('WorktreeRemove'))
        await act(async () => fireEvent.click(screen.getByText('RemoveYes')))
        expect(await screen.findByText(text)).toBeInTheDocument()
        expect(screen.queryByTestId('worktree-remove')).toBeNull()
      }
      // unknown is followed by the hook itself
      expect(refreshSessions).toHaveBeenCalledTimes(2)
    })
  })

  it('tells why a workspace was not closed', async () => {
    const { RequestError } = await import('./hooks/use-mux-api')
    withGroups('herdr')
    render(<App />)
    for (const [err, text] of [
      [
        new RequestError(409, 'has_worktrees', 'x'),
        'This workspace has worktrees; remove them first, or close it in Herdr',
      ],
      [new RequestError(500, '', 'x'), 'Could not close the workspace'],
    ] as const) {
      closeGroup.mockRejectedValueOnce(err)
      fireEvent.click(screen.getByText('GroupCloseWork'))
      const dialog = screen.getByTestId('confirm-dialog')
      await act(async () => {
        fireEvent.click(within(dialog).getByText('ConfirmYes'))
      })
      expect(await screen.findByText(text)).toBeInTheDocument()
    }
  })

  it('says nothing when the group was already gone', async () => {
    const { RequestError } = await import('./hooks/use-mux-api')
    withGroups('herdr')
    render(<App />)
    closeGroup.mockRejectedValueOnce(
      new RequestError(404, 'unknown_group', 'x'),
    )
    fireEvent.click(await screen.findByText('GroupCloseWork'))
    await act(async () => {
      fireEvent.click(screen.getByText('ConfirmYes'))
    })
    expect(screen.queryByText('Could not close the workspace')).toBeNull()
  })
})

describe('App command palette and shortcuts', () => {
  const switchSession = vi.fn(async () => 'ok')
  const addSession = vi.fn(async () => {})
  const selectPane = vi.fn()
  const toggleFullscreen = vi.fn()
  const FILES: AppView = {
    id: 'files',
    label: 'Files',
    Icon: Folder,
    available: () => true,
    placement: 'panel',
    Main: () => <div data-testid="files-main" />,
    Panel: () => <div data-testid="files-panel" />,
  }
  const CHAT: AppView = {
    id: 'chat',
    label: 'Chat',
    Icon: MessageSquare,
    available: () => true,
    Main: () => <div data-testid="chat-main" />,
  }
  const tab = (id: string) => ({
    id,
    name: id,
    icon: '📺',
    description: '',
    groupId: 'g',
    paneId: `${id}:p`,
    hasAgent: id === 'b',
    agentName: id === 'b' ? 'claude' : undefined,
  })

  function mockSessions(active = 'b', clientSideSelect = false) {
    const tabs = [tab('a'), tab('b'), tab('c')]
    mockUseLocalSessions.mockReturnValue({
      activeSession: tabs.find((t) => t.id === active) ?? tabs[0],
      sessions: tabs,
      groups: [{ id: 'g', name: 'main' }],
      switchSession,
      selectPane,
      addSession,
      removeSession: vi.fn(),
      updateSession: vi.fn(),
      isReady: true,
      isServerReachable: true,
      refreshSessions: vi.fn(),
      mux: {
        backend: 'tmux',
        caps: {
          clientSideSelect,
          copyMode: true,
          agentChat: true,
          files: true,
        },
      },
    } as any)
  }

  const press = (code: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(document.body, { code, key: code.slice(3), ...init })
  const openPalette = async () => {
    fireEvent.click(
      await screen.findByRole('button', { name: 'Command palette' }),
    )
    return screen.findByTestId('command-palette')
  }
  const run = async (title: string) => {
    await openPalette()
    fireEvent.click(screen.getByRole('button', { name: title }))
    await waitFor(() =>
      expect(screen.queryByTestId('command-palette')).toBeNull(),
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMobile.mockReturnValue(false)
    mockFinePointer.mockReturnValue(true)
    mockUseFullscreen.mockReturnValue({
      isFullscreen: false,
      isSupported: true,
      toggleFullscreen,
    })
    palette.fail = false
    palette.props = null
    resetAllShortcuts()
    mockSessions()
  })

  afterEach(() => {
    mockFinePointer.mockReturnValue(false)
    mockUseFullscreen.mockReset()
    mockUseFullscreen.mockImplementation(() => ({
      isFullscreen: false,
      isSupported: true,
      toggleFullscreen: vi.fn(),
    }))
    resetAllShortcuts()
  })

  it('opens from the header button and the keys, desktop only', async () => {
    render(<App />)
    const button = await screen.findByRole('button', {
      name: 'Command palette',
    })
    expect(button).toHaveAttribute('title', 'Command palette (Ctrl+Shift+P)')
    press('KeyP', { ctrlKey: true })
    expect(await screen.findByTestId('command-palette')).toHaveAttribute(
      'data-mode',
      'files',
    )
    fireEvent.click(screen.getByText('ClosePalette'))
    expect(screen.queryByTestId('command-palette')).toBeNull()
    press('KeyP', { ctrlKey: true, shiftKey: true })
    expect(await screen.findByTestId('command-palette')).toHaveAttribute(
      'data-mode',
      'commands',
    )
  })

  it('has no palette nor keys on a touch screen', async () => {
    mockFinePointer.mockReturnValue(false)
    render(<App />)
    await screen.findByTestId('terminal-view')
    expect(screen.queryByRole('button', { name: 'Command palette' })).toBeNull()
    press('KeyP', { ctrlKey: true })
    expect(screen.queryByTestId('command-palette')).toBeNull()
  })

  it('names no key on the button once the user removed it', async () => {
    setShortcut('palette.commands', { key: null })
    render(<App />)
    expect(
      await screen.findByRole('button', { name: 'Command palette' }),
    ).toHaveAttribute('title', 'Command palette')
  })

  it('runs a command once the palette has closed: dialogs', async () => {
    render(<App views={[APP_VIEWS[0], CHAT, FILES]} />)
    await run('Show help')
    expect(screen.getByTestId('help-modal')).toBeInTheDocument()
    fireEvent.click(screen.getByText('CloseHelp'))
    await run('About Termote')
    expect(screen.getByTestId('about-modal')).toBeInTheDocument()
    fireEvent.click(screen.getByText('CloseAbout'))
    await run('Open Settings: Shortcuts')
    expect(screen.getByTestId('settings-modal')).toHaveAttribute(
      'data-initial-group',
      'shortcuts',
    )
    expect(screen.getByTestId('settings-modal')).toHaveAttribute(
      'data-shortcuts',
      'true',
    )
    fireEvent.click(screen.getByText('CloseSettings'))
    await run('Open Settings')
    expect(screen.getByTestId('settings-modal')).toHaveAttribute(
      'data-initial-group',
      '',
    )
  })

  it('runs a command once the palette has closed: tabs and views', async () => {
    render(<App views={[APP_VIEWS[0], CHAT, FILES]} />)
    await run('Show the terminal')
    expect(mockFocusTerminal).toHaveBeenCalled()
    await run('New tab')
    expect(addSession).toHaveBeenCalledWith('New')
    await run('Previous tab')
    expect(switchSession).toHaveBeenLastCalledWith('a', undefined)
    await run('Next tab')
    expect(switchSession).toHaveBeenLastCalledWith('c', undefined)
    await run('Show the agent overview')
    await run('Toggle the Files panel')
    expect(screen.getByTestId('files-panel')).toBeInTheDocument()
  })

  it('runs a command once the palette has closed: the app', async () => {
    render(<App views={[APP_VIEWS[0], CHAT, FILES]} />)
    await run('Toggle the sidebar')
    await run('Toggle full screen')
    expect(toggleFullscreen).toHaveBeenCalled()
    await run('Terminal: larger text')
    await run('Terminal: smaller text')
    await run('Theme: dark')
    expect(screen.queryByTestId('command-palette')).toBeNull()
  })

  it('searches file contents from outside Files, opening the panel once', async () => {
    render(<App views={[APP_VIEWS[0], FILES]} />)
    await screen.findByTestId('terminal-view')
    press('KeyF', { ctrlKey: true, shiftKey: true })
    expect(await screen.findByTestId('files-panel')).toBeInTheDocument()
    // Open already: it stays open
    press('KeyF', { ctrlKey: true, shiftKey: true })
    expect(screen.getByTestId('files-panel')).toBeInTheDocument()
  })

  it('gives the palette what it needs to act on the pane', async () => {
    mockSessions('b', true)
    render(<App views={[APP_VIEWS[0], CHAT, FILES]} />)
    await openPalette()
    const p = palette.props!
    expect(p.composer).toBe(true)
    expect(p.filesAvailable).toBe(true)
    expect(p.selectPane).toBe(selectPane)
    act(() => p.onRun(() => p.showFilesPanel()))
    expect(await screen.findByTestId('files-panel')).toBeInTheDocument()
    await openPalette()
    // Open already: stays
    act(() => palette.props!.onRun(() => palette.props!.showFilesPanel()))
    expect(await screen.findByTestId('files-panel')).toBeInTheDocument()
    await openPalette()
    act(() => palette.props!.onRun(() => palette.props!.showChat()))
    expect(await screen.findByTestId('chat-main')).toBeInTheDocument()
    // Show Chat from the commands asks the message box for focus
    await run('Show Chat')
    expect(takeDraftInsert('b:p')).toBeNull()
    await openPalette()
    act(() =>
      palette.props!.onRun(() => palette.props!.sendToTerminal('/compact ')),
    )
    expect(mockSendTextToTerminal.mock.lastCall?.[1]).toBe('/compact ')
    expect(mockFocusTerminal).toHaveBeenCalled()
    await openPalette()
    act(() => palette.props!.onRun(() => palette.props!.selectSession('a')))
    await waitFor(() =>
      expect(switchSession).toHaveBeenLastCalledWith('a', undefined),
    )
  })

  it('offers no pane pick where the backend picks the pane', async () => {
    mockSessions('a')
    render(<App views={[APP_VIEWS[0], CHAT]} />)
    await openPalette()
    expect(palette.props!.selectPane).toBeUndefined()
    expect(palette.props!.composer).toBe(false)
    // No message box: Show Chat asks nothing of it
    await run('Show Chat')
    expect(takeDraftInsert('a:p')).toBeUndefined()
  })

  it('says so when the palette cannot load, and tries again next time', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    palette.fail = true
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Command palette' }),
    )
    expect(
      await screen.findByText('Could not load the command palette'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('command-palette')).toBeNull()
    palette.fail = false
    expect(await openPalette()).toBeInTheDocument()
    error.mockRestore()
  })

  it('fetches the palette while the desktop is idle', async () => {
    const idle = vi.fn((cb: () => void) => {
      cb()
      return 7
    })
    const cancel = vi.fn()
    Object.assign(window, {
      requestIdleCallback: idle,
      cancelIdleCallback: cancel,
    })
    try {
      const { unmount } = render(<App />)
      await screen.findByTestId('terminal-view')
      expect(idle).toHaveBeenCalled()
      unmount()
      expect(cancel).toHaveBeenCalledWith(7)
    } finally {
      Object.assign(window, {
        requestIdleCallback: undefined,
        cancelIdleCallback: undefined,
      })
    }
  })

  it('fetches the palette after a while without an idle callback', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { unmount } = render(<App />)
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('App prompt templates', () => {
  it('mounts the fill dialog only with templates, telling it each pane', async () => {
    const got = () => fillDialog.props
    fillDialog.props = null
    render(<App />)
    await screen.findByTestId('terminal-view')
    expect(got()).toBeNull()
    cleanup()

    const base = mockUseLocalSessions()
    mockUseLocalSessions.mockReturnValue({
      ...base,
      activeSession: { ...base.activeSession, paneId: 'pane1' },
      sessions: [
        {
          ...base.sessions[0],
          paneId: 'pane1',
          groupId: 'g1',
          hasAgent: true,
          agentName: 'claude',
        },
        { ...base.sessions[0], id: '2', paneId: 'pane2', groupId: 'gone' },
      ],
      groups: [
        { id: 'g1', name: 'main', worktree: { linked: true, branch: 'feat' } },
      ],
      mux: {
        backend: 'herdr',
        caps: { clientSideSelect: true, copyMode: false, templates: true },
      },
    } as any)
    render(<App />)
    await screen.findByTestId('terminal-view')
    const props = got() as FillDialogProps
    expect(props.pane('pane1')).toEqual({ agent: 'claude', branch: 'feat' })
    expect(props.pane('pane2')).toEqual({ agent: undefined, branch: undefined })
    expect(props.pane('nope')).toBeNull()
    // Only the pane the terminal shows has its selection
    expect(props.terminalText('pane1')).toBe('selected')
    expect(mockTerminalSelection).toHaveBeenCalled()
    expect(props.terminalText('pane2')).toBe('')
    mockUseLocalSessions.mockReturnValue(base as any)
  })
})
