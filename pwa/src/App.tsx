import { Maximize, Menu, Minimize } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AboutModal } from './components/about-modal'
import { BottomNavigation } from './components/bottom-navigation'
import { CommandHistoryDropdown } from './components/command-history-dropdown'
import {
  ConnectionIndicator,
  type ConnectionState,
} from './components/connection-indicator'
import { GestureHintsOverlay } from './components/gesture-hints-overlay'
import { HelpModal } from './components/help-modal'
import { KeyboardToolbar } from './components/keyboard-toolbar'
import { PaneStrip } from './components/pane-strip'
import { QuickActionsMenu } from './components/quick-actions-menu'
import { SessionSidebar } from './components/session-sidebar'
import { SessionTabs } from './components/session-tabs'
import { SettingsMenu } from './components/settings-menu'
import { SettingsModal } from './components/settings-modal'
import { type TerminalHandle, TerminalView } from './components/terminal-view'
import { Toast } from './components/toast'
import { useTheme } from './contexts/theme-context'
import { useCommandHistory } from './hooks/use-command-history'
import { useFontSize } from './hooks/use-font-size'
import { useFullscreen } from './hooks/use-fullscreen'
import { useGestures } from './hooks/use-gestures'
import { useKeyboardVisible } from './hooks/use-keyboard-visible'
import { useLocalSessions } from './hooks/use-local-sessions'
import { useIsMobile } from './hooks/use-media-query'
import { useSettings } from './hooks/use-settings'
import { useSidebarCollapsed } from './hooks/use-sidebar-collapsed'
import { useUpdateCheck } from './hooks/use-update-check'
import { checkApiVersion } from './utils/api-version'
import {
  blurTerminal,
  focusTerminal,
  isTerminalDisconnected,
  type PasteErrorReason,
  type PasteResult,
  pasteTmuxBuffer,
  pasteToTerminal,
  scrollTerminal,
  scrollTerminalHorizontal,
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

export default function App() {
  const terminalRef = useRef<TerminalHandle>(null)
  const getTerminal = () => terminalRef.current
  const gestureRef = useRef<HTMLDivElement>(null)
  const ctrlInputRef = useRef<HTMLInputElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { isCollapsed: sidebarCollapsed, toggle: toggleSidebarCollapsed } =
    useSidebarCollapsed()
  const [aboutOpen, setAboutOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [gestureHintsOpen, setGestureHintsOpen] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  // State of the terminal stream, reported by TerminalView.
  const [streamState, setStreamState] = useState<ConnectionState>('connecting')
  const { settings, updateSetting } = useSettings()
  const [showTitleTooltip, setShowTitleTooltip] = useState(false)
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
    groups,
    switchSession,
    selectPane,
    addSession,
    removeSession,
    updateSession,
    isServerReachable,
    mux,
  } = useLocalSessions(settings.pollInterval)
  const copyModeSupported = mux.caps.copyMode
  const isHerdr = mux.backend === 'herdr'
  // Tab bars show the current group only; the sidebar shows every group.
  const groupSessions = useMemo(
    () =>
      activeSession.groupId
        ? sessions.filter((s) => s.groupId === activeSession.groupId)
        : sessions,
    [sessions, activeSession.groupId],
  )
  const { fontSize, increase, decrease } = useFontSize()
  const { resolvedTheme } = useTheme()
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
          setToastMessage(`Update available: v${result.latestVersion}`)
        }
      })
      .catch(() => {
        // Silently ignore - already handled internally
      })
  }, [checkForUpdate])

  // tmux scrolls its own history (copy mode); other backends scroll the
  // xterm.js scrollback.
  const handleScroll = useCallback(
    (direction: 'up' | 'down') => {
      if (copyModeSupported) scrollTmux(getTerminal(), direction)
      else scrollTerminal(getTerminal(), direction)
    },
    [copyModeSupported, getTerminal],
  )

  const gestureHandlers = useMemo(
    () => ({
      // A herdr pane wider than the screen scrolls sideways instead; it also
      // keeps a stray swipe from interrupting an agent with Ctrl+C.
      onSwipeLeft: () => {
        if (isHerdr && scrollTerminalHorizontal(getTerminal(), 'right')) return
        sendKeyToTerminal(getTerminal(), 'c', { ctrl: true })
      },
      onSwipeRight: () => {
        if (isHerdr && scrollTerminalHorizontal(getTerminal(), 'left')) return
        sendKeyToTerminal(getTerminal(), 'Tab')
      },
      // Vertical swipes scroll the history, as the toolbar's scroll keys do.
      onSwipeUp: () => handleScroll('down'),
      onSwipeDown: () => handleScroll('up'),
      onLongPress: async () => {
        const result = await pasteToTerminal(getTerminal())
        if (shouldShowPasteError(result)) {
          setToastMessage(getClipboardErrorMsg(result.reason, true))
        }
      },
      onPinchIn: decrease,
      onPinchOut: increase,
    }),
    [decrease, increase, isHerdr, getTerminal, handleScroll],
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
          setToastMessage(getClipboardErrorMsg(result.reason))
        }
        return
      }
      sendKeyToTerminal(getTerminal(), key, { ctrl: true, shift: true })
    },
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
      const result = await pasteToTerminal(getTerminal())
      if (shouldShowPasteError(result)) {
        setToastMessage(getClipboardErrorMsg(result.reason))
      }
    }
  }, [settings.pasteSource, copyModeSupported, getTerminal])

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

  return (
    <div
      className="flex flex-col bg-zinc-100 dark:bg-zinc-900 text-zinc-900 dark:text-white overflow-hidden"
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
            onRemove={removeSession}
            onUpdate={updateSession}
            isCollapsed={sidebarCollapsed}
            onToggleCollapse={toggleSidebarCollapsed}
          />
        )}

        {/* Mobile sidebar (slide-over) */}
        {isMobile && (
          <SessionSidebar
            sessions={sessions}
            groups={groups}
            activeId={activeSession.id}
            onSelect={handleMobileSelect}
            onAdd={addSession}
            onRemove={removeSession}
            onUpdate={updateSession}
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            isMobile
          />
        )}

        <main className="flex-1 flex flex-col min-w-0">
          <header
            className="relative z-10 px-4 flex items-center bg-white dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700 shrink-0"
            style={{
              paddingTop: 'env(safe-area-inset-top)',
              minHeight: 'calc(3rem + env(safe-area-inset-top))',
            }}
          >
            {/* Mobile hamburger */}
            {isMobile && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-zinc-200/50 dark:hover:bg-zinc-700/50 mr-2 transition-colors"
                aria-label="Open sessions menu"
              >
                <Menu size={20} />
              </button>
            )}
            <div
              className="relative flex items-center min-w-0 flex-1 mr-2 cursor-pointer"
              onClick={() => setShowTitleTooltip(!showTitleTooltip)}
              title={
                !isMobile
                  ? `${activeSession.name}${activeSession.description ? ` - ${activeSession.description}` : ''}`
                  : undefined
              }
            >
              <span className="shrink-0 text-lg">{activeSession.icon}</span>
              <span className="ml-2 font-medium text-zinc-900 dark:text-white truncate">
                {activeSession.name}
              </span>
              {activeSession.description && (
                <span className="ml-2 text-sm text-zinc-500 dark:text-zinc-400 hidden sm:inline truncate">
                  {activeSession.description}
                </span>
              )}
              {/* Mobile tooltip with backdrop */}
              {showTitleTooltip && isMobile && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={(e) => {
                      e.stopPropagation()
                      setShowTitleTooltip(false)
                    }}
                  />
                  <div className="absolute left-0 top-full mt-1 z-50 px-3 py-2 bg-zinc-900 dark:bg-zinc-700 text-white text-sm rounded-lg shadow-lg max-w-[80vw] break-words">
                    <div className="font-medium">{activeSession.name}</div>
                    {activeSession.description && (
                      <div className="text-zinc-300 text-xs mt-1">
                        {activeSession.description}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <ConnectionIndicator
                state={connectionState}
                onRetry={() => terminalRef.current?.reconnect()}
              />
              <button
                onClick={decrease}
                className="px-2 py-1 text-xs bg-zinc-200/70 dark:bg-zinc-700/70 rounded-lg hover:bg-zinc-300/70 dark:hover:bg-zinc-600/70 touch-manipulation transition-colors"
                aria-label="Decrease font size"
              >
                A-
              </button>
              <span className="text-xs text-zinc-500 dark:text-zinc-400 w-8 text-center">
                {fontSize}
              </span>
              <button
                onClick={increase}
                className="px-2 py-1 text-xs bg-zinc-200/70 dark:bg-zinc-700/70 rounded-lg hover:bg-zinc-300/70 dark:hover:bg-zinc-600/70 touch-manipulation transition-colors"
                aria-label="Increase font size"
              >
                A+
              </button>
              {!isMobile && (
                <button
                  onClick={toggleFullscreen}
                  className="px-2 py-1 text-xs bg-zinc-200/70 dark:bg-zinc-700/70 rounded-lg hover:bg-zinc-300/70 dark:hover:bg-zinc-600/70 transition-colors"
                  aria-label={
                    isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'
                  }
                  title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  {isFullscreen ? (
                    <Minimize size={14} />
                  ) : (
                    <Maximize size={14} />
                  )}
                </button>
              )}
              <SettingsMenu
                onOpenAbout={() => setAboutOpen(true)}
                onOpenHelp={() => setHelpOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            </div>
          </header>
          {/* Desktop session tabs */}
          {!isMobile && settings.showSessionTabs && (
            <SessionTabs
              sessions={groupSessions}
              activeId={activeSession.id}
              onSelect={switchSession}
              onAdd={() => addSession('New')}
              onRemove={removeSession}
              canRemove={sessions.length > 1}
            />
          )}
          {/* Split tab: pick the pane to stream (herdr) */}
          {mux.caps.clientSideSelect && activeSession.panes && (
            <PaneStrip
              panes={activeSession.panes}
              activePaneId={activeSession.paneId}
              onSelect={selectPane}
            />
          )}
          {/* The terminal fits the space left above the toolbar, so an open
              keyboard shrinks it rather than hiding its bottom rows. */}
          <div
            className="flex-1 relative min-h-0"
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
                disableContextMenu={settings.disableContextMenu}
                onConnectionStateChange={setStreamState}
              />
            </div>
            {/* Gesture overlay - captures touch gestures (mobile only) */}
            {isMobile && (
              <div ref={gestureRef} className="absolute inset-0 touch-none" />
            )}
          </div>
        </main>
      </div>

      {/* Quick Actions FAB (mobile only) */}
      {isMobile && (
        <QuickActionsMenu
          onSendKey={(key, opts) => {
            if (opts?.ctrl) {
              sendKeyToTerminal(getTerminal(), key, { ctrl: true })
            } else {
              sendKeyToTerminal(getTerminal(), key)
            }
          }}
          onSendText={(text) => sendTextToTerminal(getTerminal(), text)}
        />
      )}

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
        />
      </div>

      {/* Mobile bottom navigation */}
      {isMobile && (
        <BottomNavigation
          sessions={groupSessions}
          activeId={activeSession.id}
          onSelect={switchSession}
          onAdd={() => addSession('New')}
          onToggleSidebar={() => setSidebarOpen(true)}
        />
      )}

      {/* Hidden input for Ctrl+key capture - programmatically focused only */}
      <input
        ref={ctrlInputRef}
        type="text"
        className="sr-only"
        tabIndex={-1}
        autoComplete="off"
        onChange={handleCtrlInput}
        onBlur={() => setCtrlActive(false)}
      />

      {/* Modals */}
      <AboutModal isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />
      <HelpModal isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onUpdateSetting={updateSetting}
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
      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}
    </div>
  )
}
