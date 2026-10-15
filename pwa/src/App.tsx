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
  CHAT_VIEW_ID,
  type NotifyOptions,
  TERMINAL_VIEW_ID,
  type ViewContext,
  viewPanelId,
} from './app-views'
import { chatAgent, chatInputAgent } from './chat-agents'
import { AboutModal } from './components/about-modal'
import { AppHeader } from './components/app-header'
import { CommandHistoryDropdown } from './components/command-history-dropdown'
import type { ConnectionState } from './components/connection-indicator'
import { GestureHintsOverlay } from './components/gesture-hints-overlay'
import { GroupDialog } from './components/group-dialog'
import { HelpModal } from './components/help-modal'
import { KeyboardToolbar } from './components/keyboard-toolbar'
import { OverviewScreen } from './components/overview-screen'
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
import { useFontSize } from './hooks/use-font-size'
import { useFullscreen } from './hooks/use-fullscreen'
import { useGestures } from './hooks/use-gestures'
import {
  dropStaleViewerEntry,
  onViewerEntryGone,
  viewerOnTop,
} from './hooks/use-history-close'
import { useKeyboardVisible } from './hooks/use-keyboard-visible'
import { useLocalSessions } from './hooks/use-local-sessions'
import { useIsMobile } from './hooks/use-media-query'
import {
  logout,
  onViewOnlyRefusal,
  RequestError,
  selectTab,
} from './hooks/use-mux-api'
import { usePushSubscription } from './hooks/use-push-subscription'
import { useSettings } from './hooks/use-settings'
import { useSidebarCollapsed } from './hooks/use-sidebar-collapsed'
import { useStartAgent } from './hooks/use-start-agent'
import type { Session, SessionPane } from './types/session'
import { applyUiStyle, syncThemeColor } from './ui-style'
import { APP_INFO } from './utils/app-info'
import {
  checkOnShow,
  checkServerVersion,
  reloadToNewVersion,
  useAppUpdate,
} from './utils/app-update'
import {
  formatDeepLink,
  OVERVIEW_HASH,
  parseDeepLink,
  parseScreenLink,
} from './utils/deep-link'
import { signOutPage } from './utils/files-persist'
import {
  LARGE_PACKET_HELP_URL,
  onLargePacketLoss,
} from './utils/large-packet-loss'
import { loadPaneView, savePaneView } from './utils/pane-view'
import { formatRunning, uniqueNames } from './utils/running-commands'
import { matchesFilter } from './utils/session-filter'
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
  toggleTmuxCopyMode,
} from './utils/terminal-bridge'
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
      setViewId(id)
    },
    [mux.caps.clientSideSelect, readOnly, activeSession.id],
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
  // A view's content in the desktop side panel, next to the terminal
  const [sidePanelId, setSidePanelId] = useState<string | null>(null)
  // Each pane comes back on the view (and side panel) it was left on; one
  // never shown opens on the terminal. Before paint, so the previous pane's
  // view never flashes on the new one.
  const viewPaneId = activeSession.paneId ?? activeSession.id
  const viewPaneRef = useRef(viewPaneId)
  useLayoutEffect(() => {
    if (viewPaneRef.current !== viewPaneId) {
      viewPaneRef.current = viewPaneId
      const saved = loadPaneView(viewPaneId)
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
  const viewProps = {
    ...viewContext,
    isMobile,
    notify,
    showView,
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
  const holdTerminalSize = hasSidePanel && (panelResizing || panelMaximized)
  const setSidePanelWidth = useCallback(
    (width: number) => updateSetting('sidePanelWidth', width),
    [updateSetting],
  )
  // tabpanel roles only mean something next to the desktop tabs; the mobile
  // header switches views from a menu
  const panelRole =
    !isMobile && switcherViews.length > 1 ? 'tabpanel' : undefined
  const { fontSize, increase, decrease } = useFontSize()
  const { resolvedTheme } = useTheme()
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

  // The indicator follows the stream; a failing session poll can only mark
  // it down, never up, so it does not show "connected" while the stream is
  // still backing off.
  const connectionState: ConnectionState = isServerReachable
    ? streamState
    : 'disconnected'

  // The server's version, read on start, whenever the terminal stream comes
  // back (an update restarts the server) and when the app is shown again:
  // another /api/mux version replaces this page at once, another release
  // offers the reload (the banner).
  const droppedRef = useRef(false)
  useEffect(() => {
    if (streamState === 'disconnected' || streamState === 'error') {
      droppedRef.current = true
    } else if (streamState === 'connected' && droppedRef.current) {
      droppedRef.current = false
      checkServerVersion()
    }
  }, [streamState])
  useEffect(() => {
    checkServerVersion()
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkOnShow()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

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
    if (link.view) {
      // Kept for the pane too: switching to it restores its saved view.
      const paneId =
        link.pane && target.panes?.some((p) => p.id === link.pane)
          ? link.pane
          : (target.paneId ?? target.id)
      savePaneView(paneId, {
        view: link.view,
        panel: loadPaneView(paneId)?.panel ?? null,
      })
      // Another pane picks it up from there once selected; setting it now
      // would save it for the pane being left.
      if (paneId === viewPaneRef.current) setViewId(link.view)
    }
  }, [linkRequest, sessionsLoaded, sessions, selectSession, showToast])

  // The address bar follows what is on screen, without adding history
  // entries, so copying it gives a link to this very pane.
  const currentLink = activeSession.groupId
    ? formatDeepLink({
        group: activeSession.groupId,
        tab: activeSession.id,
        pane: mux.caps.clientSideSelect ? activeSession.paneId : undefined,
        view: currentView.id,
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
  const shownLink = overviewOpen ? OVERVIEW_HASH : currentLink
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

  // Opening and closing go through the address, so each is a history entry.
  const openOverview = useCallback(() => {
    if (window.location.hash !== OVERVIEW_HASH) {
      window.location.hash = OVERVIEW_HASH
    }
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
        pane: mux.caps.clientSideSelect ? pane.id : undefined,
        view,
      })
    },
    [mux.caps.clientSideSelect, selectSession],
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
        {/* Desktop sidebar */}
        {!isMobile && (
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
        {isMobile && (
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
            showBrand={sidebarCollapsed}
            showSessionTabs={settings.showSessionTabs}
            canRemoveTab={!readOnly && sessions.length > 1}
            onSelectTab={selectFromList}
            onAddTab={readOnly ? undefined : () => addTab('New')}
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
            onOpenOverview={openOverview}
            usageChip={
              <HeaderUsageChip
                paneId={activeSession.paneId}
                hasAgent={activeSession.hasAgent}
                enabled={settings.showUsageChip}
                pollInterval={settings.pollInterval * 1000}
                isMobile={isMobile}
                onOpen={openOverview}
              />
            }
            viewPanelId={viewPanelId}
            panelViews={panelViews}
            sidePanelId={sidePanelView ? sidePanelId : null}
            onTogglePanel={togglePanel}
            menu={{
              onOpenAbout: () => setAboutOpen(true),
              onOpenHelp: () => setHelpOpen(true),
              onOpenSettings: () => {
                setSettingsGroup(undefined)
                setSettingsOpen(true)
              },
              onCopyLink: shownLink ? copyLink : undefined,
              onLogout: mux.caps.auth ? handleLogout : undefined,
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
          {/* Split tab: pick the pane to stream (herdr) */}
          {mux.caps.clientSideSelect &&
            activeSession.panes &&
            !overviewOpen && (
              <PaneStrip
                panes={activeSession.panes}
                activePaneId={activeSession.paneId}
                onSelect={selectPane}
                onClose={readOnly ? undefined : setPendingPaneId}
              />
            )}
          {/* isolate: the maximized side panel stays under the header's menus */}
          <div className="relative isolate flex min-h-0 flex-1">
            {/* The terminal fits the space left above the toolbar, so an open
                keyboard shrinks it rather than hiding its bottom rows. */}
            <div
              // Under the maximized side panel or the overview nothing here
              // takes focus
              inert={overviewOpen || (hasSidePanel && panelMaximized)}
              className="relative min-w-0 flex-1 bg-term"
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
                    // No stream at all where the server would refuse it
                    paneId={viewStreamOff ? undefined : activeSession.paneId}
                    backend={mux.backend}
                    followPane={mux.caps.clientSideSelect}
                    // tmux attaches a whole session: another session needs
                    // another stream.
                    streamKey={
                      mux.caps.clientSideSelect
                        ? undefined
                        : activeSession.groupId
                    }
                    paneSeen={mux.caps.clientSideSelect ? undefined : paneSeen}
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
                  <Suspense fallback={null}>
                    <currentView.Main {...viewProps} />
                  </Suspense>
                </div>
              )}
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
                <Suspense fallback={null}>
                  <sidePanelView.Panel {...viewProps} />
                </Suspense>
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
                />
              </div>
            )}
          </div>
        </main>
      </div>

      {/* The bottom input area belongs to the view: the key toolbar for the
          terminal. View-only has no input at all. */}
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
          <currentView.Input key={activeSession.paneId} {...viewProps} />
        )
      )}

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
          <span className="font-medium text-fg">{pendingRemove?.name}</span>{' '}
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
            "{pendingGroupClose?.name}"
          </span>
          ? Its {pendingGroupTabs} {pendingGroupTabs === 1 ? 'tab' : 'tabs'} and
          everything running in them will end.
          {pendingGroupClose && isZellij && (
            <> The session is deleted: Zellij cannot resurrect it.</>
          )}
          {pendingGroupClose && isDefaultGroup(pendingGroupClose.id) && (
            <>
              {' '}
              Termote starts a new, empty "{pendingGroupClose.name}" right away,
              and every device viewing it is disconnected.
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
          <span className="font-medium text-fg">{pendingPane?.label}</span> will
          be closed, along with anything still running in it. The other panes of
          this session stay open.
        </p>
        <RunningLine
          names={pendingPane?.command ? [pendingPane.command] : []}
        />
      </ConfirmDialog>
      <AboutModal
        isOpen={aboutOpen}
        onClose={() => setAboutOpen(false)}
        onCheckUpdates={() => {
          setAboutOpen(false)
          setSettingsGroup('updates')
          setSettingsOpen(true)
        }}
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
      {isMobile && (
        <GestureHintsOverlay
          isOpen={gestureHintsOpen}
          onDismiss={dismissGestureHints}
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

// What a close confirmation will stop, as the last snapshot named it.
function RunningLine({ names }: { names: string[] }) {
  const text = formatRunning(names)
  return text ? <p className="m-0 mt-2">{text}</p> : null
}
