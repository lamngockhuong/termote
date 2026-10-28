import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  APP_VIEWS,
  type AppView,
  availableViews,
  CHANGES_VIEW_ID,
  CHAT_VIEW_ID,
  FILES_VIEW_ID,
  type FileWindowTarget,
  type NotifyOptions,
  startOffered,
  TERMINAL_VIEW_ID,
  type ViewContext,
  type ViewProps,
  viewPanelId,
} from './app-views'
import { chatAgent, chatInputAgent } from './chat-agents'
import { AboutModal } from './components/about-modal'
import { AppHeader } from './components/app-header'
import { CommandHistoryDropdown } from './components/command-history-dropdown'
import type { CommandPaletteProps } from './components/command-palette'
import { type ConnectionState, isDown } from './components/connection-indicator'
import { GestureHintsOverlay } from './components/gesture-hints-overlay'
import { GroupDialog } from './components/group-dialog'
import { HelpModal } from './components/help-modal'
import { KeyboardToolbar } from './components/keyboard-toolbar'
import { LazyBoundary, LoadFailed } from './components/lazy-boundary'
import { LocalhostNotice } from './components/localhost-notice'
import { OverviewScreen } from './components/overview-screen'
import {
  PaneLayoutMenu,
  paneLayoutMessage,
  RESIZE_STEP,
} from './components/pane-layout-menu'
import { PaneStrip } from './components/pane-strip'
import { ReadOnlyBar } from './components/read-only-bar'
import { SelectTextSheet } from './components/select-text-sheet'
import {
  type GroupActions,
  moveProblem,
  type ReorderActions,
  SessionSidebar,
} from './components/session-sidebar'
import { SettingsModal } from './components/settings-modal'
import { SidePanel } from './components/side-panel'
import { TemplateFillDialog } from './components/template-fill-dialog'
import { type TerminalHandle, TerminalView } from './components/terminal-view'
import { Toast, type ToastAction, type ToastVariant } from './components/toast'
import { Banner } from './components/ui/banner'
import { Button } from './components/ui/button'
import { ConfirmDialog } from './components/ui/confirm-dialog'
import { HeaderUsageChip } from './components/usage-chip'
import {
  WorktreeDialog,
  WorktreeRemoveDialog,
  worktreeProblem,
} from './components/worktree-dialog'
import { useTheme } from './contexts/theme-context'
import { useAgentNotifications } from './hooks/use-agent-notifications'
import { useCommandHistory } from './hooks/use-command-history'
import { followInFiles, requestFilesFocus, usePlaces } from './hooks/use-files'
import { useFontSize } from './hooks/use-font-size'
import { useFullscreen } from './hooks/use-fullscreen'
import { useGestures } from './hooks/use-gestures'
import { openChangeFromLink } from './hooks/use-git-changes'
import {
  dropStaleViewerEntry,
  onViewerEntryGone,
  viewerOnTop,
} from './hooks/use-history-close'
import { useKeyboardVisible } from './hooks/use-keyboard-visible'
import { useLocalSessions } from './hooks/use-local-sessions'
import { useIsMobile, useMediaQuery } from './hooks/use-media-query'
import {
  logout,
  onViewOnlyRefusal,
  RequestError,
  selectTab,
} from './hooks/use-mux-api'
import { usePushSubscription } from './hooks/use-push-subscription'
import { useSettings } from './hooks/use-settings'
import { useKeymap, useShortcutDispatcher } from './hooks/use-shortcuts'
import { useSidebarCollapsed } from './hooks/use-sidebar-collapsed'
import { useStartAgent } from './hooks/use-start-agent'
import { availableUpdate, useUpdateCheck } from './hooks/use-update-check'
import type { Session, SessionPane } from './types/session'
import { applyUiStyle, syncThemeColor } from './ui-style'
import { buildAppCommands, type PaletteMode } from './utils/app-commands'
import { APP_INFO } from './utils/app-info'
import {
  checkOnShow,
  checkServerVersion,
  reloadToNewVersion,
  useAppUpdate,
} from './utils/app-update'
import { requestDraftInsert } from './utils/chat-draft'
import {
  type DeepLink,
  formatDeepLink,
  formatOverviewLink,
  OVERVIEW_HASH,
  parseDeepLink,
  parseScreenLink,
} from './utils/deep-link'
import { signOutPage } from './utils/files-persist'
import { isFocusWindow } from './utils/focus-mode'
import {
  LARGE_PACKET_HELP_URL,
  onLargePacketLoss,
} from './utils/large-packet-loss'
import { lazyRetry } from './utils/lazy-retry'
import { type OpenWindowEvent, openInWindow } from './utils/open-window'
import { loadPaneView, savePaneView } from './utils/pane-view'
import { isApplePlatform } from './utils/platform'
import { formatRunning, uniqueNames } from './utils/running-commands'
import { matchesFilter } from './utils/session-filter'
import { formatChord } from './utils/shortcuts'
import {
  attachImageToTerminal,
  blurTerminal,
  copyTerminalSelection,
  dragTerminal,
  focusTerminal,
  isTerminalDisconnected,
  overflowsHorizontally,
  type PasteErrorReason,
  type PasteResult,
  pasteTmuxBuffer,
  pasteToTerminal,
  readTerminalBufferText,
  scrollTerminal,
  scrollTmux,
  sendKeyToTerminal,
  sendTextToTerminal,
  terminalSelection,
  toggleTmuxCopyMode,
} from './utils/terminal-bridge'
import { visibleUnsafe } from './utils/unsafe-chars'
import {
  pickImageFile,
  UPLOAD_TIMEOUT_MS,
  uploadErrorMessage,
} from './utils/upload-image'
import { ZELLIJ_DEFAULT_GROUP_ID } from './utils/zellij-group'

// Check if paste result should show an error toast
const shouldShowPasteError = (
  result: PasteResult,
): result is { ok: false; reason: PasteErrorReason } =>
  !result.ok && result.reason !== 'empty' && result.reason !== 'no-terminal'

// Error-specific clipboard messages
const getClipboardErrorMsg = (
  reason: PasteErrorReason,
  isLongPress = false,
): string => {
  switch (reason) {
    case 'not-allowed':
      return isLongPress
        ? 'Long press paste not supported. Use the Paste button.'
        : 'Clipboard permission denied. Check browser settings.'
    case 'not-secure':
      return 'Clipboard requires HTTPS. Use text input to paste.'
    case 'not-supported':
      return 'Clipboard not supported. Use text input to paste.'
    default:
      return 'Clipboard access failed. Use text input to paste.'
  }
}

// A toast with an action stays long enough to reach the button.
const ACTION_TOAST_MS = 10000

// An upload slower than this shows that it is running.
const SLOW_UPLOAD_MS = 300

interface AppProps {
  // Views of the pane; tests register extra ones
  views?: AppView[]
  // View-only role: every way to change anything on the server is hidden.
  // The role the server reports (caps.role "view") sets it too.
  readOnly?: boolean
}

// The overview's address; the hash change opens it. A focus window keeps
// solo=1 in it, so a reload is a focus window again.
function showOverviewAddress() {
  const hash = formatOverviewLink({ solo: isFocusWindow() })
  if (window.location.hash !== hash) window.location.hash = hash
}

// The file a focus window was opened on: a file in the Files panel, or a
// side's diff in the Changes panel
type FocusFile = Required<Pick<DeepLink, 'view' | 'file'>> &
  Pick<DeepLink, 'staged' | 'orig' | 'place'>

// The address of the main window for link: the same target, without solo
function mainWindowURL(link: string | null) {
  const { origin, pathname, search } = window.location
  const parsed = link && parseDeepLink(link)
  const hash = parsed
    ? formatDeepLink({ ...parsed, solo: undefined })
    : link
      ? OVERVIEW_HASH
      : ''
  return `${origin}${pathname}${search}${hash}`
}

// The window that opened this one, when it is this app's
function openerWindow(): Window | null {
  try {
    const w = window.opener as Window | null
    return w && !w.closed && w.location.origin === window.location.origin
      ? w
      : null
  } catch {
    // Another origin's window: not ours to drive
    return null
  }
}

export default function App({
  views = APP_VIEWS,
  readOnly: readOnlyProp = false,
}: AppProps = {}) {
  const terminalRef = useRef<TerminalHandle>(null)
  // Stable, so the handlers that depend on it are not rebuilt every render;
  // it reads the ref at call time.
  const getTerminal = useCallback(() => terminalRef.current, [])
  const gestureRef = useRef<HTMLDivElement>(null)
  const ctrlInputRef = useRef<HTMLInputElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { isCollapsed: sidebarCollapsed, toggle: toggleSidebarCollapsed } =
    useSidebarCollapsed()
  const [aboutOpen, setAboutOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Group Settings opens at; About's "Check for updates" asks for Updates
  const [settingsGroup, setSettingsGroup] = useState<string>()
  const [gestureHintsOpen, setGestureHintsOpen] = useState(false)
  const [toast, setToast] = useState<{
    id: number
    message: string
    variant: ToastVariant
    action?: ToastAction
    duration?: number
  } | null>(null)
  // Each toast gets its own id, so the same message again starts afresh
  const toastIdRef = useRef(0)
  // Returns the toast's id, so its owner can close only that one.
  const showToast = useCallback(
    (
      message: string,
      variant: ToastVariant = 'info',
      action?: ToastAction,
      duration?: number,
    ) => {
      const id = ++toastIdRef.current
      setToast({ id, message, variant, action, duration })
      return id
    },
    [],
  )
  const onDriveLost = useCallback(
    (reason: 'taken-over' | 'failed') =>
      showToast(
        reason === 'taken-over'
          ? 'Another device took over the terminal size. Reopen the page to take it back'
          : 'Could not fit the pane to this device; showing the desktop size',
        'warning',
      ),
    [showToast],
  )
  // A write the server refused as view-only (a control the UI missed).
  useEffect(
    () =>
      onViewOnlyRefusal(() => showToast('This device is view-only', 'warning')),
    [showToast],
  )
  // State of the terminal stream, reported by TerminalView.
  const [streamState, setStreamState] = useState<ConnectionState>('connecting')
  const { settings, updateSetting } = useSettings()
  const [ctrlActive, setCtrlActive] = useState(false)
  const [imeMode, setImeMode] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  // The Select text sheet: the pane's text to select and copy
  const [selectTextOpen, setSelectTextOpen] = useState(false)
  const { history, addCommand, removeCommand, clearHistory } =
    useCommandHistory()
  const isMobile = useIsMobile()
  // Opened from "Open in new window": only the link's target, nothing kept
  const focus = isFocusWindow()
  // Desktop only: the command palette, app shortcuts and other windows
  const finePointer = useMediaQuery('(pointer: fine)')
  const desktop = finePointer && !isMobile
  const {
    isVisible: keyboardVisible,
    keyboardHeight,
    viewportHeight,
    viewportOffsetTop,
  } = useKeyboardVisible()
  const {
    activeSession,
    sessions,
    groups = [],
    switchSession,
    selectPane,
    addSession,
    removeSession,
    removePane,
    splitPane,
    zoomPane,
    swapPane,
    resizePane,
    updateSession,
    createGroup,
    renameGroup,
    closeGroup,
    createWorktree,
    openWorktree,
    showGroup,
    removeWorktree,
    moveTab,
    moveGroup,
    moving,
    isReady,
    isServerReachable,
    refreshSessions,
    mux,
    clockOffset,
  } = useLocalSessions(settings.pollInterval)
  // The server refuses every write of a view-only device; the UI hides them.
  const readOnly = readOnlyProp || mux.caps.role === 'view'
  // The Places, read once: a root found by a search or a file opened
  // lately opens the Place it is the root of
  usePlaces(!readOnly && !!mux.caps.places)
  // A view-only device on a backend that cannot stream to it (tmux before
  // 3.2, psmux): the terminal is not opened at all.
  const viewStreamOff = mux.caps.role === 'view' && !mux.caps.viewStream
  const copyModeSupported = mux.caps.copyMode
  const push = usePushSubscription({
    // A view-only device gets no Web Push (the server refuses it).
    available: !!mux.caps.push && !readOnly,
    enabled: settings.notifyAgents,
  })
  useAgentNotifications({
    sessions,
    groups,
    activePaneId: activeSession.paneId,
    enabled: settings.notifyAgents,
    pushActive: push.pushActive,
  })
  // Ends the session on the server, then shows the sign-in page. This
  // device stops getting pushes first (the server forgets it within 3 s).
  const disablePush = push.disable
  const handleLogout = useCallback(async () => {
    await disablePush()
    try {
      if (await logout()) {
        signOutPage()
        return
      }
    } catch {
      // Shown below, like a refusal.
    }
    showToast('Could not log out. Try again', 'danger')
  }, [showToast, disablePush])
  // Each snapshot that still lists the pane on screen (a new sessions array
  // per poll): a stream that exited with it, a tmux session closed and made
  // again, reconnects.
  const paneSeen = useMemo(
    () =>
      sessions.some((s) =>
        s.panes?.length
          ? s.panes.some((p) => p.id === activeSession.paneId)
          : s.id === activeSession.paneId,
      )
        ? sessions
        : undefined,
    [sessions, activeSession.paneId],
  )
  // Closing a tab ends whatever runs in it, so every way to close one (tab
  // bar, sidebar, swipe, Delete key) asks first. The question holds the
  // tab's key: a move that shifts its id (tmux) leaves it on the same tab,
  // and it goes away with the tab.
  const [pendingRemoveKey, setPendingRemoveKey] = useState<string | null>(null)
  const pendingRemove = sessions.find(
    (s) => (s.key ?? s.id) === pendingRemoveKey,
  )
  const requestRemove = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id)
      setPendingRemoveKey(session?.key ?? id)
    },
    [sessions],
  )
  const cancelRemove = useCallback(() => setPendingRemoveKey(null), [])
  const confirmRemove = useCallback(() => {
    // Only reachable from the open dialog, which needs a pending tab
    removeSession(pendingRemove!.id).catch(() =>
      showToast('The tab changed; try again', 'warning'),
    )
    setPendingRemoveKey(null)
  }, [pendingRemove, removeSession, showToast])
  // Closing a pane ends what runs in it too, so it asks the same way.
  const [pendingPaneId, setPendingPaneId] = useState<string | null>(null)
  // The pane layout actions, on the pane shown: offered where the backend
  // has them, never to a view-only device. A refusal shows as a toast.
  const paneLayoutOn = !!mux.caps.paneLayout && !readOnly
  const shownPanes = activeSession.panes ?? []
  const shownPaneIndex = shownPanes.findIndex(
    (p) => p.id === activeSession.paneId,
  )
  // Zellij turns the panes around: any other pane is a next one
  const canSwapNext =
    mux.backend === 'zellij'
      ? shownPanes.length > 1
      : shownPaneIndex >= 0 && shownPaneIndex < shownPanes.length - 1
  const runPaneAction = useCallback(
    (act: () => Promise<unknown>) => {
      act().catch((err) => showToast(paneLayoutMessage(err), 'warning'))
    },
    [showToast],
  )
  const pendingPane = activeSession.panes?.find((p) => p.id === pendingPaneId)
  const cancelPaneClose = useCallback(() => setPendingPaneId(null), [])
  const confirmPaneClose = useCallback(() => {
    // Only reachable from the open dialog, which needs a pending id
    removePane(pendingPaneId!)
    setPendingPaneId(null)
  }, [pendingPaneId, removePane])
  const isHerdr = mux.backend === 'herdr'
  const isZellij = mux.backend === 'zellij'
  // Groups (tmux and Zellij sessions, Herdr workspaces) made, renamed and
  // closed here. The default session (tmux: its id is its name, the others
  // are "$N"; Zellij: the one named "main") cannot be renamed, and closing
  // it starts a new, empty one at once.
  const groupNoun = isHerdr
    ? 'workspace'
    : isZellij
      ? 'Zellij session'
      : 'tmux session'
  const isDefaultGroup = (id: string) =>
    isZellij ? id === ZELLIJ_DEFAULT_GROUP_ID : !isHerdr && !id.startsWith('$')
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [pendingGroupCloseId, setPendingGroupCloseId] = useState<string | null>(
    null,
  )
  const pendingGroupClose = groups.find((g) => g.id === pendingGroupCloseId)
  const pendingGroupSessions = sessions.filter(
    (s) => s.groupId === pendingGroupCloseId,
  )
  const pendingGroupTabs = pendingGroupSessions.length
  // Git worktrees of a workspace's repository (Herdr): the New/Open dialog
  // and the removal, asked twice when the worktree has changes.
  const [worktreeDialog, setWorktreeDialog] = useState<{
    mode: 'new' | 'open'
    groupId: string
  } | null>(null)
  const [worktreeRemove, setWorktreeRemove] = useState<{
    groupId: string
    force?: { path: string; branch: string }
  } | null>(null)
  const worktreeActions = mux.caps.worktrees
    ? {
        onNewWorktree: (groupId: string) =>
          setWorktreeDialog({ mode: 'new', groupId }),
        onOpenWorktree: (groupId: string) =>
          setWorktreeDialog({ mode: 'open', groupId }),
        onRemoveWorktree: (groupId: string) => setWorktreeRemove({ groupId }),
      }
    : {}
  // Moving tabs and groups, where the server offers it; a refusal is told
  // in a toast.
  const reorder: ReorderActions | undefined = readOnly
    ? undefined
    : {
        tabs: !!mux.caps.reorderTabs,
        groups: !!mux.caps.reorderGroups,
        onMoveTab: (id, index) =>
          moveTab(id, index).catch((err) =>
            showToast(moveProblem(err), 'danger'),
          ),
        onMoveGroup: (id, index) =>
          moveGroup(id, index).catch((err) =>
            showToast(moveProblem(err), 'danger'),
          ),
        moving,
      }
  const groupActions: GroupActions | undefined =
    mux.caps.groups && !readOnly
      ? {
          noun: groupNoun,
          onNew: () => setNewGroupOpen(true),
          onRename: renameGroup,
          onClose: setPendingGroupCloseId,
          canRename: (id) => !isDefaultGroup(id),
          ...worktreeActions,
        }
      : undefined
  // Tab bars show the current group only; the sidebar shows every group.
  const groupSessions = useMemo(
    () =>
      activeSession.groupId
        ? sessions.filter((s) => s.groupId === activeSession.groupId)
        : sessions,
    [sessions, activeSession.groupId],
  )
  const groupName = groups.find((g) => g.id === activeSession.groupId)?.name
  // Mobile chip: tabs waiting on the user besides the one on screen.
  const blockedElsewhere = useMemo(
    () =>
      sessions.filter(
        (s) => s.id !== activeSession.id && matchesFilter(s, 'needs-you'),
      ).length,
    [sessions, activeSession.id],
  )

  // Views offered for this pane; one that stops being offered gives way to
  // the terminal.
  const [viewId, setViewId] = useState(TERMINAL_VIEW_ID)
  // A view's content in the desktop side panel, next to the terminal
  const [sidePanelId, setSidePanelId] = useState<string | null>(null)
  // The terminal is the way out of every view. tmux shares its current
  // window between clients, so the window is selected again first: another
  // device may have moved it while this one showed the chat.
  const showView = useCallback(
    (id: string) => {
      if (
        id === TERMINAL_VIEW_ID &&
        !mux.caps.clientSideSelect &&
        !readOnly &&
        activeSession.id
      ) {
        selectTab(activeSession.id).catch(() => {})
      }
      // A panel view on desktop opens in the side panel and the main view
      // stays: the Chat a file path was opened from is still on screen
      if (!isMobile && views.find((v) => v.id === id)?.placement) {
        setSidePanelId(id)
        return
      }
      setViewId(id)
    },
    [mux.caps.clientSideSelect, readOnly, activeSession.id, isMobile, views],
  )
  // Shows a tab and a view of it (the terminal unless named) for a view
  // that points elsewhere: a task's tab, the agent its output went to. The
  // ref holds the latest selectSession (defined further down), so a toast's
  // action pressed later still finds a tab read since.
  // Set on every render, once selectSession exists (below)
  const openTabRef = useRef<
    (id: string, paneId?: string, view?: string) => void
  >(undefined as never)
  const openTab = useCallback(
    (id: string, paneId?: string, view?: string) =>
      openTabRef.current(id, paneId, view),
    [],
  )
  const notify = useCallback(
    (m: string, o?: NotifyOptions) =>
      showToast(m, o?.variant, o?.action, o?.duration),
    [showToast],
  )
  // Agents started from the Chat view of an idle pane, followed here so a
  // start goes on when the user moves to another pane.
  const agentPanes = useMemo(
    () =>
      new Set(
        sessions.flatMap((s) =>
          (s.panes ?? []).filter((p) => p.hasAgent).map((p) => p.id),
        ),
      ),
    [sessions],
  )
  const agentStart = useStartAgent({
    activePaneId: activeSession.paneId,
    agentPanes,
    showView,
    notify,
  })
  const viewContext: ViewContext = useMemo(
    () => ({ mux, session: activeSession, readOnly, agentStart }),
    [mux, activeSession, readOnly, agentStart],
  )
  const offeredViews = useMemo(
    () => availableViews(views, viewContext),
    [views, viewContext],
  )
  // Desktop shows the panel views next to the terminal, from a header
  // toggle; mobile has no room for that and keeps them in the switcher.
  const switcherViews = useMemo(
    () => (isMobile ? offeredViews : offeredViews.filter((v) => !v.placement)),
    [isMobile, offeredViews],
  )
  const panelViews = useMemo(
    () => (isMobile ? [] : offeredViews.filter((v) => v.placement)),
    [isMobile, offeredViews],
  )
  // From the switcher's views only: a panel view is never the main view on
  // desktop, so its Main and Panel are never on screen together.
  const currentView =
    switcherViews.find((v) => v.id === viewId) ?? switcherViews[0]
  const isTerminalView = currentView.id === TERMINAL_VIEW_ID
  // Each pane comes back on the view (and side panel) it was left on; one
  // never shown opens on the terminal. Before paint, so the previous pane's
  // view never flashes on the new one.
  const viewPaneId = activeSession.paneId ?? activeSession.id
  const viewPaneRef = useRef(viewPaneId)
  // The view a link asked for a pane not on screen yet: a focus window
  // keeps no pane view to find it in once the pane shows
  const linkViewRef = useRef<{ paneId: string; view: string } | null>(null)
  useLayoutEffect(() => {
    if (viewPaneRef.current !== viewPaneId) {
      viewPaneRef.current = viewPaneId
      const asked = linkViewRef.current
      linkViewRef.current = null
      const saved =
        asked?.paneId === viewPaneId
          ? { view: asked.view, panel: null }
          : loadPaneView(viewPaneId)
      setViewId(saved?.view ?? TERMINAL_VIEW_ID)
      setSidePanelId(saved?.panel ?? null)
      return
    }
    savePaneView(viewPaneId, { view: viewId, panel: sidePanelId })
  }, [viewPaneId, viewId, sidePanelId])
  // A panel view follows the layout: to the side panel when the screen
  // grows to desktop (or a link opens one there), back to the main area when
  // it shrinks to mobile.
  useEffect(() => {
    if (!isMobile && views.find((v) => v.id === viewId)?.placement) {
      setSidePanelId(viewId)
      setViewId(TERMINAL_VIEW_ID)
    } else if (isMobile && sidePanelId) {
      setViewId(sidePanelId)
      setSidePanelId(null)
    }
  }, [isMobile, viewId, sidePanelId, views])
  const openSettings = useCallback((group?: string) => {
    setSettingsGroup(group)
    setSettingsOpen(true)
  }, [])
  // "Open in new window" (desktop): a link with solo=1 in a window of its
  // own; a phone has no second window to open
  const openLinkWindow = useCallback(
    (hash: string, popup: boolean) => {
      if (!openInWindow(hash, popup)) showToast('Pop-up blocked', 'warning')
    },
    [showToast],
  )
  // The link of a tab (and pane) of this server, in a focus window
  const soloLink = useCallback(
    (session: Session, paneId?: string, rest: Partial<DeepLink> = {}) =>
      session.groupId
        ? formatDeepLink({
            group: session.groupId,
            tab: session.id,
            pane: mux.caps.clientSideSelect ? paneId : undefined,
            solo: true,
            ...rest,
          })
        : null,
    [mux.caps.clientSideSelect],
  )
  // A file or diff of the pane in its own window: on a desktop, where a link
  // names the pane (its tab has a group), and not from a focus window, whose
  // Open in main window would then lead back to that window, not the main one
  const openFileWindow = useMemo(() => {
    const group = activeSession.groupId
    if (!desktop || focus || !group) return undefined
    return (target: FileWindowTarget, e: OpenWindowEvent) =>
      openLinkWindow(
        formatDeepLink({
          group,
          tab: activeSession.id,
          pane: mux.caps.clientSideSelect ? activeSession.paneId : undefined,
          view: target.view,
          solo: true,
          file: target.file,
          ...(target.staged && { staged: true as const }),
          orig: target.orig,
          place: target.place,
        }),
        e.shiftKey,
      )
  }, [
    desktop,
    focus,
    activeSession.groupId,
    activeSession.id,
    activeSession.paneId,
    mux.caps.clientSideSelect,
    openLinkWindow,
  ])
  const viewProps = {
    ...viewContext,
    isMobile,
    notify,
    showView,
    openSettings,
    openWindow: openFileWindow,
    sessions,
    openTab,
    refreshSessions,
  }
  const sidePanelView = panelViews.find((v) => v.id === sidePanelId && v.Panel)
  const hasSidePanel = !!sidePanelView
  // Neither is kept once the panel goes: it opens again at its saved width.
  const [panelMaximized, setPanelMaximized] = useState(false)
  const [panelResizing, setPanelResizing] = useState(false)
  useEffect(() => {
    if (hasSidePanel) return
    setPanelMaximized(false)
    setPanelResizing(false)
  }, [hasSidePanel])
  // The maximized panel covers the input area: the history dropdown over it
  // would float above the panel, out of reach
  useEffect(() => {
    if (panelMaximized) setHistoryOpen(false)
  }, [panelMaximized])
  const holdTerminalSize = hasSidePanel && (panelResizing || panelMaximized)
  // A focus window's file covers the terminal: no stream there, which would
  // only take one of the server's
  const streamOff = focus && hasSidePanel && panelMaximized
  const setSidePanelWidth = useCallback(
    (width: number) => updateSetting('sidePanelWidth', width),
    [updateSetting],
  )
  // tabpanel roles only mean something next to the desktop tabs; the mobile
  // header switches views from a menu
  const panelRole =
    !isMobile && switcherViews.length > 1 ? 'tabpanel' : undefined
  const { fontSize, increase, decrease } = useFontSize()
  const { resolvedTheme, setTheme } = useTheme()
  // Before paint and before the terminal's effects read the tokens.
  useLayoutEffect(() => applyUiStyle(settings.uiStyle), [settings.uiStyle])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tokens it reads change with both
  useEffect(() => syncThemeColor(), [settings.uiStyle, resolvedTheme])
  const {
    isFullscreen,
    isSupported: canFullscreen,
    toggleFullscreen,
  } = useFullscreen()
  const appUpdate = useAppUpdate()
  // The newest release on GitHub (asked at most once an hour), named in About
  // while the server runs an older one. The header's menu marks it only for
  // whoever can act on it: not a viewer, nor a checkout (pulled by hand).
  const { latest: latestRelease, check: checkRelease } = useUpdateCheck()
  const updateVersion = availableUpdate(
    appUpdate.server?.version ?? APP_INFO.version,
    latestRelease,
  )
  const notifyUpdate = !readOnly && appUpdate.server?.install !== 'checkout'
  const openUpdates = () => {
    setAboutOpen(false)
    setSettingsGroup('updates')
    setSettingsOpen(true)
  }

  // The indicator follows the stream; a failing session poll can only mark
  // it down, never up, so it does not show "connected" while the stream is
  // still backing off.
  // Without a stream on purpose (a focus window's file covers the terminal)
  // the server's own state is all there is to show.
  const connectionState: ConnectionState = !isServerReachable
    ? 'disconnected'
    : streamOff
      ? 'connected'
      : streamState

  // The server's version, read on start, whenever the terminal stream comes
  // back (an update restarts the server) and when the app is shown again:
  // another /api/mux version replaces this page at once, another release
  // offers the reload (the banner).
  const droppedRef = useRef(false)
  useEffect(() => {
    if (isDown(streamState)) {
      droppedRef.current = true
    } else if (streamState === 'connected' && droppedRef.current) {
      droppedRef.current = false
      checkServerVersion()
    }
  }, [streamState])
  useEffect(() => {
    checkServerVersion()
    checkRelease()
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      checkOnShow()
      checkRelease()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [checkRelease])

  // Shown once per page load: the poll and the stream report it on every
  // retry while the network keeps dropping large replies.
  const packetHintShownRef = useRef(false)
  useEffect(
    () =>
      onLargePacketLoss(() => {
        if (packetHintShownRef.current) return
        packetHintShownRef.current = true
        showToast(
          'This network seems to drop large replies, so the terminal cannot load. Lowering the Tailscale MTU on the server fixes it',
          'warning',
          {
            label: 'How to fix',
            onClick: () =>
              window.open(LARGE_PACKET_HELP_URL, '_blank', 'noopener'),
          },
          15_000,
        )
      }),
    [showToast],
  )

  // tmux scrolls its own history (copy mode); other backends scroll the
  // xterm.js scrollback.
  // tmux copy mode scrolls by sending keys, so view-only scrolls the
  // xterm.js scrollback instead.
  const handleScroll = useCallback(
    (direction: 'up' | 'down') => {
      if (copyModeSupported && !readOnly) scrollTmux(getTerminal(), direction)
      else scrollTerminal(getTerminal(), direction)
    },
    [copyModeSupported, readOnly, getTerminal],
  )

  // Images reach the agent as a path typed into the pane: uploaded to the
  // host first. View-only sends nothing, so it uploads nothing either.
  const uploadsOn = !!mux.caps.uploads && !readOnly
  // The pane an upload is for is compared with this once it ends.
  const activePaneRef = useRef('')
  activePaneRef.current = activeSession.paneId ?? activeSession.id

  // Types an uploaded path into the current pane, or offers to copy it.
  const insertUploadedPath = useCallback(
    (insert: string) => {
      if (getTerminal()?.paste(`${insert} `)) return
      showToast(`Image not inserted: ${insert}`, 'warning', {
        label: 'Copy',
        // No clipboard API over plain HTTP: that throws, and is caught too.
        onClick: () => {
          Promise.resolve()
            .then(() => navigator.clipboard.writeText(insert))
            .catch(() => showToast('Could not copy the path', 'danger'))
        },
      })
    },
    [getTerminal, showToast],
  )

  const attachImage = useCallback(
    async (image: Blob) => {
      // Shown for as long as the upload may run; closed only if still shown.
      let uploadingToast = 0
      const timer = setTimeout(() => {
        uploadingToast = showToast(
          'Uploading image…',
          'info',
          undefined,
          UPLOAD_TIMEOUT_MS,
        )
      }, SLOW_UPLOAD_MS)
      const result = await attachImageToTerminal(
        getTerminal(),
        image,
        activePaneRef.current,
        () => activePaneRef.current,
      )
      clearTimeout(timer)
      switch (result.status) {
        case 'inserted':
          setToast((t) => (t?.id === uploadingToast ? null : t))
          break
        case 'pane-changed':
          showToast(`Image uploaded: ${result.insert}`, 'info', {
            label: 'Insert',
            onClick: () => insertUploadedPath(result.insert),
          })
          break
        case 'not-inserted':
          insertUploadedPath(result.insert)
          break
        case 'failed':
          showToast(uploadErrorMessage(result.reason), 'danger')
      }
    },
    [getTerminal, showToast, insertUploadedPath],
  )

  const handleAttachImage = useCallback(async () => {
    const file = await pickImageFile()
    if (file) await attachImage(file)
  }, [attachImage])

  // Pastes the clipboard's text; an image without text is uploaded instead
  // when the server takes uploads. Long press gets its own error wording.
  const pasteClipboard = useCallback(
    async (longPress = false) => {
      const result = await pasteToTerminal(getTerminal(), {
        images: uploadsOn,
      })
      if (shouldShowPasteError(result)) {
        showToast(getClipboardErrorMsg(result.reason, longPress), 'danger')
      } else if (result.ok && result.image) {
        await attachImage(result.image)
      }
    },
    [getTerminal, uploadsOn, showToast, attachImage],
  )

  // The history follows the finger, except with tmux copy mode, which only
  // scrolls by pages (keys), so a swipe there scrolls one page.
  const dragsHistory = !(copyModeSupported && !readOnly)

  // The pane keeps the backend's size: Herdr, and Zellij's view-only stream
  // (screen renders, like Herdr's).
  const fixedSize = isHerdr || (isZellij && readOnly)

  // Swipes and long press send input; while view-only only scrolling and
  // zooming remain.
  const gestureHandlers = useMemo(
    () => ({
      // A herdr pane wider than the screen is dragged sideways instead; it
      // also keeps a stray swipe from interrupting an agent with Ctrl+C.
      onSwipeLeft: () => {
        if (fixedSize && overflowsHorizontally(getTerminal())) return
        if (!readOnly) sendKeyToTerminal(getTerminal(), 'c', { ctrl: true })
      },
      onSwipeRight: () => {
        if (fixedSize && overflowsHorizontally(getTerminal())) return
        if (!readOnly) sendKeyToTerminal(getTerminal(), 'Tab')
      },
      // A zoomed herdr pane larger than the screen moves with the finger,
      // then the history does.
      onPan: (dx: number, dy: number) =>
        dragTerminal(getTerminal(), fixedSize ? dx : 0, dy, dragsHistory),
      onSwipeUp: () => {
        if (!dragsHistory) handleScroll('down')
      },
      onSwipeDown: () => {
        if (!dragsHistory) handleScroll('up')
      },
      onLongPress: async () => {
        if (!readOnly) await pasteClipboard(true)
      },
      onPinchIn: decrease,
      onPinchOut: increase,
    }),
    [
      decrease,
      dragsHistory,
      increase,
      fixedSize,
      getTerminal,
      handleScroll,
      readOnly,
      pasteClipboard,
    ],
  )

  const toggleKeyboard = () => {
    if (keyboardVisible) {
      blurTerminal(getTerminal())
    } else {
      focusTerminal(getTerminal())
    }
  }

  // Handle Ctrl+key input from hidden input field
  const handleCtrlInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      if (value.length === 1 && /^[a-zA-Z]$/.test(value)) {
        sendKeyToTerminal(getTerminal(), value.toLowerCase(), {
          ctrl: true,
        })
        setCtrlActive(false)
        focusTerminal(getTerminal())
      }
      e.target.value = ''
    },
    [getTerminal],
  )

  // Focus hidden input when Ctrl is active
  useEffect(() => {
    if (ctrlActive && ctrlInputRef.current) {
      blurTerminal(getTerminal())
      ctrlInputRef.current.focus()
    }
  }, [ctrlActive, getTerminal])

  // Show gesture hints on first mobile visit
  useEffect(() => {
    if (isMobile && !settings.hasSeenGestureHints) {
      setGestureHintsOpen(true)
    }
  }, [isMobile, settings.hasSeenGestureHints])

  const dismissGestureHints = useCallback(() => {
    setGestureHintsOpen(false)
    updateSetting('hasSeenGestureHints', true)
  }, [updateSetting])

  const showGestureHints = useCallback(() => {
    setSettingsOpen(false)
    setGestureHintsOpen(true)
  }, [])

  useGestures(gestureRef, gestureHandlers)

  const handleKey = useCallback(
    (key: string) => {
      // A dropped stream that is not retrying on its own reconnects on Enter.
      if (key === 'Enter' && isTerminalDisconnected(getTerminal())) {
        terminalRef.current?.reconnect()
        return
      }
      sendKeyToTerminal(getTerminal(), key)
    },
    [getTerminal],
  )

  const handleCtrlKey = useCallback(
    (key: string) => {
      sendKeyToTerminal(getTerminal(), key, { ctrl: true })
    },
    [getTerminal],
  )

  const handleShiftKey = useCallback(
    (key: string) => {
      sendKeyToTerminal(getTerminal(), key, { shift: true })
    },
    [getTerminal],
  )

  const onTerminalCopy = useCallback(
    (result: 'ok' | 'failed') => {
      if (result === 'ok') showToast('Copied', 'success', undefined, 1500)
      else showToast('Could not copy', 'danger')
    },
    [showToast],
  )

  const handleCtrlShiftKey = useCallback(
    async (key: string) => {
      if (key === 'v') {
        await pasteClipboard()
        return
      }
      // ^⇧C with a selection copies it, as the keyboard shortcut does
      if (key === 'c') {
        const result = await copyTerminalSelection(getTerminal())
        if (result !== 'empty') {
          onTerminalCopy(result)
          return
        }
      }
      sendKeyToTerminal(getTerminal(), key, { ctrl: true, shift: true })
    },
    [getTerminal, pasteClipboard, onTerminalCopy],
  )

  const openSelectText = useCallback(() => setSelectTextOpen(true), [])
  const readBufferText = useCallback(
    () => readTerminalBufferText(getTerminal()),
    [getTerminal],
  )

  const handleTmuxCopy = useCallback(() => {
    toggleTmuxCopyMode(getTerminal())
  }, [getTerminal])

  // Unified paste handler based on pasteSource setting
  const handlePaste = useCallback(async () => {
    if (settings.pasteSource === 'tmux' && copyModeSupported) {
      pasteTmuxBuffer(getTerminal())
    } else {
      await pasteClipboard()
    }
  }, [settings.pasteSource, copyModeSupported, getTerminal, pasteClipboard])

  const handleSendText = useCallback(
    (text: string) => {
      sendTextToTerminal(getTerminal(), text)
      addCommand(text) // Save to history
      if (settings.imeSendBehavior === 'send-enter') {
        sendKeyToTerminal(getTerminal(), 'Enter')
      }
    },
    [settings.imeSendBehavior, addCommand, getTerminal],
  )

  // The Actions row of the toolbar's expanded keys (mobile only).
  // Reads the ref directly so the object stays the same across renders.
  const quickActions = useMemo(
    () => ({
      onSendKey: (key: string, opts?: { ctrl?: boolean }) => {
        if (opts?.ctrl) {
          sendKeyToTerminal(terminalRef.current, key, { ctrl: true })
        } else sendKeyToTerminal(terminalRef.current, key)
      },
      onSendText: (text: string) =>
        sendTextToTerminal(terminalRef.current, text),
    }),
    [],
  )

  const handleHistorySelect = useCallback(
    (text: string) => {
      sendTextToTerminal(getTerminal(), text)
      sendKeyToTerminal(getTerminal(), 'Enter')
      setHistoryOpen(false)
    },
    [getTerminal],
  )

  // A view-only device on tmux watches each session's current window: the
  // server refuses to switch it, so another tab is only explained.
  const selectSession = useCallback(
    async (id: string, paneId?: string) => {
      if ((await switchSession(id, paneId)) !== 'view-only') return true
      showToast('View only: follows the active window', 'info')
      return false
    },
    [switchSession, showToast],
  )

  // The view is kept for the pane, as a link's is: the pane comes up on it
  // once shown, and nothing selects the tab being left again (tmux shares
  // its current window).
  openTabRef.current = (id, paneId, view = TERMINAL_VIEW_ID) => {
    const target = paneId ?? id
    savePaneView(target, {
      view,
      panel: loadPaneView(target)?.panel ?? null,
    })
    if (target === viewPaneRef.current) setViewId(view)
    void selectSession(id, paneId)
  }

  // The sheet stays open on a tab a view-only device cannot watch.
  const handleMobileSelect = async (id: string) => {
    setOverviewOpen(false)
    if (await selectSession(id)) setSidebarOpen(false)
  }

  // The new session is selected once created; the sheet closes onto it.
  const confirmGroupClose = () => {
    const id = pendingGroupCloseId!
    setPendingGroupCloseId(null)
    closeGroup(id).catch((err) => {
      if (err instanceof RequestError && err.code === 'has_worktrees') {
        showToast(
          'This workspace has worktrees; remove them first, or close it in Herdr',
          'warning',
        )
      } else if (
        !(err instanceof RequestError && err.code === 'unknown_group')
      ) {
        showToast(`Could not close the ${groupNoun}`, 'danger')
      }
    })
  }

  // A dirty worktree is asked about a second time; any other refusal is a
  // toast, and the list is read again.
  const confirmWorktreeRemove = (
    groupId: string,
    w: { force: boolean; path: string; branch: string },
  ) => {
    setWorktreeRemove(null)
    removeWorktree(groupId, w).catch((err) => {
      const code = err instanceof RequestError ? err.code : ''
      if (code === 'dirty' && !w.force) {
        setWorktreeRemove({
          groupId,
          force: { path: w.path, branch: w.branch },
        })
        return
      }
      const variant =
        code === 'changed' ? 'info' : code === 'unknown' ? 'warning' : 'danger'
      showToast(worktreeProblem(code), variant)
      if (code !== 'unknown') void refreshSessions()
    })
  }

  // A refusal the user can act on (Zellij: no client attached to the
  // session) is told in a toast; resolves to whether the tab was asked for.
  const addTab = useCallback(
    async (...args: Parameters<typeof addSession>) => {
      try {
        await addSession(...args)
        return true
      } catch (err) {
        showToast(
          err instanceof RequestError ? err.message : 'Could not add a tab',
          'warning',
        )
        return false
      }
    },
    [addSession, showToast],
  )

  const handleMobileAdd = async (
    name: string,
    icon?: string,
    description?: string,
  ) => {
    if (await addTab(name, icon, description)) setSidebarOpen(false)
  }

  // A link's file or diff, opened in its pane's Files or Changes panel; a
  // focus window shows that panel maximized over the terminal and keeps the
  // file in its address. A path that cannot be one, or one the server does
  // not open, gets one short notice, never the server's reason or the path.
  const [focusFile, setFocusFile] = useState<FocusFile | null>(null)
  const openLinkFile = (link: DeepLink, paneId: string) => {
    if (focus) setFocusFile(null)
    if (link.badFile) {
      showToast('File not found or not allowed', 'warning')
      return
    }
    if (!link.file || !link.view) return
    if (focus) {
      setFocusFile({
        view: link.view,
        file: link.file,
        ...(link.staged && { staged: link.staged }),
        ...(link.orig && { orig: link.orig }),
        ...(link.place && { place: link.place }),
      })
      setPanelMaximized(true)
    }
    if (link.view === CHANGES_VIEW_ID) {
      void openChangeFromLink(paneId, {
        path: link.file,
        orig: link.orig,
        staged: !!link.staged,
      }).then((shown) => {
        if (shown === false) showToast('No changes for this file', 'warning')
      })
      return
    }
    // A view-only client never opens a Place
    void followInFiles(
      paneId,
      { path: link.file },
      readOnly ? undefined : link.place,
    ).then((result) => {
      if (result === 'missing' || result === 'failed')
        showToast('File not found or not allowed', 'warning')
    })
  }

  // Deep link: opened once the first snapshot is in, and again on each
  // hashchange. It only selects a tab, pane and view.
  const pendingLinkRef = useRef(parseDeepLink(window.location.hash))
  const [linkRequest, setLinkRequest] = useState(0)
  // The agent overview covers the panes while its address (#/overview) is
  // on: a reload keeps it, Back and Forward go between it and a pane.
  const [overviewOpen, setOverviewOpen] = useState(
    () => parseScreenLink(window.location.hash) === 'overview',
  )
  useEffect(() => {
    const onHashChange = () => {
      const overview = parseScreenLink(window.location.hash) === 'overview'
      setOverviewOpen(overview)
      if (overview) return
      pendingLinkRef.current = parseDeepLink(window.location.hash)
      setLinkRequest((n) => n + 1)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  const sessionsLoaded = isReady && isServerReachable && sessions.length > 0
  // The address of the pane on screen when a link was opened: what is shown
  // only changes in the next render, so until then the address keeps the
  // link (a reload meanwhile would open the old pane). A pick that showed
  // nothing new (refused, view only, or the tab already on screen) writes
  // the pane on screen back, unless another link took the address since.
  const linkLeftRef = useRef<string | null>(null)
  const settledHashRef = useRef<string | null>(null)
  const [linkSettled, setLinkSettled] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: linkRequest re-runs it for a new link
  useEffect(() => {
    const link = pendingLinkRef.current
    if (!link || !sessionsLoaded) return
    pendingLinkRef.current = null
    const target = sessions.find(
      (s) => s.id === link.tab && s.groupId === link.group,
    )
    if (!target) {
      showToast('Session in link not found', 'warning')
      return
    }
    // A pane that is gone still opens its tab, with the tab's own pane.
    if (link.pane && !target.panes?.some((p) => p.id === link.pane)) {
      showToast('Pane in link not found', 'warning')
    }
    const left = currentLinkRef.current
    const hash = window.location.hash
    linkLeftRef.current = left
    void selectSession(target.id, link.pane).then((shown) => {
      linkLeftRef.current = null
      if (shown && currentLinkRef.current !== left) return
      settledHashRef.current = hash
      setLinkSettled((n) => n + 1)
    })
    const paneId =
      link.pane && target.panes?.some((p) => p.id === link.pane)
        ? link.pane
        : (target.paneId ?? target.id)
    if (link.view) {
      // Kept for the pane too: switching to it restores its saved view.
      savePaneView(paneId, {
        view: link.view,
        panel: loadPaneView(paneId)?.panel ?? null,
      })
      // A focus window keeps none: the pane takes it from here once shown
      if (focus) linkViewRef.current = { paneId, view: link.view }
      // Another pane picks it up from there once selected; setting it now
      // would save it for the pane being left.
      if (paneId === viewPaneRef.current) setViewId(link.view)
    }
    openLinkFile(link, paneId)
  }, [linkRequest, sessionsLoaded, sessions, selectSession, showToast])

  // The address bar follows what is on screen, without adding history
  // entries, so copying it gives a link to this very pane.
  // On desktop the Files and Changes views show in the side panel: a focus
  // window's file names the panel's view, while that panel shows.
  const linkView =
    focus && focusFile && sidePanelId === focusFile.view
      ? focusFile.view
      : currentView.id
  const currentLink = activeSession.groupId
    ? formatDeepLink({
        group: activeSession.groupId,
        tab: activeSession.id,
        pane: mux.caps.clientSideSelect ? activeSession.paneId : undefined,
        view: linkView,
        ...(focus && { solo: true as const }),
        ...(focus &&
          focusFile &&
          linkView === focusFile.view && {
            file: focusFile.file,
            staged: focusFile.staged,
            orig: focusFile.orig,
            place: focusFile.place,
          }),
      })
    : null
  const currentLinkRef = useRef(currentLink)
  currentLinkRef.current = currentLink
  // Not while a viewer's history entry is on top: Back would land on an
  // entry of another link and its hashchange would open the old pane. Done
  // once that entry is gone instead.
  const [viewerGone, setViewerGone] = useState(0)
  useEffect(() => {
    // A reload while a viewer was open left its mark on this entry; Forward
    // can land on the entry of a viewer closed since
    dropStaleViewerEntry()
    window.addEventListener('popstate', dropStaleViewerEntry)
    const off = onViewerEntryGone(() => setViewerGone((n) => n + 1))
    return () => {
      window.removeEventListener('popstate', dropStaleViewerEntry)
      off()
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewerGone and linkSettled re-run it once a viewer's entry is gone or a link's pick showed nothing new
  useEffect(() => {
    if (!sessionsLoaded || !currentLink || pendingLinkRef.current) return
    // The overview's address stays while it shows.
    if (overviewOpen) return
    if (currentLink === linkLeftRef.current) return
    linkLeftRef.current = null
    const settledHash = settledHashRef.current
    settledHashRef.current = null
    if (settledHash !== null && window.location.hash !== settledHash) return
    if (viewerOnTop()) return
    if (window.location.hash !== currentLink) {
      window.history.replaceState(window.history.state, '', currentLink)
    }
  }, [sessionsLoaded, currentLink, viewerGone, linkSettled, overviewOpen])

  // Built from what is on screen, not read from the address bar, which may
  // still hold a link that did not open.
  const shownLink = overviewOpen
    ? formatOverviewLink({ solo: focus })
    : currentLink
  // What is on screen, in a window of its own: offered on a desktop, where
  // a link names it, and not in a focus window (it has Open in main window)
  const shownSoloLink = overviewOpen
    ? formatOverviewLink({ solo: true })
    : soloLink(activeSession, activeSession.paneId, { view: currentView.id })
  const openShownWindow = useMemo(
    () =>
      desktop && !focus && shownSoloLink
        ? (e?: OpenWindowEvent) => openLinkWindow(shownSoloLink, !!e?.shiftKey)
        : undefined,
    [desktop, focus, shownSoloLink, openLinkWindow],
  )
  // A tab or pane picked in the palette with Mod+Enter
  const openPickWindow = useCallback(
    ({ tabId, paneId }: { tabId: string; paneId?: string }) => {
      const session = sessions.find((s) => s.id === tabId)
      const hash = session && soloLink(session, paneId)
      if (hash) openLinkWindow(hash, false)
    },
    [sessions, soloLink, openLinkWindow],
  )
  const copyLink = useCallback(async () => {
    const { origin, pathname, search } = window.location
    try {
      await navigator.clipboard.writeText(
        `${origin}${pathname}${search}${shownLink}`,
      )
      showToast('Link copied', 'success')
    } catch {
      showToast('Could not copy the link', 'danger')
    }
  }, [shownLink, showToast])
  // A focus window is named for its file, or its tab, among the others
  const focusTitle = focus
    ? overviewOpen
      ? 'Overview'
      : focusFile && linkView === focusFile.view
        ? focusFile.file.slice(focusFile.file.lastIndexOf('/') + 1)
        : activeSession.name
    : null
  useEffect(() => {
    if (!focusTitle) return
    const before = document.title
    document.title = `${focusTitle} — Termote`
    return () => {
      document.title = before
    }
  }, [focusTitle])
  // A focus window hands its target (its file too) to the window that opened
  // it, or a new one when that is gone, without solo, then closes.
  const openInMain = useCallback(() => {
    const url = mainWindowURL(shownLink)
    const main = openerWindow()
    if (main) {
      main.location.href = url
      main.focus()
    } else if (!window.open(url, '_blank')) {
      showToast('Pop-up blocked', 'warning')
      return
    }
    window.close()
  }, [shownLink, showToast])

  // Opening and closing go through the address, so each is a history entry.
  // The usage chip opens it on its pane's card.
  const [overviewFocus, setOverviewFocus] = useState<{ paneId: string }>()
  // Closed, it forgets the card: Back to it again opens on the title.
  const [focusWhileOpen, setFocusWhileOpen] = useState(overviewOpen)
  if (focusWhileOpen !== overviewOpen) {
    setFocusWhileOpen(overviewOpen)
    if (!overviewOpen) setOverviewFocus(undefined)
  }
  const openOverview = useCallback(() => {
    setOverviewFocus(undefined)
    showOverviewAddress()
  }, [])
  const openOverviewOn = useCallback((paneId: string) => {
    setOverviewFocus({ paneId })
    showOverviewAddress()
  }, [])
  const closeOverview = useCallback(() => {
    if (currentLink) {
      window.location.hash = currentLink
      return
    }
    // No link names the pane: the address drops the overview's
    setOverviewOpen(false)
    const { pathname, search } = window.location
    window.history.replaceState(window.history.state, '', pathname + search)
  }, [currentLink])
  // Leaves the overview for the pane on screen in place (its entry becomes
  // the pane's), without a hashchange that would restore the view saved in
  // the address.
  const leaveOverview = useCallback(() => setOverviewOpen(false), [])
  // A card opens its pane, on the Chat view or the terminal, as a link does.
  const openFromOverview = useCallback(
    (session: Session, pane: SessionPane, view: 'chat' | 'terminal') => {
      if (!session.groupId) {
        // No link names it: picked in place
        setOverviewOpen(false)
        setViewId(view)
        void selectSession(session.id, pane.id)
        return
      }
      window.location.hash = formatDeepLink({
        group: session.groupId,
        tab: session.id,
        pane: pane.id,
        view,
        ...(focus && { solo: true as const }),
      })
    },
    [selectSession, focus],
  )
  const overviewOpensChat = useCallback(
    (pane: SessionPane) => !!mux.caps.agentChat && chatAgent(pane.agentName),
    [mux.caps.agentChat],
  )
  const overviewCanAnswer = useCallback(
    (pane: SessionPane) =>
      !!mux.caps.agentChat && chatInputAgent(pane.agentName),
    [mux.caps.agentChat],
  )
  const chatOffered = switcherViews.some((v) => v.id === CHAT_VIEW_ID)
  const startFromOverview = useCallback(() => {
    leaveOverview()
    setViewId(CHAT_VIEW_ID)
  }, [leaveOverview])
  // A view or side panel picked in the header shows at once.
  const changeView = useCallback(
    (id: string) => {
      leaveOverview()
      setViewId(id)
    },
    [leaveOverview],
  )
  const togglePanel = useCallback(
    (id: string | null) => {
      leaveOverview()
      setSidePanelId(id)
    },
    [leaveOverview],
  )
  // Esc leaves the overview, unless a dialog or menu takes it.
  useEffect(() => {
    if (!overviewOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as Element | null
      if (t?.closest?.('dialog,[role="dialog"],[role="menu"],[role="listbox"]'))
        return
      closeOverview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overviewOpen, closeOverview])
  // Picking a session anywhere leaves the overview for it.
  const selectFromList = useCallback(
    (id: string) => {
      setOverviewOpen(false)
      return selectSession(id)
    },
    [selectSession],
  )

  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null)
  const groupTabs = sessions.filter((s) => s.groupId === activeSession.groupId)
  const tabIndex = groupTabs.findIndex((s) => s.id === activeSession.id)
  const previousTab = groupTabs[tabIndex - 1]?.id
  const nextTab = tabIndex < 0 ? undefined : groupTabs[tabIndex + 1]?.id
  const filesPanelOpen = sidePanelId === FILES_VIEW_ID
  const searchPaneId = activeSession.paneId
  // The pane's agent has a Chat message box this device can type in
  const composerOffered =
    !readOnly &&
    !!activeSession.hasAgent &&
    chatInputAgent(activeSession.agentName) &&
    switcherViews.some((v) => v.id === CHAT_VIEW_ID)
  const commands = useMemo(
    () =>
      buildAppCommands({
        apple: isApplePlatform(),
        readOnly,
        focus,
        viewIds: switcherViews.map((v) => v.id),
        panelIds: searchPaneId ? panelViews.map((v) => v.id) : [],
        sidePanelId: sidePanelView ? sidePanelId : null,
        startOffered: startOffered(viewContext),
        hasAgent: !!activeSession.hasAgent,
        devices: !!mux.caps.devices && !readOnly,
        canFullscreen,
        previousTab,
        nextTab,
        paneLayout: !!mux.caps.paneLayout,
        canSwapNext,
        desktop: !isMobile,
        splitPane: (d) => runPaneAction(() => splitPane(d)),
        zoomPane: () => runPaneAction(zoomPane),
        swapNextPane: () => runPaneAction(() => swapPane('next')),
        resizePane: (d) => runPaneAction(() => resizePane(d, RESIZE_STEP)),
        openPalette: setPaletteMode,
        changeView,
        showTerminal: () => {
          changeView(TERMINAL_VIEW_ID)
          focusTerminal(getTerminal())
        },
        showChat: () => {
          changeView(CHAT_VIEW_ID)
          if (composerOffered) requestDraftInsert(searchPaneId as string)
        },
        togglePanel,
        openOverview,
        searchContent: () => {
          if (!filesPanelOpen) togglePanel(FILES_VIEW_ID)
          // Offered only with a pane (panelIds is empty without one)
          requestFilesFocus(searchPaneId as string, 'search')
        },
        newTab: () => void addTab('New'),
        selectTab: (id) => void selectFromList(id),
        openSettings,
        openHelp: () => setHelpOpen(true),
        openAbout: () => setAboutOpen(true),
        toggleSidebar: toggleSidebarCollapsed,
        toggleFullscreen,
        openWindow: openShownWindow,
        fontIncrease: increase,
        fontDecrease: decrease,
        setTheme,
      }),
    [
      readOnly,
      focus,
      switcherViews,
      panelViews,
      searchPaneId,
      sidePanelView,
      sidePanelId,
      viewContext,
      activeSession.hasAgent,
      mux.caps.devices,
      canFullscreen,
      previousTab,
      nextTab,
      mux.caps.paneLayout,
      canSwapNext,
      isMobile,
      runPaneAction,
      splitPane,
      zoomPane,
      swapPane,
      resizePane,
      changeView,
      getTerminal,
      composerOffered,
      togglePanel,
      openOverview,
      filesPanelOpen,
      addTab,
      selectFromList,
      toggleSidebarCollapsed,
      toggleFullscreen,
      openShownWindow,
      increase,
      decrease,
      setTheme,
      openSettings,
    ],
  )
  useShortcutDispatcher(commands, desktop)
  const keymap = useKeymap(commands)
  const paletteKey = keymap.byId['palette.commands']?.key
  // Run once the palette is gone: the focus a command moves is not taken
  // back by the closing dialog
  const afterPalette = useRef<(() => void) | null>(null)
  const runFromPalette = useCallback((fn: () => void) => {
    afterPalette.current = fn
    setPaletteMode(null)
  }, [])
  const closePalette = useCallback(() => setPaletteMode(null), [])
  useEffect(() => {
    if (paletteMode) return
    const fn = afterPalette.current
    afterPalette.current = null
    fn?.()
  }, [paletteMode])
  // Its chunk is fetched while the desktop is idle, so the first open has
  // no wait during which keys would still go to the terminal
  useEffect(() => {
    if (!desktop) return
    // A failure is shown when the palette opens, not here
    const preload = () => void Promise.allSettled([loadCommandPalette()])
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(preload)
      return () => window.cancelIdleCallback(id)
    }
    const timer = setTimeout(preload, PALETTE_PRELOAD_MS)
    return () => clearTimeout(timer)
  }, [desktop])
  const showFilesPanel = useCallback(() => {
    if (!filesPanelOpen) togglePanel(FILES_VIEW_ID)
  }, [filesPanelOpen, togglePanel])

  return (
    <div
      // A size container: the history list caps its height at a share of
      // the app's (cqh), which follows the keyboard, unlike vh
      className="flex flex-col overflow-hidden bg-bg font-ui text-fg [container-type:size]"
      // With the keyboard open the app takes the visible height itself:
      // iOS can shrink 100dvh before innerHeight, and subtracting the
      // keyboard from an already shrunk 100dvh left the app near 0px tall.
      // It also follows the visible part down when iOS pans it to a focused
      // field (the history search), or the header went off the top and a
      // blank band sat between the toolbar and the keyboard.
      style={{
        height:
          keyboardHeight > 0 ? `${viewportHeight}px` : 'var(--app-height)',
        transform:
          viewportOffsetTop > 0
            ? `translateY(${viewportOffsetTop}px)`
            : undefined,
      }}
    >
      <div className="flex flex-1 min-h-0">
        {/* Desktop sidebar; a focus window has none */}
        {!isMobile && !focus && (
          <SessionSidebar
            sessions={sessions}
            groups={groups}
            activeId={activeSession.id}
            onSelect={selectFromList}
            onAdd={readOnly ? undefined : addTab}
            onRemove={readOnly ? undefined : requestRemove}
            onUpdate={readOnly ? undefined : updateSession}
            isCollapsed={sidebarCollapsed}
            onToggleCollapse={toggleSidebarCollapsed}
            overviewOpen={overviewOpen}
            onOpenOverview={openOverview}
            filter={settings.sidebarFilter}
            onFilterChange={(f) => updateSetting('sidebarFilter', f)}
            sortBlockedFirst={settings.sortBlockedFirst}
            groupActions={groupActions}
            reorder={reorder}
          />
        )}

        {/* Mobile sessions sheet, opened from the session chip */}
        {isMobile && !focus && (
          <SessionSidebar
            sessions={sessions}
            groups={groups}
            activeId={activeSession.id}
            onSelect={handleMobileSelect}
            onAdd={readOnly ? undefined : handleMobileAdd}
            onRemove={readOnly ? undefined : requestRemove}
            onUpdate={readOnly ? undefined : updateSession}
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            isMobile
            filter={settings.sidebarFilter}
            onFilterChange={(f) => updateSetting('sidebarFilter', f)}
            sortBlockedFirst={settings.sortBlockedFirst}
            groupActions={groupActions}
            reorder={reorder}
          />
        )}

        <main className="flex-1 flex flex-col min-w-0">
          <AppHeader
            isMobile={isMobile}
            session={activeSession}
            groupSessions={groupSessions}
            groupName={groupName}
            blockedElsewhere={blockedElsewhere}
            showBrand={focus || sidebarCollapsed}
            showSessionTabs={!focus && settings.showSessionTabs}
            canRemoveTab={!readOnly && sessions.length > 1}
            onSelectTab={selectFromList}
            onAddTab={readOnly || focus ? undefined : () => addTab('New')}
            onRemoveTab={requestRemove}
            connectionState={connectionState}
            onRetry={() => terminalRef.current?.reconnect()}
            sessionsOpen={sidebarOpen}
            onOpenSessions={() => setSidebarOpen(true)}
            fontSize={fontSize}
            // The font size only applies to the terminal
            showFontSize={isTerminalView}
            onDecreaseFont={decrease}
            onIncreaseFont={increase}
            isFullscreen={isFullscreen}
            onToggleFullscreen={canFullscreen ? toggleFullscreen : undefined}
            views={switcherViews}
            viewId={currentView.id}
            onViewChange={changeView}
            onOpenOverview={focus ? undefined : openOverview}
            onOpenInMain={focus ? openInMain : undefined}
            paneMenu={
              paneLayoutOn &&
              !overviewOpen && (
                <PaneLayoutMenu
                  desktop={!isMobile}
                  canSwapNext={canSwapNext}
                  canClose={shownPanes.length > 1}
                  onSplit={(d) => runPaneAction(() => splitPane(d))}
                  onZoom={() => runPaneAction(zoomPane)}
                  onSwapNext={() => runPaneAction(() => swapPane('next'))}
                  onResize={(d) =>
                    runPaneAction(() => resizePane(d, RESIZE_STEP))
                  }
                  // Offered with two panes or more, one of them shown
                  onClose={() =>
                    setPendingPaneId(activeSession.paneId as string)
                  }
                />
              )
            }
            usageChip={
              <HeaderUsageChip
                paneId={activeSession.paneId}
                hasAgent={activeSession.hasAgent}
                enabled={settings.showUsageChip}
                pollInterval={settings.pollInterval * 1000}
                isMobile={isMobile}
                onOpen={openOverviewOn}
              />
            }
            viewPanelId={viewPanelId}
            panelViews={panelViews}
            sidePanelId={sidePanelView ? sidePanelId : null}
            onTogglePanel={togglePanel}
            onOpenPalette={
              desktop ? () => setPaletteMode('commands') : undefined
            }
            paletteKey={
              paletteKey && formatChord(paletteKey, isApplePlatform())
            }
            menu={{
              onOpenAbout: () => setAboutOpen(true),
              onOpenHelp: () => setHelpOpen(true),
              onOpenSettings: () => {
                setSettingsGroup(undefined)
                setSettingsOpen(true)
              },
              onCopyLink: shownLink ? copyLink : undefined,
              onOpenWindow: openShownWindow,
              onLogout: mux.caps.auth ? handleLogout : undefined,
              updateVersion: notifyUpdate ? updateVersion : null,
              onOpenUpdates: openUpdates,
            }}
          />
          {/* Mounted before the banner, so the news is announced */}
          <div role="status" className="shrink-0">
            {appUpdate.stale && (
              <Banner
                live={false}
                action={
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={appUpdate.reloading}
                    onClick={() => reloadToNewVersion()}
                  >
                    {appUpdate.reloading ? 'Reloading…' : 'Reload'}
                  </Button>
                }
              >
                {appUpdate.server &&
                appUpdate.server.version !== APP_INFO.version
                  ? `Termote v${appUpdate.server.version} is ready`
                  : 'A new version is ready'}
              </Banner>
            )}
          </div>
          {!settings.hasSeenLocalhostNotice && (
            <LocalhostNotice
              onDismiss={() => updateSetting('hasSeenLocalhostNotice', true)}
            />
          )}
          {readOnly &&
            (viewStreamOff ? (
              <Banner variant="warning">
                View only is not available with this tmux: the terminal needs
                tmux 3.2 or later on the server
              </Banner>
            ) : (
              <Banner>
                View only: you can watch this terminal but not type
              </Banner>
            ))}
          {/* Split tab: pick the pane to stream (Herdr, Zellij) or to focus
              (tmux, where picking is a write: a view-only device watches) */}
          {activeSession.panes && !overviewOpen && !focus && (
            <PaneStrip
              panes={activeSession.panes}
              activePaneId={activeSession.paneId}
              onSelect={
                mux.caps.clientSideSelect || !readOnly ? selectPane : undefined
              }
              onClose={readOnly ? undefined : setPendingPaneId}
            />
          )}
          {/* isolate: the maximized side panel stays under the header's menus */}
          <div className="relative isolate flex min-h-0 flex-1">
            {/* The view's column: the input area sits under the view only, so
                the sidebar and the side panel run the full height. */}
            <div className="flex min-w-0 flex-1 flex-col">
              {/* The terminal fits the space left above the toolbar, so an open
                  keyboard shrinks it rather than hiding its bottom rows. */}
              <div
                // Under the maximized side panel or the overview nothing here
                // takes focus
                inert={overviewOpen || (hasSidePanel && panelMaximized)}
                className="relative min-h-0 flex-1 bg-term"
              >
                {/* Another view covers the terminal instead of unmounting or
                    hiding it: it keeps its stream and its size (a display:none
                    terminal would resize the tmux window to nothing). */}
                <div
                  id={viewPanelId(TERMINAL_VIEW_ID)}
                  role={panelRole}
                  // inert: a covered terminal must not keep keyboard focus
                  inert={!isTerminalView}
                  className={`relative h-full ${isTerminalView ? '' : 'invisible'}`}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  <div className="h-full">
                    <TerminalView
                      ref={terminalRef}
                      // No stream at all where the server would refuse it, nor
                      // while a focus window's file covers the terminal
                      paneId={
                        viewStreamOff || streamOff
                          ? undefined
                          : activeSession.paneId
                      }
                      backend={mux.backend}
                      followPane={mux.caps.clientSideSelect}
                      // tmux attaches a whole session: another session needs
                      // another stream.
                      streamKey={
                        mux.caps.clientSideSelect
                          ? undefined
                          : activeSession.groupId
                      }
                      paneSeen={
                        mux.caps.clientSideSelect ? undefined : paneSeen
                      }
                      copyModeSupported={copyModeSupported}
                      // A view-only device never moves the backend's view of
                      // the pane (Herdr scrolls it for every client)
                      serverScroll={!!mux.caps.scroll && !readOnly}
                      bracketedPaste={
                        (isHerdr || isZellij) && !!activeSession.hasAgent
                      }
                      fontSize={fontSize}
                      fontFamily={settings.terminalFont}
                      theme={resolvedTheme}
                      uiStyle={settings.uiStyle}
                      disableContextMenu={settings.disableContextMenu}
                      copyOnSelect={settings.copyOnSelect}
                      onCopy={onTerminalCopy}
                      readOnly={readOnly}
                      // Only while the terminal shows: under another view the
                      // pane keeps the desktop's size, so a Claude Code dialog
                      // taller than this device's screen is not cut by
                      // Claude Code and the Chat view can still read it.
                      driveSize={
                        settings.driveTerminalSize &&
                        !!mux.caps.driveSize &&
                        !readOnly &&
                        isTerminalView
                      }
                      onDriveLost={onDriveLost}
                      // Also while the side panel is dragged (fitted once on
                      // release) or covers it maximized (no resize at all)
                      covered={!isTerminalView || holdTerminalSize}
                      onConnectionStateChange={setStreamState}
                      onPasteImage={uploadsOn ? attachImage : undefined}
                    />
                  </div>
                  {/* Gesture overlay - captures touch gestures (mobile only) */}
                  {isMobile && (
                    <div
                      ref={gestureRef}
                      className="absolute inset-0 touch-none"
                    />
                  )}
                </div>
                {!isTerminalView && currentView.Main && (
                  <div
                    id={viewPanelId(currentView.id)}
                    role={panelRole}
                    className="absolute inset-0 overflow-auto bg-bg"
                  >
                    <ViewSlot
                      key={currentView.id}
                      View={currentView.Main}
                      props={viewProps}
                    />
                  </div>
                )}
              </div>
              {/* The maximized side panel covers the input area too */}
              <div inert={hasSidePanel && panelMaximized} className="shrink-0">
                {/* The bottom input area belongs to the view: the key
                    toolbar for the terminal. View-only has no input at all. */}
                {overviewOpen ? null : readOnly ? (
                  <ReadOnlyBar
                    label="View only"
                    action={
                      isTerminalView && (
                        <Button size="sm" onClick={openSelectText}>
                          Select text
                        </Button>
                      )
                    }
                  />
                ) : isTerminalView ? (
                  <div className="relative">
                    {historyOpen && (
                      <CommandHistoryDropdown
                        history={history}
                        onSelect={handleHistorySelect}
                        onRemove={removeCommand}
                        onClear={clearHistory}
                        onClose={() => setHistoryOpen(false)}
                      />
                    )}
                    <KeyboardToolbar
                      onKey={handleKey}
                      onCtrlKey={handleCtrlKey}
                      onShiftKey={handleShiftKey}
                      onCtrlShiftKey={handleCtrlShiftKey}
                      onScroll={handleScroll}
                      onTmuxCopy={handleTmuxCopy}
                      showTmuxCopy={copyModeSupported}
                      onSelectText={openSelectText}
                      onPaste={handlePaste}
                      onAttachImage={uploadsOn ? handleAttachImage : undefined}
                      onToggleKeyboard={toggleKeyboard}
                      onSendText={handleSendText}
                      ctrlActive={ctrlActive}
                      onCtrlChange={setCtrlActive}
                      imeMode={imeMode}
                      onImeModeChange={setImeMode}
                      defaultExpanded={settings.toolbarDefaultExpanded}
                      onHistoryToggle={() => setHistoryOpen((prev) => !prev)}
                      historyOpen={historyOpen}
                      keyboardVisible={keyboardVisible}
                      quickActions={isMobile ? quickActions : undefined}
                    />
                  </div>
                ) : (
                  // Keyed by pane: a send still in flight never lands on another
                  // pane's draft.
                  currentView.Input && (
                    <currentView.Input
                      key={activeSession.paneId}
                      {...viewProps}
                    />
                  )
                )}
              </div>
            </div>
            {sidePanelView?.Panel && (
              <SidePanel
                inert={overviewOpen}
                label={sidePanelView.label}
                width={settings.sidePanelWidth}
                onWidthChange={setSidePanelWidth}
                maximized={panelMaximized}
                onMaximizedChange={setPanelMaximized}
                onResizingChange={setPanelResizing}
              >
                {/* Its own boundary: a lazy panel that suspends must not
                    blank the whole app while it loads */}
                <ViewSlot
                  key={sidePanelView.id}
                  View={sidePanelView.Panel}
                  props={viewProps}
                />
              </SidePanel>
            )}
            {/* Covers the panes without unmounting them, as a view covers
                the terminal */}
            {overviewOpen && (
              <div className="absolute inset-0 z-20">
                <OverviewScreen
                  sessions={sessions}
                  groups={groups}
                  groupNoun={groupNoun}
                  ready={sessionsLoaded}
                  pollInterval={settings.pollInterval * 1000}
                  clockOffset={clockOffset}
                  // psmux reports itself as tmux
                  activePaneOnly={mux.backend === 'tmux'}
                  opensChat={overviewOpensChat}
                  canAnswer={overviewCanAnswer}
                  readOnly={readOnly}
                  stuckMinutes={settings.stuckMinutes}
                  onOpen={openFromOverview}
                  onClose={closeOverview}
                  onStartAgent={
                    !readOnly && chatOffered ? startFromOverview : undefined
                  }
                  focusPane={overviewFocus}
                />
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Hidden input for Ctrl+key capture - programmatically focused only */}
      {!readOnly && (
        <input
          ref={ctrlInputRef}
          type="text"
          className="sr-only"
          tabIndex={-1}
          autoComplete="off"
          onChange={handleCtrlInput}
          onBlur={() => setCtrlActive(false)}
        />
      )}

      {/* Modals */}
      <ConfirmDialog
        isOpen={!!pendingRemove}
        title="Close session?"
        confirmLabel="Close session"
        destructive
        onConfirm={confirmRemove}
        onCancel={cancelRemove}
      >
        <p className="m-0">
          <span className="font-medium text-fg">
            {visibleUnsafe(pendingRemove?.name ?? '')}
          </span>{' '}
          will be closed, along with anything still running in it.
        </p>
        <RunningLine names={pendingRemove?.commands ?? []} />
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={!!pendingGroupClose}
        title={`Close ${groupNoun}?`}
        confirmLabel={`Close ${groupNoun}`}
        destructive
        onConfirm={confirmGroupClose}
        onCancel={() => setPendingGroupCloseId(null)}
      >
        <p className="m-0">
          Close {groupNoun}{' '}
          <span className="font-medium text-fg">
            "{visibleUnsafe(pendingGroupClose?.name ?? '')}"
          </span>
          ? Its {pendingGroupTabs} {pendingGroupTabs === 1 ? 'tab' : 'tabs'} and
          everything running in them will end.
          {pendingGroupClose && isZellij && (
            <> The session is deleted: Zellij cannot resurrect it.</>
          )}
          {pendingGroupClose && isDefaultGroup(pendingGroupClose.id) && (
            <>
              {' '}
              Termote starts a new, empty "
              {visibleUnsafe(pendingGroupClose.name)}" right away, and every
              device viewing it is disconnected.
            </>
          )}
        </p>
        <RunningLine
          names={uniqueNames(
            pendingGroupSessions.flatMap((s) => s.commands ?? []),
          )}
        />
      </ConfirmDialog>
      {newGroupOpen && (
        <GroupDialog
          noun={groupNoun}
          onClose={() => setNewGroupOpen(false)}
          onCreate={async (name, cwd, isOpen) => {
            await createGroup(name, cwd, isOpen)
            // As a new session does: the sheet closes on what was made
            if (isMobile && isOpen()) setSidebarOpen(false)
          }}
        />
      )}
      {worktreeDialog && (
        <WorktreeDialog
          mode={worktreeDialog.mode}
          groupId={worktreeDialog.groupId}
          onClose={() => setWorktreeDialog(null)}
          onCreate={async (w, isOpen) => {
            await createWorktree(w, isOpen)
            if (isMobile && isOpen()) setSidebarOpen(false)
          }}
          onOpen={async (branch, isOpen) => {
            await openWorktree(worktreeDialog.groupId, branch, isOpen)
            if (isMobile && isOpen()) setSidebarOpen(false)
          }}
          onShow={(id) => {
            showGroup(id)
            if (isMobile) setSidebarOpen(false)
          }}
        />
      )}
      {worktreeRemove && (
        <WorktreeRemoveDialog
          groupId={worktreeRemove.groupId}
          force={worktreeRemove.force}
          onConfirm={(w) => confirmWorktreeRemove(worktreeRemove.groupId, w)}
          onCancel={() => setWorktreeRemove(null)}
        >
          <RunningLine
            names={uniqueNames(
              sessions
                .filter((s) => s.groupId === worktreeRemove.groupId)
                .flatMap((s) => s.commands ?? []),
            )}
          />
        </WorktreeRemoveDialog>
      )}
      <ConfirmDialog
        isOpen={!!pendingPane}
        title="Close pane?"
        confirmLabel="Close pane"
        destructive
        onConfirm={confirmPaneClose}
        onCancel={cancelPaneClose}
      >
        <p className="m-0">
          <span className="font-medium text-fg">
            {visibleUnsafe(pendingPane?.label ?? '')}
          </span>{' '}
          will be closed, along with anything still running in it. The other
          panes of this session stay open.
        </p>
        <RunningLine
          names={pendingPane?.command ? [pendingPane.command] : []}
        />
      </ConfirmDialog>
      <AboutModal
        isOpen={aboutOpen}
        onClose={() => setAboutOpen(false)}
        onCheckUpdates={openUpdates}
        updateVersion={updateVersion}
      />
      <HelpModal
        isOpen={helpOpen}
        onClose={() => setHelpOpen(false)}
        copyModeSupported={copyModeSupported}
      />
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialGroup={settingsGroup}
        settings={settings}
        onUpdateSetting={updateSetting}
        tmuxBufferSupported={copyModeSupported}
        pasteBufferLabel={
          mux.backend === 'tmux' ? 'tmux buffer' : 'Session buffer'
        }
        driveSizeSupported={!!mux.caps.driveSize && !readOnly}
        pushAvailable={!!mux.caps.push}
        readOnly={readOnly}
        devices={!!mux.caps.devices && !readOnly}
        signins={!!mux.caps.signins && !readOnly}
        templates={!!mux.caps.templates}
        tasks={!!mux.caps.tasks}
        userTasks={!!mux.caps.userTasks}
        shortcuts={desktop ? commands : undefined}
        onLogout={handleLogout}
        onEnableNotify={push.enable}
        onDisableNotify={push.disable}
        onShowGestureHints={isMobile ? showGestureHints : undefined}
        updates={{
          server: appUpdate.server,
          stale: appUpdate.stale,
          reloading: appUpdate.reloading,
          onReload: () => reloadToNewVersion(),
        }}
        onClearHistory={clearHistory}
        historyCount={history.length}
      />
      {desktop && paletteMode && (
        <LazyBoundary
          onRetry={CommandPalette.retry}
          // Nothing out of place: a toast says so, and the next open tries
          // the chunk again
          fallback={() => null}
          onError={() => {
            showToast('Could not load the command palette', 'danger')
            setPaletteMode(null)
          }}
        >
          <Suspense fallback={null}>
            <CommandPalette
              mode={paletteMode}
              onClose={closePalette}
              onRun={runFromPalette}
              commands={commands}
              session={activeSession}
              sessions={sessions}
              groups={groups}
              readOnly={readOnly}
              filesAvailable={
                !!activeSession.paneId &&
                panelViews.some((v) => v.id === FILES_VIEW_ID)
              }
              showFilesPanel={showFilesPanel}
              composer={composerOffered}
              templates={!!mux.caps.templates}
              showChat={() => changeView(CHAT_VIEW_ID)}
              sendToTerminal={(text) => {
                changeView(TERMINAL_VIEW_ID)
                sendTextToTerminal(getTerminal(), text)
                focusTerminal(getTerminal())
              }}
              selectSession={(id) => void selectFromList(id)}
              selectPane={
                mux.caps.clientSideSelect || !readOnly ? selectPane : undefined
              }
              openInWindow={focus ? undefined : openPickWindow}
              sessionsOff={focus ? 'Not in a focus window' : undefined}
            />
          </Suspense>
        </LazyBoundary>
      )}
      {isMobile && (
        <GestureHintsOverlay
          isOpen={gestureHintsOpen}
          onDismiss={dismissGestureHints}
        />
      )}
      {mux.caps.templates && (
        <TemplateFillDialog
          pane={(paneId) => {
            const s = sessions.find((x) => x.paneId === paneId)
            if (!s) return null
            const g = groups.find((x) => x.id === s.groupId)
            return { agent: s.agentName, branch: g?.worktree?.branch }
          }}
          terminalText={(paneId) =>
            paneId === activeSession.paneId
              ? terminalSelection(getTerminal())
              : ''
          }
          notify={notify}
        />
      )}
      {selectTextOpen && (
        <SelectTextSheet
          // Another pane is another text: read afresh
          key={activeSession.paneId}
          onClose={() => setSelectTextOpen(false)}
          paneId={activeSession.paneId}
          // A view-only device sees the screen only, never the history
          useServer={!!mux.caps.paneText && !readOnly}
          readBuffer={readBufferText}
          onCopied={onTerminalCopy}
        />
      )}
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          variant={toast.variant}
          action={toast.action}
          duration={
            toast.duration ?? (toast.action ? ACTION_TOAST_MS : undefined)
          }
          onClose={() => setToast(null)}
        />
      )}
    </div>
  )
}

// The command palette's chunk, and how long after start it is fetched where
// the browser has no idle callback
const loadCommandPalette = () => import('./components/command-palette')
const PALETTE_PRELOAD_MS = 2000
const CommandPalette = lazyRetry<CommandPaletteProps>(
  loadCommandPalette,
  'CommandPalette',
)

// A lazy view: while its chunk loads or after it failed to, the rest of the
// app (the terminal, the header) stays usable. Another view takes the slot
// by its key, which leaves this one to import again on the next visit.
function ViewSlot({
  View,
  props,
}: {
  View: NonNullable<AppView['Main']>
  props: ViewProps
}) {
  return (
    <LazyBoundary
      onRetry={View.retry}
      fallback={(retry) => (
        <LoadFailed message="Could not load this view" retry={retry} />
      )}
    >
      <Suspense fallback={null}>
        <View {...props} />
      </Suspense>
    </LazyBoundary>
  )
}

// What a close confirmation will stop, as the last snapshot named it.
function RunningLine({ names }: { names: string[] }) {
  const text = formatRunning(names)
  return text ? <p className="m-0 mt-2">{text}</p> : null
}
