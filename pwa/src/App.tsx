import { Eye } from 'lucide-react'
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
  TERMINAL_VIEW_ID,
  type ViewContext,
  viewPanelId,
} from './app-views'
import { AboutModal } from './components/about-modal'
import { AppHeader } from './components/app-header'
import { CommandHistoryDropdown } from './components/command-history-dropdown'
import type { ConnectionState } from './components/connection-indicator'
import { GestureHintsOverlay } from './components/gesture-hints-overlay'
import { HelpModal } from './components/help-modal'
import { KeyboardToolbar } from './components/keyboard-toolbar'
import { PaneStrip } from './components/pane-strip'
import { SessionSidebar } from './components/session-sidebar'
import { SettingsModal } from './components/settings-modal'
import { type TerminalHandle, TerminalView } from './components/terminal-view'
import { Toast, type ToastVariant } from './components/toast'
import { Banner } from './components/ui/banner'
import { ConfirmDialog } from './components/ui/confirm-dialog'
import { useTheme } from './contexts/theme-context'
import { useCommandHistory } from './hooks/use-command-history'
import { useFontSize } from './hooks/use-font-size'
import { useFullscreen } from './hooks/use-fullscreen'
import { useGestures } from './hooks/use-gestures'
import { useKeyboardVisible } from './hooks/use-keyboard-visible'
import { useLocalSessions } from './hooks/use-local-sessions'
import { useIsMobile } from './hooks/use-media-query'
import { selectTab } from './hooks/use-mux-api'
import { useSettings } from './hooks/use-settings'
import { useSidebarCollapsed } from './hooks/use-sidebar-collapsed'
import { useUpdateCheck } from './hooks/use-update-check'
import { applyUiStyle, syncThemeColor } from './ui-style'
import { checkApiVersion } from './utils/api-version'
import { formatDeepLink, parseDeepLink } from './utils/deep-link'
import { matchesFilter } from './utils/session-filter'
import {
  blurTerminal,
  dragTerminal,
  focusTerminal,
  isTerminalDisconnected,
  overflowsHorizontally,
  type PasteErrorReason,
  type PasteResult,
  pasteTmuxBuffer,
  pasteToTerminal,
  scrollTerminal,
  scrollTmux,
  sendKeyToTerminal,
  sendTextToTerminal,
  toggleTmuxCopyMode,
} from './utils/terminal-bridge'

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

interface AppProps {
  // Views of the pane; tests register extra ones
  views?: AppView[]
  // View-only role: every way to send input is hidden (#236 sets it from the
  // role the server reports; nothing does yet)
  readOnly?: boolean
}

export default function App({
  views = APP_VIEWS,
  readOnly = false,
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
  const [gestureHintsOpen, setGestureHintsOpen] = useState(false)
  const [toast, setToast] = useState<{
    id: number
    message: string
    variant: ToastVariant
  } | null>(null)
  // Each toast gets its own id, so the same message again starts afresh
  const toastIdRef = useRef(0)
  const showToast = useCallback(
    (message: string, variant: ToastVariant = 'info') =>
      setToast({ id: ++toastIdRef.current, message, variant }),
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
  // State of the terminal stream, reported by TerminalView.
  const [streamState, setStreamState] = useState<ConnectionState>('connecting')
  const { settings, updateSetting } = useSettings()
  const [ctrlActive, setCtrlActive] = useState(false)
  const [imeMode, setImeMode] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const { history, addCommand, removeCommand, clearHistory } =
    useCommandHistory()
  const isMobile = useIsMobile()
  const {
    isVisible: keyboardVisible,
    keyboardHeight,
    viewportHeight,
  } = useKeyboardVisible()
  const {
    activeSession,
    sessions,
    groups = [],
    switchSession,
    selectPane,
    addSession,
    removeSession,
    updateSession,
    isReady,
    isServerReachable,
    mux,
  } = useLocalSessions(settings.pollInterval)
  const copyModeSupported = mux.caps.copyMode
  // Closing a tab ends whatever runs in it, so every way to close one (tab
  // bar, sidebar, swipe, Delete key) asks first.
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const pendingRemove = sessions.find((s) => s.id === pendingRemoveId)
  const cancelRemove = useCallback(() => setPendingRemoveId(null), [])
  const confirmRemove = useCallback(() => {
    // Only reachable from the open dialog, which needs a pending id
    removeSession(pendingRemoveId!)
    setPendingRemoveId(null)
  }, [pendingRemoveId, removeSession])
  const isHerdr = mux.backend === 'herdr'
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
  const viewContext: ViewContext = useMemo(
    () => ({ mux, session: activeSession, readOnly }),
    [mux, activeSession, readOnly],
  )
  const offeredViews = useMemo(
    () => availableViews(views, viewContext),
    [views, viewContext],
  )
  const currentView =
    offeredViews.find((v) => v.id === viewId) ?? offeredViews[0]
  const isTerminalView = currentView.id === TERMINAL_VIEW_ID
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
        activeSession.id
      ) {
        selectTab(activeSession.id).catch(() => {})
      }
      setViewId(id)
    },
    [mux.caps.clientSideSelect, activeSession.id],
  )
  const viewProps = {
    ...viewContext,
    isMobile,
    setSidePanel: setSidePanelId,
    showView,
  }
  const sidePanelView = isMobile
    ? undefined
    : offeredViews.find((v) => v.id === sidePanelId && v.Panel)
  // tabpanel roles only mean something next to a switcher
  const panelRole = offeredViews.length > 1 ? 'tabpanel' : undefined
  const { fontSize, increase, decrease } = useFontSize()
  const { resolvedTheme } = useTheme()
  // Before paint and before the terminal's effects read the tokens.
  useLayoutEffect(() => applyUiStyle(settings.uiStyle), [settings.uiStyle])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tokens it reads change with both
  useEffect(() => syncThemeColor(), [settings.uiStyle, resolvedTheme])
  const { isFullscreen, toggleFullscreen } = useFullscreen()
  const { checkForUpdate, checking: updateChecking } = useUpdateCheck()

  // The indicator follows the stream; a failing session poll can only mark
  // it down, never up, so it does not show "connected" while the stream is
  // still backing off.
  const connectionState: ConnectionState = isServerReachable
    ? streamState
    : 'disconnected'

  // A server running another /api/mux version gets this bundle replaced:
  // checked on start and whenever the terminal stream comes back.
  const droppedRef = useRef(false)
  useEffect(() => {
    if (streamState === 'disconnected' || streamState === 'error') {
      droppedRef.current = true
    } else if (streamState === 'connected' && droppedRef.current) {
      droppedRef.current = false
      checkApiVersion()
    }
  }, [streamState])
  useEffect(() => {
    checkApiVersion()
  }, [])

  // Check for updates on mount
  useEffect(() => {
    checkForUpdate()
      .then((result) => {
        if (result.hasUpdate && result.latestVersion) {
          showToast(`Update available: v${result.latestVersion}`)
        }
      })
      .catch(() => {
        // Silently ignore - already handled internally
      })
  }, [checkForUpdate, showToast])

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

  // The history follows the finger, except with tmux copy mode, which only
  // scrolls by pages (keys), so a swipe there scrolls one page.
  const dragsHistory = !(copyModeSupported && !readOnly)

  // Swipes and long press send input; while view-only only scrolling and
  // zooming remain.
  const gestureHandlers = useMemo(
    () => ({
      // A herdr pane wider than the screen is dragged sideways instead; it
      // also keeps a stray swipe from interrupting an agent with Ctrl+C.
      onSwipeLeft: () => {
        if (isHerdr && overflowsHorizontally(getTerminal())) return
        if (!readOnly) sendKeyToTerminal(getTerminal(), 'c', { ctrl: true })
      },
      onSwipeRight: () => {
        if (isHerdr && overflowsHorizontally(getTerminal())) return
        if (!readOnly) sendKeyToTerminal(getTerminal(), 'Tab')
      },
      // A zoomed herdr pane larger than the screen moves with the finger,
      // then the history does.
      onPan: (dx: number, dy: number) =>
        dragTerminal(getTerminal(), isHerdr ? dx : 0, dy, dragsHistory),
      onSwipeUp: () => {
        if (!dragsHistory) handleScroll('down')
      },
      onSwipeDown: () => {
        if (!dragsHistory) handleScroll('up')
      },
      onLongPress: async () => {
        if (readOnly) return
        const result = await pasteToTerminal(getTerminal())
        if (shouldShowPasteError(result)) {
          showToast(getClipboardErrorMsg(result.reason, true), 'danger')
        }
      },
      onPinchIn: decrease,
      onPinchOut: increase,
    }),
    [
      decrease,
      dragsHistory,
      increase,
      isHerdr,
      getTerminal,
      handleScroll,
      readOnly,
      showToast,
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

  const handleCtrlShiftKey = useCallback(
    async (key: string) => {
      if (key === 'v') {
        const result = await pasteToTerminal(getTerminal())
        if (shouldShowPasteError(result)) {
          showToast(getClipboardErrorMsg(result.reason), 'danger')
        }
        return
      }
      sendKeyToTerminal(getTerminal(), key, { ctrl: true, shift: true })
    },
    [getTerminal, showToast],
  )

  const handleTmuxCopy = useCallback(() => {
    toggleTmuxCopyMode(getTerminal())
  }, [getTerminal])

  // Unified paste handler based on pasteSource setting
  const handlePaste = useCallback(async () => {
    if (settings.pasteSource === 'tmux' && copyModeSupported) {
      pasteTmuxBuffer(getTerminal())
    } else {
      const result = await pasteToTerminal(getTerminal())
      if (shouldShowPasteError(result)) {
        showToast(getClipboardErrorMsg(result.reason), 'danger')
      }
    }
  }, [settings.pasteSource, copyModeSupported, getTerminal, showToast])

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

  // The toolbar's Quick actions key (mobile only) opens a sheet of these.
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

  const handleMobileSelect = (id: string) => {
    switchSession(id)
    setSidebarOpen(false)
  }

  // Deep link: opened once the first snapshot is in, and again on each
  // hashchange. It only selects a tab, pane and view.
  const pendingLinkRef = useRef(parseDeepLink(window.location.hash))
  const [linkRequest, setLinkRequest] = useState(0)
  useEffect(() => {
    const onHashChange = () => {
      pendingLinkRef.current = parseDeepLink(window.location.hash)
      setLinkRequest((n) => n + 1)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  const sessionsLoaded = isReady && isServerReachable && sessions.length > 0
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
    switchSession(target.id, link.pane)
    if (link.view) setViewId(link.view)
  }, [linkRequest, sessionsLoaded, sessions, switchSession, showToast])

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
  useEffect(() => {
    if (!sessionsLoaded || !currentLink || pendingLinkRef.current) return
    if (window.location.hash !== currentLink) {
      window.history.replaceState(window.history.state, '', currentLink)
    }
  }, [sessionsLoaded, currentLink])

  // Built from what is on screen, not read from the address bar, which may
  // still hold a link that did not open.
  const copyLink = useCallback(async () => {
    const { origin, pathname, search } = window.location
    try {
      await navigator.clipboard.writeText(
        `${origin}${pathname}${search}${currentLink}`,
      )
      showToast('Link copied', 'success')
    } catch {
      showToast('Could not copy the link', 'danger')
    }
  }, [currentLink, showToast])

  return (
    <div
      className="flex flex-col overflow-hidden bg-bg font-ui text-fg"
      // With the keyboard open the app takes the visible height itself:
      // iOS can shrink 100dvh before innerHeight, and subtracting the
      // keyboard from an already shrunk 100dvh left the app near 0px tall.
      style={{
        height: keyboardHeight > 0 ? `${viewportHeight}px` : '100dvh',
      }}
    >
      <div className="flex flex-1 min-h-0">
        {/* Desktop sidebar */}
        {!isMobile && (
          <SessionSidebar
            sessions={sessions}
            groups={groups}
            activeId={activeSession.id}
            onSelect={switchSession}
            onAdd={addSession}
            onRemove={setPendingRemoveId}
            onUpdate={updateSession}
            isCollapsed={sidebarCollapsed}
            onToggleCollapse={toggleSidebarCollapsed}
            filter={settings.sidebarFilter}
            onFilterChange={(f) => updateSetting('sidebarFilter', f)}
            sortBlockedFirst={settings.sortBlockedFirst}
          />
        )}

        {/* Mobile sessions sheet, opened from the session chip */}
        {isMobile && (
          <SessionSidebar
            sessions={sessions}
            groups={groups}
            activeId={activeSession.id}
            onSelect={handleMobileSelect}
            onAdd={addSession}
            onRemove={setPendingRemoveId}
            onUpdate={updateSession}
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            isMobile
            filter={settings.sidebarFilter}
            onFilterChange={(f) => updateSetting('sidebarFilter', f)}
            sortBlockedFirst={settings.sortBlockedFirst}
          />
        )}

        <main className="flex-1 flex flex-col min-w-0">
          <AppHeader
            isMobile={isMobile}
            session={activeSession}
            groupSessions={groupSessions}
            groupName={groupName}
            blockedElsewhere={blockedElsewhere}
            showSessionTabs={settings.showSessionTabs}
            canRemoveTab={sessions.length > 1}
            onSelectTab={switchSession}
            onAddTab={() => addSession('New')}
            onRemoveTab={setPendingRemoveId}
            connectionState={connectionState}
            onRetry={() => terminalRef.current?.reconnect()}
            sessionsOpen={sidebarOpen}
            onOpenSessions={() => setSidebarOpen(true)}
            fontSize={fontSize}
            onDecreaseFont={decrease}
            onIncreaseFont={increase}
            isFullscreen={isFullscreen}
            onToggleFullscreen={toggleFullscreen}
            views={offeredViews}
            viewId={currentView.id}
            onViewChange={setViewId}
            viewPanelId={viewPanelId}
            menu={{
              onOpenAbout: () => setAboutOpen(true),
              onOpenHelp: () => setHelpOpen(true),
              onOpenSettings: () => setSettingsOpen(true),
              onCopyLink: currentLink ? copyLink : undefined,
            }}
          />
          {readOnly && (
            <Banner>View only: you can watch this terminal but not type</Banner>
          )}
          {/* Split tab: pick the pane to stream (herdr) */}
          {mux.caps.clientSideSelect && activeSession.panes && (
            <PaneStrip
              panes={activeSession.panes}
              activePaneId={activeSession.paneId}
              onSelect={selectPane}
            />
          )}
          <div className="flex min-h-0 flex-1">
            {/* The terminal fits the space left above the toolbar, so an open
                keyboard shrinks it rather than hiding its bottom rows. */}
            <div className="relative min-w-0 flex-1 bg-term">
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
                    paneId={activeSession.paneId}
                    backend={mux.backend}
                    followPane={mux.caps.clientSideSelect}
                    copyModeSupported={copyModeSupported}
                    serverScroll={!!mux.caps.scroll}
                    bracketedPaste={
                      mux.backend === 'herdr' && !!activeSession.hasAgent
                    }
                    fontSize={fontSize}
                    fontFamily={settings.terminalFont}
                    theme={resolvedTheme}
                    uiStyle={settings.uiStyle}
                    disableContextMenu={settings.disableContextMenu}
                    readOnly={readOnly}
                    driveSize={
                      settings.driveTerminalSize && !!mux.caps.driveSize
                    }
                    onDriveLost={onDriveLost}
                    onConnectionStateChange={setStreamState}
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
              <aside
                aria-label={sidePanelView.label}
                className="flex w-[440px] shrink-0 flex-col border-l border-border bg-bg"
              >
                <sidePanelView.Panel {...viewProps} />
              </aside>
            )}
          </div>
        </main>
      </div>

      {/* The bottom input area belongs to the view: the key toolbar for the
          terminal. View-only has no input at all. */}
      {readOnly ? (
        <div className="flex h-12 shrink-0 items-center gap-2 border-t border-border bg-surface px-3 pb-safe ui-terminal:bg-bg">
          <Eye size={16} aria-hidden="true" className="text-fg-muted" />
          <span className="text-[13px] text-fg-muted ui-terminal:font-label">
            View only
          </span>
        </div>
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
            onPaste={handlePaste}
            onToggleKeyboard={toggleKeyboard}
            onSendText={handleSendText}
            ctrlActive={ctrlActive}
            onCtrlChange={setCtrlActive}
            imeMode={imeMode}
            onImeModeChange={setImeMode}
            defaultExpanded={settings.toolbarDefaultExpanded}
            onHistoryToggle={() => setHistoryOpen((prev) => !prev)}
            historyOpen={historyOpen}
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
      </ConfirmDialog>
      <AboutModal isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />
      <HelpModal
        isOpen={helpOpen}
        onClose={() => setHelpOpen(false)}
        copyModeSupported={copyModeSupported}
      />
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onUpdateSetting={updateSetting}
        tmuxBufferSupported={copyModeSupported}
        pasteBufferLabel={
          mux.backend === 'tmux' ? 'tmux buffer' : 'Session buffer'
        }
        driveSizeSupported={!!mux.caps.driveSize}
        onShowGestureHints={isMobile ? showGestureHints : undefined}
        onCheckForUpdate={async () => {
          const result = await checkForUpdate(true)
          if (result.hasUpdate && result.latestVersion) {
            return `Update available: v${result.latestVersion}`
          }
          if (result.latestVersion) {
            return 'You are on the latest version'
          }
          return 'Could not check for updates'
        }}
        updateChecking={updateChecking}
        onClearHistory={clearHistory}
        historyCount={history.length}
      />
      {isMobile && (
        <GestureHintsOverlay
          isOpen={gestureHintsOpen}
          onDismiss={dismissGestureHints}
        />
      )}
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          variant={toast.variant}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  )
}
