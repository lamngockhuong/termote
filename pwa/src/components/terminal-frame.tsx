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
  sendKeyToTerminal,
  setTerminalFontSize,
  setTerminalTheme,
} from '../utils/terminal-bridge'

interface Props {
  fontSize?: number
  theme?: 'light' | 'dark'
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

export const TerminalFrame = forwardRef<HTMLIFrameElement, Props>(
  ({ fontSize = 14, theme = 'dark' }, ref) => {
    const iframeRef = useRef<HTMLIFrameElement>(null)
    const [terminalSrc, setTerminalSrc] = useState<string | null>(null)
    const [tokenError, setTokenError] = useState<string | null>(null)

    useImperativeHandle(ref, () => iframeRef.current as HTMLIFrameElement)

    // Fetch a new token each time the iframe needs to load (theme change triggers key change)
    const loadTerminal = useCallback(async () => {
      try {
        setTokenError(null)
        const token = await fetchTerminalToken()
        setTerminalSrc(`/terminal/?token=${token}`)
      } catch {
        setTokenError('Failed to load terminal')
      }
    }, [])

    useEffect(() => {
      loadTerminal()
    }, [loadTerminal, theme])

    // Apply theme after iframe loads
    useEffect(() => {
      const iframe = iframeRef.current
      if (!iframe) return

      let attempts = 0
      let intervalId: ReturnType<typeof setInterval> | null = null

      const applySettings = () => {
        const themeApplied = setTerminalTheme(iframe, THEMES[theme])
        if (themeApplied) {
          setTerminalFontSize(iframe, fontSize)
          // Clear DA response artifacts (e.g. "1;2c0;276;0c") leaked by xterm.js
          // when ttyd+tmux connection is established. Ctrl+U clears the input line.
          // Delay to ensure DA responses have arrived before clearing.
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
    }, [theme])

    // Apply font size changes immediately (without reloading iframe)
    useEffect(() => {
      const iframe = iframeRef.current
      if (!iframe) return
      setTerminalFontSize(iframe, fontSize)
    }, [fontSize])

    // key={terminalSrc} forces iframe reload when token or theme changes
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
    if (!terminalSrc) return null
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
