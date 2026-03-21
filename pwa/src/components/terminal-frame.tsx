import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { setTerminalFontSize, setTerminalTheme } from '../utils/terminal-bridge'

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

    useImperativeHandle(ref, () => iframeRef.current as HTMLIFrameElement)

    // Apply theme and font size after iframe loads
    useEffect(() => {
      const iframe = iframeRef.current
      if (!iframe) return

      let attempts = 0
      let intervalId: ReturnType<typeof setInterval> | null = null

      const applySettings = () => {
        const themeApplied = setTerminalTheme(iframe, THEMES[theme])
        if (themeApplied) {
          setTerminalFontSize(iframe, fontSize)
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
    }, [theme, fontSize])

    // key={theme} forces iframe reload when theme changes
    return (
      <iframe
        key={theme}
        ref={iframeRef}
        src="/terminal/"
        className={`flex-1 w-full h-full border-none ${theme === 'light' ? 'bg-[#f6f8fa]' : 'bg-[#2b2b2b]'}`}
        title="Terminal"
        allow="clipboard-read; clipboard-write"
      />
    )
  },
)

TerminalFrame.displayName = 'TerminalFrame'
