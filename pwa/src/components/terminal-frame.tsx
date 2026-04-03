import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { fetchTerminalToken } from '../hooks/use-tmux-api'
import {
  blockContextMenu,
  sendKeyToTerminal,
  setTerminalFontSize,
  setTerminalTheme,
  unblockContextMenu,
} from '../utils/terminal-bridge'

export interface TerminalFrameHandle {
  iframe: HTMLIFrameElement | null
  reconnect: () => void
}

interface Props {
  fontSize?: number
  theme?: 'light' | 'dark'
  disableContextMenu?: boolean
}

const THEMES = {
  light: {
    background: '#f6f8fa',
    foreground: '#24292e',
    cursor: '#24292e',
    cursorAccent: '#f6f8fa',
    selectionBackground: 'rgba(3, 102, 214, 0.3)',
    selectionForeground: '#24292e',
    black: '#24292e',
    red: '#d73a49',
    green: '#22863a',
    yellow: '#b08800',
    blue: '#0366d6',
    magenta: '#6f42c1',
    cyan: '#1b7c83',
    white: '#6a737d',
    brightBlack: '#586069',
    brightRed: '#cb2431',
    brightGreen: '#28a745',
    brightYellow: '#dbab09',
    brightBlue: '#2188ff',
    brightMagenta: '#8a63d2',
    brightCyan: '#3192aa',
    brightWhite: '#959da5',
  },
  dark: {
    background: '#2b2b2b',
    foreground: '#d2d2d2',
    cursor: '#adadad',
    cursorAccent: '#2b2b2b',
    selectionBackground: 'rgba(255, 255, 255, 0.2)',
    selectionForeground: '#ffffff',
    black: '#000000',
    red: '#d81e00',
    green: '#5ea702',
    yellow: '#cfae00',
    blue: '#427ab3',
    magenta: '#89658e',
    cyan: '#00a7aa',
    white: '#dbded8',
    brightBlack: '#686a66',
    brightRed: '#f54235',
    brightGreen: '#99e343',
    brightYellow: '#fdeb61',
    brightBlue: '#84b0d8',
    brightMagenta: '#bc94b7',
    brightCyan: '#37e6e8',
    brightWhite: '#f1f1f0',
  },
}

export const TerminalFrame = forwardRef<TerminalFrameHandle, Props>(
  ({ fontSize = 14, theme = 'dark', disableContextMenu = true }, ref) => {
    const iframeRef = useRef<HTMLIFrameElement>(null)
    const [terminalSrc, setTerminalSrc] = useState<string | null>(null)
    const [tokenError, setTokenError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    // Fetch a token and set the terminal iframe source
    const loadTerminal = useCallback(async () => {
      try {
        setTokenError(null)
        setLoading(true)
        const token = await fetchTerminalToken()
        setTerminalSrc(`/terminal/?token=${token}`)
      } catch {
        setTokenError('Failed to load terminal')
      } finally {
        setLoading(false)
      }
    }, [])

    useImperativeHandle(
      ref,
      () => ({
        get iframe() {
          return iframeRef.current
        },
        reconnect: loadTerminal,
      }),
      [loadTerminal],
    )

    useEffect(() => {
      loadTerminal()
    }, [loadTerminal])

    // Apply theme/fontSize immediately if terminal is ready, otherwise poll on load.
    // terminalSrc triggers re-run when iframe appears after loading state clears.
    // biome-ignore lint/correctness/useExhaustiveDependencies: terminalSrc ensures effect runs when iframe mounts
    useEffect(() => {
      const iframe = iframeRef.current
      if (!iframe) return

      const applyContextMenu = () =>
        disableContextMenu
          ? blockContextMenu(iframe)
          : unblockContextMenu(iframe)

      const immediateApplied = setTerminalTheme(iframe, THEMES[theme])
      if (immediateApplied) {
        setTerminalFontSize(iframe, fontSize)
        applyContextMenu()
        return
      }

      // Terminal not ready yet (initial load) — poll via load event
      let attempts = 0
      let intervalId: ReturnType<typeof setInterval> | null = null

      const applySettings = () => {
        const themeApplied = setTerminalTheme(iframe, THEMES[theme])
        if (themeApplied) {
          setTerminalFontSize(iframe, fontSize)
          applyContextMenu()
          // Clear DA response artifacts leaked by xterm.js on ttyd+tmux connect
          setTimeout(() => sendKeyToTerminal(iframe, 'u', { ctrl: true }), 300)
          if (intervalId) clearInterval(intervalId)
        } else if (++attempts >= 30) {
          if (intervalId) clearInterval(intervalId)
        }
      }

      const handleLoad = () => {
        attempts = 0
        intervalId = setInterval(applySettings, 100)
      }

      iframe.addEventListener('load', handleLoad)
      return () => {
        if (intervalId) clearInterval(intervalId)
        iframe.removeEventListener('load', handleLoad)
      }
    }, [theme, fontSize, terminalSrc, disableContextMenu])

    if (tokenError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center text-red-400">
          <p>{tokenError}</p>
          <button
            onClick={loadTerminal}
            className="mt-2 px-3 py-1 text-sm bg-zinc-700 rounded hover:bg-zinc-600"
          >
            Retry
          </button>
        </div>
      )
    }
    if (loading || !terminalSrc) {
      return (
        <div className="flex-1 flex items-center justify-center text-zinc-400">
          Connecting...
        </div>
      )
    }
    return (
      <iframe
        key={terminalSrc}
        ref={iframeRef}
        src={terminalSrc}
        className={`flex-1 w-full h-full border-none ${theme === 'light' ? 'bg-[#f6f8fa]' : 'bg-[#2b2b2b]'}`}
        title="Terminal"
        allow="clipboard-read; clipboard-write"
      />
    )
  },
)

TerminalFrame.displayName = 'TerminalFrame'
