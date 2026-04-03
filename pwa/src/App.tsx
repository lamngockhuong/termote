import { Maximize, Menu, Minimize } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AboutModal } from './components/about-modal'
import { BottomNavigation } from './components/bottom-navigation'
import { HelpModal } from './components/help-modal'
import { KeyboardToolbar } from './components/keyboard-toolbar'
import { SessionSidebar } from './components/session-sidebar'
import { SettingsMenu } from './components/settings-menu'
import { SettingsModal } from './components/settings-modal'
import {
  TerminalFrame,
  type TerminalFrameHandle,
} from './components/terminal-frame'
import { useTheme } from './contexts/theme-context'
import { useFontSize } from './hooks/use-font-size'
import { useFullscreen } from './hooks/use-fullscreen'
import { useGestures } from './hooks/use-gestures'
import { useKeyboardVisible } from './hooks/use-keyboard-visible'
import { useLocalSessions } from './hooks/use-local-sessions'
import { useIsMobile } from './hooks/use-media-query'
import { useSettings } from './hooks/use-settings'
import { useSidebarCollapsed } from './hooks/use-sidebar-collapsed'
import {
  blurTerminal,
  focusTerminal,
  isInCopyMode,
  isTerminalDisconnected,
  pasteTmuxBuffer,
  pasteToTerminal,
  scrollTmux,
  sendKeyToTerminal,
  sendTextToTerminal,
  toggleTmuxCopyMode,
} from './utils/terminal-bridge'

export default function App() {
  const terminalRef = useRef<TerminalFrameHandle>(null)
  const getIframe = () => terminalRef.current?.iframe ?? null
  const gestureRef = useRef<HTMLDivElement>(null)
  const terminalContainerRef = useRef<HTMLDivElement>(null)
  const ctrlInputRef = useRef<HTMLInputElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { isCollapsed: sidebarCollapsed, toggle: toggleSidebarCollapsed } =
    useSidebarCollapsed()
  const [aboutOpen, setAboutOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { settings, updateSetting } = useSettings()
  const [showTitleTooltip, setShowTitleTooltip] = useState(false)
  const [ctrlActive, setCtrlActive] = useState(false)
  const [imeMode, setImeMode] = useState(false)
  const isMobile = useIsMobile()
  const { isVisible: keyboardVisible, keyboardHeight } = useKeyboardVisible()
  const {
    activeSession,
    sessions,
    switchSession,
    addSession,
    removeSession,
    updateSession,
  } = useLocalSessions(settings.pollInterval)
  const { fontSize, increase, decrease } = useFontSize()
  const { resolvedTheme } = useTheme()
  const { isFullscreen, toggleFullscreen } = useFullscreen()

  const gestureHandlers = useMemo(
    () => ({
      onSwipeLeft: () => sendKeyToTerminal(getIframe(), 'c', { ctrl: true }),
      onSwipeRight: () => sendKeyToTerminal(getIframe(), 'Tab'),
      onSwipeUp: () => {
        if ((keyboardVisible || imeMode) && terminalContainerRef.current) {
          // Keyboard or IME mode - scroll container to see hidden content
          terminalContainerRef.current.scrollTop += 150
        } else if (isInCopyMode()) {
          // In copy mode - send PageDown
          scrollTmux(getIframe(), 'down')
        }
      },
      onSwipeDown: () => {
        if ((keyboardVisible || imeMode) && terminalContainerRef.current) {
          // Keyboard or IME mode - scroll container to see hidden content
          terminalContainerRef.current.scrollTop -= 150
        } else if (isInCopyMode()) {
          // In copy mode - send PageUp
          scrollTmux(getIframe(), 'up')
        }
      },
      onLongPress: () => pasteToTerminal(getIframe()),
      onPinchIn: decrease,
      onPinchOut: increase,
    }),
    [decrease, increase, keyboardVisible, imeMode],
  )

  const toggleKeyboard = () => {
    if (keyboardVisible) {
      blurTerminal(getIframe())
    } else {
      focusTerminal(getIframe())
    }
  }

  // Handle Ctrl+key input from hidden input field
  const handleCtrlInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      if (value.length === 1 && /^[a-zA-Z]$/.test(value)) {
        sendKeyToTerminal(getIframe(), value.toLowerCase(), {
          ctrl: true,
        })
        setCtrlActive(false)
        focusTerminal(getIframe())
      }
      e.target.value = ''
    },
    [],
  )

  // Focus hidden input when Ctrl is active
  useEffect(() => {
    if (ctrlActive && ctrlInputRef.current) {
      blurTerminal(getIframe())
      ctrlInputRef.current.focus()
    }
  }, [ctrlActive])

  useGestures(gestureRef, gestureHandlers)

  const handleKey = useCallback((key: string) => {
    // When terminal is disconnected (ttyd shows "Press ⏎ to Reconnect"),
    // reload iframe with new token since we can't simulate trusted keyboard events.
    if (key === 'Enter' && isTerminalDisconnected(getIframe())) {
      terminalRef.current?.reconnect()
      return
    }
    sendKeyToTerminal(getIframe(), key)
  }, [])

  const handleCtrlKey = useCallback((key: string) => {
    sendKeyToTerminal(getIframe(), key, { ctrl: true })
  }, [])

  const handleShiftKey = useCallback((key: string) => {
    sendKeyToTerminal(getIframe(), key, { shift: true })
  }, [])

  const handleCtrlShiftKey = useCallback((key: string) => {
    if (key === 'v') {
      pasteToTerminal(getIframe())
      return
    }
    sendKeyToTerminal(getIframe(), key, { ctrl: true, shift: true })
  }, [])

  const handleScroll = useCallback((direction: 'up' | 'down') => {
    scrollTmux(getIframe(), direction)
  }, [])

  const handleTmuxCopy = useCallback(() => {
    toggleTmuxCopyMode(getIframe())
  }, [])

  const handleTmuxPaste = useCallback(() => {
    pasteTmuxBuffer(getIframe())
  }, [])

  const handleSendText = useCallback(
    (text: string) => {
      sendTextToTerminal(getIframe(), text)
      if (settings.imeSendBehavior === 'send-enter') {
        sendKeyToTerminal(getIframe(), 'Enter')
      }
    },
    [settings.imeSendBehavior],
  )

  const handleMobileSelect = (id: string) => {
    switchSession(id)
    setSidebarOpen(false)
  }

  return (
    <div
      className="flex flex-col bg-zinc-100 dark:bg-zinc-900 text-zinc-900 dark:text-white overflow-hidden"
      style={{
        height:
          keyboardHeight > 0 ? `calc(100dvh - ${keyboardHeight}px)` : '100dvh',
      }}
    >
      <div className="flex flex-1 min-h-0">
        {/* Desktop sidebar */}
        {!isMobile && (
          <SessionSidebar
            sessions={sessions}
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
          <div
            ref={terminalContainerRef}
            className="flex-1 relative min-h-0 overflow-y-auto scroll-smooth"
            onContextMenu={(e) => e.preventDefault()}
            style={{
              height:
                keyboardHeight > 0
                  ? `calc(100dvh - ${keyboardHeight}px - 48px - 56px)`
                  : undefined,
            }}
          >
            <div
              style={{
                height: keyboardHeight > 0 ? '100dvh' : '100%',
                minHeight: '100%',
              }}
            >
              <TerminalFrame
                ref={terminalRef}
                fontSize={fontSize}
                theme={resolvedTheme}
                disableContextMenu={settings.disableContextMenu}
              />
            </div>
            {/* Gesture overlay - captures touch gestures (mobile only) */}
            {isMobile && (
              <div ref={gestureRef} className="absolute inset-0 touch-none" />
            )}
          </div>
        </main>
      </div>

      <KeyboardToolbar
        onKey={handleKey}
        onCtrlKey={handleCtrlKey}
        onShiftKey={handleShiftKey}
        onCtrlShiftKey={handleCtrlShiftKey}
        onScroll={handleScroll}
        onTmuxCopy={handleTmuxCopy}
        onTmuxPaste={handleTmuxPaste}
        onToggleKeyboard={toggleKeyboard}
        onSendText={handleSendText}
        ctrlActive={ctrlActive}
        onCtrlChange={setCtrlActive}
        imeMode={imeMode}
        onImeModeChange={setImeMode}
        defaultExpanded={settings.toolbarDefaultExpanded}
      />

      {/* Mobile bottom navigation */}
      {isMobile && (
        <BottomNavigation
          sessions={sessions}
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
      />
    </div>
  )
}
