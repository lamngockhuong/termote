import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

interface Props {
  fontSize?: number
  theme?: 'light' | 'dark'
}

const THEMES = {
  light: {
    foreground: '#1e1e1e',
    background: '#ffffff',
    cursor: '#1e1e1e',
    black: '#000000',
    red: '#cd3131',
    green: '#00bc00',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    brightBlack: '#666666',
    brightRed: '#cd3131',
    brightGreen: '#14ce14',
    brightYellow: '#b5ba00',
    brightBlue: '#0451a5',
    brightMagenta: '#bc05bc',
    brightCyan: '#0598bc',
    brightWhite: '#a5a5a5',
  },
  dark: {
    foreground: '#d2d2d2',
    background: '#2b2b2b',
    cursor: '#adadad',
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

    // Forward ref to parent
    useImperativeHandle(ref, () => iframeRef.current as HTMLIFrameElement)

    // Apply theme on load
    useEffect(() => {
      const iframe = iframeRef.current
      if (!iframe) return

      const applyTheme = () => {
        try {
          const doc = iframe.contentDocument
          const win = iframe.contentWindow as {
            term?: { options: { theme: unknown } }
          }

          if (win?.term) {
            win.term.options.theme = THEMES[theme]
          }

          const viewport = doc?.querySelector('.xterm-viewport') as HTMLElement
          if (viewport) {
            viewport.style.backgroundColor = THEMES[theme].background
          }

          const screen = doc?.querySelector('.xterm-screen') as HTMLElement
          if (screen) {
            screen.style.backgroundColor = THEMES[theme].background
          }
        } catch {
          // Cross-origin or not loaded yet
        }
      }

      applyTheme()
      iframe.addEventListener('load', applyTheme)
      return () => iframe.removeEventListener('load', applyTheme)
    }, [theme])

    // Update font size dynamically via xterm API
    useEffect(() => {
      const iframe = iframeRef.current
      if (!iframe) return

      const applyFontSize = () => {
        try {
          const win = iframe.contentWindow as {
            term?: {
              setOption?: (key: string, value: unknown) => void
              options?: { fontSize: number }
            }
            fitAddon?: { fit: () => void }
          }

          if (win?.term) {
            // Try setOption (older xterm API)
            if (typeof win.term.setOption === 'function') {
              win.term.setOption('fontSize', fontSize)
            }
            // Try options property (newer xterm API)
            else if (win.term.options) {
              win.term.options.fontSize = fontSize
            }

            // Call fit to resize
            win.fitAddon?.fit()
          }
        } catch {
          // Cross-origin or API not available
        }
      }

      // Apply with delay to ensure terminal is ready
      const timer = setTimeout(applyFontSize, 300)
      return () => clearTimeout(timer)
    }, [fontSize])

    return (
      <iframe
        ref={iframeRef}
        src="/terminal/"
        className={`flex-1 w-full h-full border-none ${theme === 'light' ? 'bg-white' : 'bg-[#2b2b2b]'}`}
        title="Terminal"
        allow="clipboard-read; clipboard-write"
      />
    )
  },
)

TerminalFrame.displayName = 'TerminalFrame'
