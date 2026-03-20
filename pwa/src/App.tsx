import { useRef, useMemo } from 'react'
import { useGestures } from './hooks/use-gestures'
import { useFontSize } from './hooks/use-font-size'
import { SessionSidebar } from './components/session-sidebar'
import { TerminalFrame } from './components/terminal-frame'
import { KeyboardToolbar } from './components/keyboard-toolbar'
import { sendKeyToTerminal, focusTerminal, pasteToTerminal } from './utils/terminal-bridge'
import { useLocalSessions } from './hooks/use-local-sessions'

export default function App() {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const gestureRef = useRef<HTMLDivElement>(null)
  const { activeSession, sessions, switchSession, addSession, removeSession } =
    useLocalSessions()
  const { fontSize, increase, decrease } = useFontSize()

  const gestureHandlers = useMemo(
    () => ({
      onSwipeLeft: () => sendKeyToTerminal(iframeRef.current, 'c', true),
      onSwipeRight: () => sendKeyToTerminal(iframeRef.current, 'Tab'),
      onSwipeUp: () => sendKeyToTerminal(iframeRef.current, 'ArrowUp'),
      onSwipeDown: () => sendKeyToTerminal(iframeRef.current, 'ArrowDown'),
      onLongPress: () => pasteToTerminal(iframeRef.current),
      onPinchIn: decrease,
      onPinchOut: increase,
    }),
    [decrease, increase]
  )

  useGestures(gestureRef, gestureHandlers)

  const handleKey = (key: string) => {
    sendKeyToTerminal(iframeRef.current, key)
    focusTerminal(iframeRef.current)
  }

  const handleCtrlKey = (key: string) => {
    sendKeyToTerminal(iframeRef.current, key, true)
    focusTerminal(iframeRef.current)
  }

  return (
    <div className="h-dvh flex flex-col bg-zinc-900 text-white">
      <div className="flex flex-1 min-h-0">
        <SessionSidebar
          sessions={sessions}
          activeId={activeSession.id}
          onSelect={switchSession}
          onAdd={addSession}
          onRemove={removeSession}
        />
        <main ref={gestureRef} className="flex-1 flex flex-col min-w-0">
          <header className="h-10 px-4 flex items-center bg-zinc-800 border-b border-zinc-700 shrink-0">
            <span>
              {activeSession.icon} {activeSession.name}
            </span>
            <span className="ml-2 text-sm text-zinc-400 hidden sm:inline">
              {activeSession.description}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={decrease}
                className="px-2 py-1 text-xs bg-zinc-700 rounded hover:bg-zinc-600 touch-manipulation"
              >
                A-
              </button>
              <span className="text-xs text-zinc-400 w-8 text-center">{fontSize}</span>
              <button
                onClick={increase}
                className="px-2 py-1 text-xs bg-zinc-700 rounded hover:bg-zinc-600 touch-manipulation"
              >
                A+
              </button>
            </div>
          </header>
          <TerminalFrame ref={iframeRef} fontSize={fontSize} />
        </main>
      </div>
      <KeyboardToolbar onKey={handleKey} onCtrlKey={handleCtrlKey} />
    </div>
  )
}
