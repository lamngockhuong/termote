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
import { DEFAULT_SIZE } from '../hooks/use-font-size'
import { MAX_SCROLL_LINES, scrollPane } from '../hooks/use-mux-api'
import { type StreamControl, useTermSocket } from '../hooks/use-term-socket'
import { readToken, type UiStyle } from '../ui-style'
import {
  blockContextMenu,
  setTerminalFontFamily,
  setTerminalFontSize,
  setTerminalTheme,
  terminalRowHeight,
  unblockContextMenu,
} from '../utils/terminal-bridge'
import { terminalFontFamily } from '../utils/terminal-font'
import type { ConnectionState } from './connection-indicator'
import { FOCUS_RING } from './ui/button'

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
  // Current UI style: a change re-reads the background token.
  uiStyle?: UiStyle
  disableContextMenu?: boolean
  // View-only role: the terminal shows the pane but sends nothing typed.
  readOnly?: boolean
  // herdr: size the pane to this terminal while the page is shown
  // (Caps.driveSize and the setting both on).
  driveSize?: boolean
  // Driving stopped without being asked: another device took over, or the
  // backend could not drive the size.
  onDriveLost?: (reason: 'taken-over' | 'failed') => void
  onConnectionStateChange?: (state: ConnectionState) => void
}

// Foreground colours reach WCAG AA (4.5:1) on the terminal background of every
// UI style (ANSI black stays black: programs use it as a background). On the
// light background the bright colours are darker than the normal ones, so they
// stay AA and still tell apart. The backgrounds here are the neutral style's,
// used when no token is readable.
export const THEMES = {
  light: {
    background: '#fcfcfd',
    foreground: '#24292e',
    cursor: '#24292e',
    cursorAccent: '#fcfcfd',
    selectionBackground: 'rgba(3, 102, 214, 0.3)',
    selectionForeground: '#24292e',
    black: '#24292e',
    red: '#d42d3d',
    green: '#208037',
    yellow: '#8c6c00',
    blue: '#0366d6',
    magenta: '#6f42c1',
    cyan: '#1b7c83',
    white: '#68707a',
    brightBlack: '#586069',
    brightRed: '#b11f2b',
    brightGreen: '#19682b',
    brightYellow: '#705805',
    brightBlue: '#0052b0',
    brightMagenta: '#582fa3',
    brightCyan: '#226475',
    brightWhite: '#545b63',
  },
  dark: {
    background: '#0c0c0e',
    foreground: '#d2d2d2',
    cursor: '#adadad',
    cursorAccent: '#0c0c0e',
    selectionBackground: 'rgba(255, 255, 255, 0.2)',
    selectionForeground: '#ffffff',
    black: '#000000',
    red: '#f22200',
    green: '#5ea702',
    yellow: '#cfae00',
    blue: '#457fba',
    magenta: '#95709a',
    cyan: '#00a7aa',
    white: '#dbded8',
    brightBlack: '#7b7d79',
    brightRed: '#f54235',
    brightGreen: '#99e343',
    brightYellow: '#fdeb61',
    brightBlue: '#84b0d8',
    brightMagenta: '#bc94b7',
    brightCyan: '#37e6e8',
    brightWhite: '#f1f1f0',
  },
}

// xterm.js needs a concrete colour, not var(): the background comes from the
// --tm-term-bg token of the current style and theme, the palette from THEMES.
// Without the stylesheet (tests) THEMES keeps its own background.
export function terminalTheme(theme: 'light' | 'dark') {
  const background = readToken('--tm-term-bg')
  if (!background) return THEMES[theme]
  return { ...THEMES[theme], background, cursorAccent: background }
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

// Font shown for a server-fixed grid: the chosen size counts zoom steps from
// the default, one pixel per step of 2, added to the size the grid fits at
// (base, measured at the default size). A scaled font would stick at the
// minimum for every step on a phone, where base is often already there.
export function zoomFontSize(base: number, chosen: number): number {
  return Math.max(MIN_FONT_SIZE, Math.floor(base + (chosen - DEFAULT_SIZE) / 2))
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
      uiStyle,
      disableContextMenu = true,
      readOnly = false,
      driveSize = false,
      onDriveLost,
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
    const readOnlyRef = useRef(readOnly)
    readOnlyRef.current = readOnly
    const driveSizeRef = useRef(driveSize)
    driveSizeRef.current = driveSize
    const onDriveLostRef = useRef(onDriveLost)
    onDriveLostRef.current = onDriveLost
    // This client drives the pane size: the server said so in its latest
    // size frame. Reset with every stream.
    const drivingRef = useRef(false)
    // Driving was lost (taken over or failed); not asked for again until the
    // page is shown again or the setting is turned on again.
    const driveLostRef = useRef(false)
    const wantsDrive = useCallback(
      () =>
        isHerdrRef.current &&
        driveSizeRef.current &&
        !driveLostRef.current &&
        document.visibilityState === 'visible',
      [],
    )
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
        // A fixed grid may have left a zoomed font behind.
        term.options.fontSize = fontSizeRef.current
        fit.fit()
        return
      }
      const chosen = fontSizeRef.current
      term.options.fontSize = DEFAULT_SIZE
      const base = fitFontSize(DEFAULT_SIZE, fit.proposeDimensions(), fixed)
      if (base < DEFAULT_SIZE) {
        term.options.fontSize = zoomFontSize(base, chosen)
      } else {
        // The grid fits at the default size (a large screen): the chosen
        // size applies as is, shrunk only as far as the grid needs.
        term.options.fontSize = chosen
        term.options.fontSize = fitFontSize(
          chosen,
          fit.proposeDimensions(),
          fixed,
        )
      }
      term.resize(fixed.cols, fixed.rows)
      // A grid still taller than the view (the font is at its minimum, e.g.
      // with the keyboard open) keeps its bottom rows, where the prompt is,
      // in view; the scroll clamps to 0 when the grid fits.
      requestAnimationFrame(() => {
        const el = scrollerRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
    }, [])

    const onControl = useCallback(
      (msg: StreamControl) => {
        const term = termRef.current
        /* v8 ignore next */
        if (!term) return
        if (msg.type === 'size') {
          drivingRef.current = !!msg.driving
          if (msg.reason) {
            driveLostRef.current = true
            // Shown again, the page asks again: nothing to tell then.
            if (document.visibilityState === 'visible') {
              onDriveLostRef.current?.(msg.reason)
            }
          } else if (isHerdrRef.current && !!msg.driving !== wantsDrive()) {
            // A request made while the socket was still opening was dropped,
            // or this frame is older than the latest request: ask again.
            socketRef.current.sendDrive(wantsDrive())
          }
          if (msg.driving) {
            // Sized like tmux: the chosen font, fitted, and sent once the
            // view has a size to fit.
            serverSizeRef.current = null
            layout()
            const dims = fitRef.current?.proposeDimensions()
            if (dims?.cols && dims.rows) {
              socketRef.current.sendResize({ cols: term.cols, rows: term.rows })
            }
            return
          }
          serverSizeRef.current = { cols: msg.cols, rows: msg.rows }
          layout()
        } else if (msg.type === 'exit') {
          term.write('\r\n[process exited]\r\n')
        } else if (msg.type === 'error') {
          term.write(`\r\n[${msg.message ?? 'stream error'}]\r\n`)
        }
      },
      [layout, wantsDrive],
    )

    const socket = useTermSocket({
      paneId,
      followPane,
      // The size the client would take, so measured at the chosen font,
      // not the zoomed one a fixed grid shows.
      getSize: () => {
        const term = termRef.current
        const fit = fitRef.current
        /* v8 ignore next */
        if (!term || !fit) return null
        const shown = term.options.fontSize
        if (shown !== fontSizeRef.current) {
          term.options.fontSize = fontSizeRef.current
        }
        const dims = fit.proposeDimensions()
        if (term.options.fontSize !== shown) term.options.fontSize = shown
        return dims?.cols && dims.rows ? dims : null
      },
      drive: () => wantsDrive(),
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
        // The old stream's mode does not carry over; wait for a size frame.
        drivingRef.current = false
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
        // View-only: every path that sends input (toolbar keys, tmux copy
        // mode scrolling, paste) stops here, not only xterm's own onData.
        send: (data) => {
          if (readOnlyRef.current) return false
          toLiveScreen()
          return socketRef.current.send(data)
        },
        paste: (text) => {
          if (readOnlyRef.current) return
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
        theme: terminalTheme(theme),
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
        const rows =
          wheelRestRef.current +
          wheelRows(ev, terminalRowHeight(term), term.rows)
        const whole = Math.trunc(rows)
        wheelRestRef.current = rows - whole
        scrollHistory(whole)
        return false
      })

      const subs = [
        term.onData((data) => {
          if (readOnlyRef.current) return
          const out = isHerdrRef.current ? stripTerminalReplies(data) : data
          if (!out) return
          toLiveScreen()
          socketRef.current.send(out)
        }),
        // Non-UTF-8 input (legacy mouse reports) arrives as a binary string,
        // one char per byte.
        term.onBinary((data) => {
          if (readOnlyRef.current) return
          socketRef.current.send(
            Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff),
          )
        }),
        term.onResize((size) => {
          if (!isHerdrRef.current || drivingRef.current) {
            socketRef.current.sendResize(size)
          }
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

    // biome-ignore lint/correctness/useExhaustiveDependencies: a new style changes the background token
    useEffect(() => {
      setTerminalTheme(handleRef.current, terminalTheme(theme))
    }, [theme, uiStyle])

    useEffect(() => {
      setTerminalFontSize(handleRef.current, fontSize)
      layout()
    }, [fontSize, layout])

    // Another font changes the cell size, so the grid is fitted again.
    useEffect(() => {
      setTerminalFontFamily(handleRef.current, terminalFontFamily(fontFamily))
      layout()
    }, [fontFamily, layout])

    // Drive the pane size while the setting is on and the page is shown;
    // give it back as soon as the page is hidden, so the desktop is not left
    // at this device's size. A stream opened while wanted asks with drive=1.
    const prevDriveRef = useRef(driveSize)
    useEffect(() => {
      if (!isHerdr) return
      const changed = prevDriveRef.current !== driveSize
      prevDriveRef.current = driveSize
      if (changed) {
        if (driveSize) driveLostRef.current = false
        socketRef.current.sendDrive(wantsDrive())
      }
      if (!driveSize) return
      const onVisibility = () => {
        if (document.visibilityState === 'visible') driveLostRef.current = false
        socketRef.current.sendDrive(wantsDrive())
      }
      const onPageHide = () => socketRef.current.sendDrive(false)
      // Back from the back/forward cache, where visibilitychange may not fire.
      const onPageShow = (e: PageTransitionEvent) => {
        if (!e.persisted) return
        driveLostRef.current = false
        socketRef.current.sendDrive(wantsDrive())
      }
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('pagehide', onPageHide)
      window.addEventListener('pageshow', onPageShow)
      return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('pagehide', onPageHide)
        window.removeEventListener('pageshow', onPageShow)
      }
    }, [driveSize, isHerdr, wantsDrive])

    // No cursor or keyboard focus for input that would go nowhere.
    useEffect(() => {
      const term = termRef.current
      /* v8 ignore next */
      if (!term) return
      term.options.disableStdin = readOnly
    }, [readOnly])

    useEffect(() => {
      if (disableContextMenu) blockContextMenu(handleRef.current)
      else unblockContextMenu(handleRef.current)
    }, [disableContextMenu])

    const { state } = socket
    const failed = state === 'error' || state === 'disconnected'
    return (
      <div
        ref={scrollerRef}
        className="relative flex-1 w-full h-full overflow-x-auto bg-term"
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
              className={`pointer-events-auto h-9 rounded-control border border-border bg-surface-raised px-3 text-sm text-fg shadow-lg hover:border-border-strong pointer-coarse:h-touch ${FOCUS_RING}`}
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
