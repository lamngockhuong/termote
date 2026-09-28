import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import { MAX_SCROLL_LINES, scrollPane } from '../hooks/use-mux-api'
import { type StreamControl, useTermSocket } from '../hooks/use-term-socket'
import {
  blockContextMenu,
  setTerminalFontFamily,
  setTerminalFontSize,
  setTerminalTheme,
  unblockContextMenu,
} from '../utils/terminal-bridge'
import { terminalFontFamily } from '../utils/terminal-font'
import type { ConnectionState } from './connection-indicator'

// What terminal-bridge drives. The object is stable for the component's
// lifetime; its fields always reflect the current terminal.
export interface TerminalHandle {
  readonly term: Terminal | null
  readonly element: HTMLElement | null
  // Element that scrolls horizontally when a server-sized pane is wider
  // than the screen.
  readonly scroller: HTMLElement | null
  readonly connectionState: ConnectionState
  // Backend has tmux copy mode.
  readonly copyModeSupported: boolean
  // Whether this terminal is in tmux copy mode.
  copyMode: boolean
  // Scrolls the pane's history through the backend, lines rows back
  // (negative: toward the live screen); false when the backend does not.
  scrollHistory: (lines: number) => boolean
  // Sends raw input; false when the stream is not open.
  send: (data: string) => boolean
  paste: (text: string) => void
  reconnect: () => void
}

interface Props {
  paneId?: string
  backend?: string
  // Reconnect when paneId changes (Caps.clientSideSelect).
  followPane?: boolean
  copyModeSupported?: boolean
  // The backend scrolls the pane's history (Caps.scroll): the stream only
  // carries screen renders, so the xterm.js scrollback stays empty.
  serverScroll?: boolean
  // Wrap pastes in bracketed-paste markers (herdr pane running an agent).
  bracketedPaste?: boolean
  fontSize?: number
  // Font installed on this device, tried before the default monospace fonts.
  fontFamily?: string
  theme?: 'light' | 'dark'
  disableContextMenu?: boolean
  onConnectionStateChange?: (state: ConnectionState) => void
}

export const THEMES = {
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

// Smallest font a server-sized pane is shrunk to; beyond that it scrolls.
export const MIN_FONT_SIZE = 6

// Replies xterm.js generates for terminal queries: device attributes
// (CSI ? … c, CSI > … c), cursor position (CSI row;col R) and focus
// reports (CSI I, CSI O). herdr answers queries itself, so any such reply
// typed into a herdr pane would show up as garbage at the prompt.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches escape sequences
const TERMINAL_REPLY = /\x1b\[[?>][\d;]*c|\x1b\[\d+;\d+R|\x1b\[[IO]/g

export function stripTerminalReplies(data: string): string {
  return data.replace(TERMINAL_REPLY, '')
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the paste end marker
const PASTE_END = /\x1b\[201~/g

export function bracketPaste(text: string): string {
  return `\x1b[200~${text.replace(PASTE_END, '')}\x1b[201~`
}

// Rows a wheel event scrolls into the history (negative: toward the live
// screen). Pixel deltas are counted in rows of rowHeight pixels.
export function wheelRows(
  ev: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  rowHeight: number,
  pageRows: number,
): number {
  if (ev.deltaMode === 1) return -ev.deltaY
  if (ev.deltaMode === 2) return -ev.deltaY * pageRows
  return -ev.deltaY / rowHeight
}

// Font size at which a cols×rows grid fits the space available at fontSize.
export function fitFontSize(
  fontSize: number,
  available: { cols: number; rows: number } | undefined,
  size: { cols: number; rows: number },
): number {
  if (!available?.cols || !available.rows) return fontSize
  const scale = Math.min(
    1,
    available.cols / size.cols,
    available.rows / size.rows,
  )
  return Math.max(MIN_FONT_SIZE, Math.floor(fontSize * scale))
}

export const TerminalView = forwardRef<TerminalHandle, Props>(
  (
    {
      paneId,
      backend = 'tmux',
      followPane = false,
      copyModeSupported = true,
      serverScroll = false,
      bracketedPaste = false,
      fontSize = 14,
      fontFamily = '',
      theme = 'dark',
      disableContextMenu = true,
      onConnectionStateChange,
    },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const scrollerRef = useRef<HTMLDivElement>(null)
    const termRef = useRef<Terminal | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    // Size fixed by the backend (herdr); while set, the client never resizes
    // the pane and only scales its font.
    const serverSizeRef = useRef<{ cols: number; rows: number } | null>(null)
    const fontSizeRef = useRef(fontSize)
    fontSizeRef.current = fontSize
    const fontFamilyRef = useRef(fontFamily)
    fontFamilyRef.current = fontFamily
    // herdr fixes the pane size and answers terminal queries itself.
    const isHerdr = backend === 'herdr'
    const isHerdrRef = useRef(isHerdr)
    isHerdrRef.current = isHerdr
    const copyModeRef = useRef(copyModeSupported)
    copyModeRef.current = copyModeSupported
    const bracketedRef = useRef(bracketedPaste)
    bracketedRef.current = bracketedPaste
    const serverScrollRef = useRef(serverScroll)
    serverScrollRef.current = serverScroll
    const paneIdRef = useRef(paneId)
    paneIdRef.current = paneId
    // Rows scrolled but not sent yet, and the pane they are for; one request
    // is in flight at a time, so a fast wheel does not queue one per event.
    const scrollPendingRef = useRef(0)
    const scrollPaneRef = useRef<string | undefined>(undefined)
    const scrollBusyRef = useRef(false)
    // The view may be above the live screen; the next input returns it.
    // The view is the backend's and outlives a stream, so a new stream starts
    // out assuming it is scrolled (returning costs nothing when it is not).
    const scrolledRef = useRef(true)
    // Fraction of a row left over from pixel wheel deltas.
    const wheelRestRef = useRef(0)

    const flushScroll = useCallback(async () => {
      if (scrollBusyRef.current) return
      scrollBusyRef.current = true
      try {
        while (scrollPendingRef.current !== 0) {
          const lines = Math.max(
            -MAX_SCROLL_LINES,
            Math.min(MAX_SCROLL_LINES, scrollPendingRef.current),
          )
          scrollPendingRef.current = 0
          const pane = scrollPaneRef.current
          if (pane) await scrollPane(pane, lines).catch(() => false)
        }
      } finally {
        scrollBusyRef.current = false
      }
    }, [])

    const scrollHistory = useCallback(
      (lines: number) => {
        if (!serverScrollRef.current) return false
        if (lines > 0) scrolledRef.current = true
        if (lines !== 0) {
          // Rows still pending for another pane are dropped, not moved.
          if (scrollPaneRef.current !== paneIdRef.current) {
            scrollPaneRef.current = paneIdRef.current
            scrollPendingRef.current = 0
          }
          scrollPendingRef.current += lines
          void flushScroll()
        }
        return true
      },
      [flushScroll],
    )

    // Input goes to the live screen, so show it again before sending any.
    const toLiveScreen = useCallback(() => {
      if (scrolledRef.current && serverScrollRef.current) {
        scrolledRef.current = false
        scrollHistory(-MAX_SCROLL_LINES)
      }
    }, [scrollHistory])

    const layout = useCallback(() => {
      const term = termRef.current
      const fit = fitRef.current
      /* v8 ignore next */
      if (!term || !fit) return
      const fixed = serverSizeRef.current
      if (!fixed) {
        fit.fit()
        return
      }
      term.options.fontSize = fontSizeRef.current
      term.options.fontSize = fitFontSize(
        fontSizeRef.current,
        fit.proposeDimensions(),
        fixed,
      )
      term.resize(fixed.cols, fixed.rows)
    }, [])

    const onControl = useCallback(
      (msg: StreamControl) => {
        const term = termRef.current
        /* v8 ignore next */
        if (!term) return
        if (msg.type === 'size') {
          serverSizeRef.current = { cols: msg.cols, rows: msg.rows }
          layout()
        } else if (msg.type === 'exit') {
          term.write('\r\n[process exited]\r\n')
        } else if (msg.type === 'error') {
          term.write(`\r\n[${msg.message ?? 'stream error'}]\r\n`)
        }
      },
      [layout],
    )

    const socket = useTermSocket({
      paneId,
      followPane,
      getSize: () => {
        const dims = fitRef.current?.proposeDimensions()
        return dims?.cols && dims.rows ? dims : null
      },
      onOutput: (data) => termRef.current?.write(data),
      onControl,
      onOpen: () => {
        const term = termRef.current
        /* v8 ignore next */
        if (!term) return
        // Every stream starts with a full redraw from the backend.
        term.reset()
        scrolledRef.current = true
        serverSizeRef.current = null
        layout()
        if (!isHerdrRef.current) {
          socket.sendResize({ cols: term.cols, rows: term.rows })
        }
      },
    })
    const socketRef = useRef(socket)
    socketRef.current = socket

    useEffect(() => {
      onConnectionStateChange?.(socket.state)
    }, [socket.state, onConnectionStateChange])

    // One stable handle; getters read the latest refs.
    const handleRef = useRef<TerminalHandle | null>(null)
    if (!handleRef.current) {
      handleRef.current = {
        get term() {
          return termRef.current
        },
        get element() {
          return containerRef.current
        },
        get scroller() {
          return scrollerRef.current
        },
        get connectionState() {
          return socketRef.current.state
        },
        get copyModeSupported() {
          return copyModeRef.current
        },
        copyMode: false,
        scrollHistory: (lines) => scrollHistory(lines),
        send: (data) => {
          toLiveScreen()
          return socketRef.current.send(data)
        },
        paste: (text) => {
          toLiveScreen()
          if (bracketedRef.current) {
            socketRef.current.send(bracketPaste(text))
          } else {
            termRef.current?.paste(text)
          }
        },
        reconnect: () => socketRef.current.reconnect(),
      }
    }
    useImperativeHandle(ref, () => handleRef.current!, [])

    // Create the terminal once.
    // biome-ignore lint/correctness/useExhaustiveDependencies: options are applied by the effects below
    useEffect(() => {
      const container = containerRef.current
      /* v8 ignore next */
      if (!container) return
      const term = new Terminal({
        fontSize: fontSizeRef.current,
        fontFamily: terminalFontFamily(fontFamilyRef.current),
        theme: THEMES[theme],
        cursorBlink: true,
        scrollback: 5000,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      termRef.current = term
      fitRef.current = fit
      layout()

      // With serverScroll the wheel scrolls the backend's history, unless the
      // program in the pane asked for mouse reports.
      term.attachCustomWheelEventHandler((ev) => {
        if (!serverScrollRef.current || term.modes.mouseTrackingMode !== 'none')
          return true
        const rowHeight = (term.options.fontSize ?? 14) * 1.2
        const rows = wheelRestRef.current + wheelRows(ev, rowHeight, term.rows)
        const whole = Math.trunc(rows)
        wheelRestRef.current = rows - whole
        scrollHistory(whole)
        return false
      })

      const subs = [
        term.onData((data) => {
          const out = isHerdrRef.current ? stripTerminalReplies(data) : data
          if (!out) return
          toLiveScreen()
          socketRef.current.send(out)
        }),
        // Non-UTF-8 input (legacy mouse reports) arrives as a binary string,
        // one char per byte.
        term.onBinary((data) => {
          socketRef.current.send(
            Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff),
          )
        }),
        term.onResize((size) => {
          if (!isHerdrRef.current) socketRef.current.sendResize(size)
        }),
      ]
      const observer = new ResizeObserver(() => layout())
      observer.observe(container)
      return () => {
        observer.disconnect()
        for (const s of subs) s.dispose()
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }
    }, [])

    useEffect(() => {
      setTerminalTheme(handleRef.current, THEMES[theme])
    }, [theme])

    useEffect(() => {
      setTerminalFontSize(handleRef.current, fontSize)
      layout()
    }, [fontSize, layout])

    // Another font changes the cell size, so the grid is fitted again.
    useEffect(() => {
      setTerminalFontFamily(handleRef.current, terminalFontFamily(fontFamily))
      layout()
    }, [fontFamily, layout])

    useEffect(() => {
      if (disableContextMenu) blockContextMenu(handleRef.current)
      else unblockContextMenu(handleRef.current)
    }, [disableContextMenu])

    const { state } = socket
    const failed = state === 'error' || state === 'disconnected'
    return (
      <div
        ref={scrollerRef}
        className={`relative flex-1 w-full h-full overflow-x-auto ${theme === 'light' ? 'bg-[#f6f8fa]' : 'bg-[#2b2b2b]'}`}
        // App blocks the context menu everywhere; let it through here when
        // the setting allows it.
        onContextMenu={
          disableContextMenu ? undefined : (e) => e.stopPropagation()
        }
      >
        <div
          ref={containerRef}
          data-testid="terminal-view"
          className="w-full h-full"
        />
        {failed && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center pointer-events-none">
            <button
              onClick={socket.reconnect}
              className="pointer-events-auto px-3 py-1 text-sm text-white bg-zinc-700/90 rounded hover:bg-zinc-600"
            >
              {state === 'error' ? 'Connection lost' : 'Disconnected'} —
              Reconnect
            </button>
          </div>
        )}
      </div>
    )
  },
)

TerminalView.displayName = 'TerminalView'
