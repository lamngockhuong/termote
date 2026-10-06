import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamControl, TermSize } from '../hooks/use-term-socket'
import { terminalFontFamily } from '../utils/terminal-font'
import {
  bracketPaste,
  fitFontSize,
  MIN_FONT_SIZE,
  RESIZE_SETTLE_MS,
  stripTerminalReplies,
  type TerminalHandle,
  TerminalView,
  THEMES,
  wheelRows,
  zoomFontSize,
} from './terminal-view'

type Listener<T> = (v: T) => void

// vi.mock factories run before module code, so the fakes are hoisted too.
const { FakeTerminal, FakeFit } = vi.hoisted(() => {
  // Fake xterm.js Terminal; the latest instance is kept for assertions.
  class FakeTerminal {
    static last: FakeTerminal
    options: {
      fontSize: number
      fontFamily?: string
      theme: unknown
      disableStdin?: boolean
      linkHandler?: { activate: (event: MouseEvent, uri: string) => void }
    }
    cols = 80
    rows = 24
    dataCb: Listener<string> = () => {}
    binaryCb: Listener<string> = () => {}
    wheelCb: (ev: Pick<WheelEvent, 'deltaY' | 'deltaMode'>) => boolean = () =>
      true
    modes = { mouseTrackingMode: 'none' }
    attachCustomWheelEventHandler = vi.fn(
      (cb: (ev: Pick<WheelEvent, 'deltaY' | 'deltaMode'>) => boolean) => {
        this.wheelCb = cb
      },
    )
    resizeCb: Listener<TermSize> = () => {}
    disposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = []
    write = vi.fn()
    paste = vi.fn()
    reset = vi.fn()
    resize = vi.fn()
    dispose = vi.fn()
    open = vi.fn()
    loadAddon = vi.fn()
    constructor(opts: {
      fontSize: number
      fontFamily?: string
      theme: unknown
      linkHandler?: { activate: (event: MouseEvent, uri: string) => void }
    }) {
      this.options = {
        fontSize: opts.fontSize,
        fontFamily: opts.fontFamily,
        theme: opts.theme,
        linkHandler: opts.linkHandler,
      }
      FakeTerminal.last = this
    }
    private sub<T>(set: (cb: Listener<T>) => void) {
      return (cb: Listener<T>) => {
        set(cb)
        const d = { dispose: vi.fn() }
        this.disposables.push(d)
        return d
      }
    }
    onData = this.sub<string>((cb) => (this.dataCb = cb))
    onBinary = this.sub<string>((cb) => (this.binaryCb = cb))
    onResize = this.sub<TermSize>((cb) => (this.resizeCb = cb))
  }

  class FakeFit {
    static last: FakeFit
    fit = vi.fn()
    // Space for the grid, in pixels; the fitted size depends on the font
    // the terminal has when measured (100x50 at 14px), as xterm's does.
    static space = { width: 840, height: 840 }
    proposeDimensions = vi.fn<() => TermSize | undefined>(() => {
      const font = FakeTerminal.last.options.fontSize
      return {
        cols: Math.floor(FakeFit.space.width / (font * 0.6)),
        rows: Math.floor(FakeFit.space.height / (font * 1.2)),
      }
    })
    constructor() {
      FakeFit.last = this
    }
  }

  return { FakeTerminal, FakeFit }
})

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeFit }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const muxApi = vi.hoisted(() => ({
  MAX_SCROLL_LINES: 10000,
  scrollPane: vi.fn(async () => true),
}))
vi.mock('../hooks/use-mux-api', () => muxApi)

interface SocketOpts {
  paneId?: string
  followPane: boolean
  streamKey?: string
  paneSeen?: unknown
  getSize: () => TermSize | null
  drive?: () => boolean
  onOutput: (d: Uint8Array) => void
  onControl: (m: StreamControl) => void
  onOpen: () => void
}
let socketOpts: SocketOpts
const socket = {
  state: 'connected' as string,
  send: vi.fn(() => true),
  sendResize: vi.fn(),
  sendDrive: vi.fn(),
  reconnect: vi.fn(),
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}
vi.mock('../hooks/use-term-socket', () => ({
  useTermSocket: (opts: SocketOpts) => {
    socketOpts = opts
    return socket
  },
}))

const bridge = vi.hoisted(() => ({
  blockContextMenu: vi.fn(),
  unblockContextMenu: vi.fn(),
  setTerminalFontFamily: vi.fn(),
  setTerminalFontSize: vi.fn(),
  setTerminalTheme: vi.fn(),
  terminalRowHeight: (term: { options: { fontSize?: number } }) =>
    (term.options.fontSize ?? 14) * 1.2,
}))
vi.mock('../utils/terminal-bridge', () => bridge)

let resizeObserverCb: () => void
// The observer fits the terminal once the size settles.
function resize() {
  vi.useFakeTimers()
  act(() => {
    resizeObserverCb()
    vi.advanceTimersByTime(RESIZE_SETTLE_MS)
  })
  vi.useRealTimers()
}
const observerDisconnect = vi.fn()
class FakeResizeObserver {
  constructor(cb: () => void) {
    resizeObserverCb = cb
  }
  observe = vi.fn()
  disconnect = observerDisconnect
}

function renderView(
  props: Partial<React.ComponentProps<typeof TerminalView>> = {},
) {
  const ref = createRef<TerminalHandle>()
  const view = render(<TerminalView ref={ref} paneId="0" {...props} />)
  return { ...view, ref, term: FakeTerminal.last, fit: FakeFit.last }
}

describe('stripTerminalReplies', () => {
  it('removes DA, DSR and focus replies and keeps typed text', () => {
    expect(
      stripTerminalReplies(
        'a\x1b[?1;2cb\x1b[>0;276;0cc\x1b[12;40Rd\x1b[Ie\x1b[Of',
      ),
    ).toBe('abcdef')
    expect(stripTerminalReplies('\x1b[A')).toBe('\x1b[A')
  })
})

describe('bracketPaste', () => {
  it('wraps text and drops an embedded end marker', () => {
    expect(bracketPaste('a\x1b[201~b\n')).toBe('\x1b[200~ab\n\x1b[201~')
  })

  it('cannot be escaped by an end marker nested in another', () => {
    const out = bracketPaste('x\x1b[20\x1b[201~1~\r!rm -rf ~\r')
    expect(out).toBe('\x1b[200~x[201~\r!rm -rf ~\r\x1b[201~')
    // Only the closing marker is left, at the very end.
    expect(out.indexOf('\x1b[201~')).toBe(out.length - 6)
  })

  it('drops control characters but keeps tabs and line breaks', () => {
    expect(bracketPaste('a\tb\r\nc\x03\x7f\x9bd\x1b')).toBe(
      '\x1b[200~a\tb\r\ncd\x1b[201~',
    )
  })
})

describe('wheelRows', () => {
  it('counts rows back into the history from each delta mode', () => {
    expect(wheelRows({ deltaY: -100, deltaMode: 0 }, 20, 40)).toBe(5)
    expect(wheelRows({ deltaY: 3, deltaMode: 1 }, 20, 40)).toBe(-3)
    expect(wheelRows({ deltaY: -1, deltaMode: 2 }, 20, 40)).toBe(40)
  })
})

describe('fitFontSize', () => {
  it('shrinks to fit, never grows, and stops at the minimum', () => {
    expect(
      fitFontSize(14, { cols: 76, rows: 40 }, { cols: 152, rows: 41 }),
    ).toBe(7)
    expect(
      fitFontSize(14, { cols: 200, rows: 80 }, { cols: 80, rows: 24 }),
    ).toBe(14)
    expect(
      fitFontSize(14, { cols: 10, rows: 5 }, { cols: 152, rows: 41 }),
    ).toBe(MIN_FONT_SIZE)
  })

  it('keeps the font when the available space is unknown', () => {
    expect(fitFontSize(14, undefined, { cols: 80, rows: 24 })).toBe(14)
    expect(fitFontSize(14, { cols: 0, rows: 10 }, { cols: 80, rows: 24 })).toBe(
      14,
    )
    expect(fitFontSize(14, { cols: 10, rows: 0 }, { cols: 80, rows: 24 })).toBe(
      14,
    )
  })
})

describe('zoomFontSize', () => {
  it('adds one pixel per step of 2 from the default size', () => {
    // A phone with a wide pane: base already at the minimum
    expect(zoomFontSize(6, 14)).toBe(6)
    expect(zoomFontSize(6, 16)).toBe(7)
    expect(zoomFontSize(6, 18)).toBe(8)
    expect(zoomFontSize(6, 12)).toBe(6)
    expect(zoomFontSize(12, 14)).toBe(12)
    expect(zoomFontSize(12, 16)).toBe(13)
    expect(zoomFontSize(12, 10)).toBe(10)
  })

  it('never goes under the minimum, and rounds an odd saved size down', () => {
    expect(zoomFontSize(7, 6)).toBe(MIN_FONT_SIZE)
    expect(zoomFontSize(12, 15)).toBe(12)
  })
})

describe('TerminalView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeFit.space = { width: 840, height: 840 }
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    socket.state = 'connected'
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  it('creates the terminal with the font and theme, then fits it', () => {
    const { term, fit } = renderView({ fontSize: 16, theme: 'light' })
    expect(term.options.fontSize).toBe(16)
    expect(term.options.theme).toBe(THEMES.light)
    expect(term.loadAddon).toHaveBeenCalledWith(fit)
    expect(term.open).toHaveBeenCalledWith(screen.getByTestId('terminal-view'))
    expect(fit.fit).toHaveBeenCalled()
  })

  it('opens only http(s) links the output printed, cut off from this tab', () => {
    const { term } = renderView()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const activate = (uri: string) =>
      term.options.linkHandler?.activate(new MouseEvent('click'), uri)
    activate('javascript:alert(1)')
    activate('data:text/html,<script>alert(1)</script>')
    activate('file:///etc/passwd')
    expect(open).not.toHaveBeenCalled()
    activate('https://example.com/a?b=1')
    expect(open).toHaveBeenCalledWith(
      'https://example.com/a?b=1',
      '_blank',
      'noopener,noreferrer',
    )
    open.mockRestore()
  })

  it('fits once after the container stops resizing', () => {
    vi.useFakeTimers()
    try {
      const { fit } = renderView()
      fit.fit.mockClear()
      // An animated resize reports a new size at every frame.
      for (let i = 0; i < 10; i++) {
        resizeObserverCb()
        vi.advanceTimersByTime(16)
      }
      expect(fit.fit).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(RESIZE_SETTLE_MS))
      expect(fit.fit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps its size while another view covers it, and fits once shown again', () => {
    vi.useFakeTimers()
    try {
      const { fit, rerender, ref } = renderView({ covered: true })
      fit.fit.mockClear()
      // The view's input area grows and shrinks below the terminal
      for (let i = 0; i < 3; i++) {
        resizeObserverCb()
        vi.advanceTimersByTime(RESIZE_SETTLE_MS)
      }
      expect(fit.fit).not.toHaveBeenCalled()
      rerender(<TerminalView ref={ref} paneId="0" covered={false} />)
      expect(fit.fit).toHaveBeenCalledTimes(1)
      // Shown, it follows its container again
      resizeObserverCb()
      act(() => vi.advanceTimersByTime(RESIZE_SETTLE_MS))
      expect(fit.fit).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a covered terminal keeps its size when its stream opens again or its font changes', () => {
    const { fit, rerender, ref } = renderView()
    rerender(<TerminalView ref={ref} paneId="0" covered />)
    fit.fit.mockClear()
    rerender(<TerminalView ref={ref} paneId="0" covered fontSize={18} />)
    act(() => socketOpts.onOpen())
    expect(fit.fit).not.toHaveBeenCalled()
    rerender(<TerminalView ref={ref} paneId="0" fontSize={18} />)
    expect(fit.fit).toHaveBeenCalled()
  })

  it('drops a pending fit on unmount', () => {
    vi.useFakeTimers()
    try {
      const { fit, unmount } = renderView()
      fit.fit.mockClear()
      resizeObserverCb()
      unmount()
      vi.advanceTimersByTime(RESIZE_SETTLE_MS)
      expect(fit.fit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes pane and followPane to the socket', () => {
    renderView({ paneId: 'w1:p2', followPane: true })
    expect(socketOpts.paneId).toBe('w1:p2')
    expect(socketOpts.followPane).toBe(true)
  })

  it('passes the stream key and pane listing to the socket', () => {
    const seen = {}
    renderView({ paneId: '$3:0', streamKey: '$3', paneSeen: seen })
    expect(socketOpts.streamKey).toBe('$3')
    expect(socketOpts.paneSeen).toBe(seen)
  })

  it('asks for the fitted size, or none when it is unknown', () => {
    const { fit } = renderView()
    expect(socketOpts.getSize()).toEqual({ cols: 100, rows: 50 })
    fit.proposeDimensions.mockReturnValue(undefined)
    expect(socketOpts.getSize()).toBeNull()
    fit.proposeDimensions.mockReturnValue({ cols: 0, rows: 10 })
    expect(socketOpts.getSize()).toBeNull()
  })

  it('writes stream output to the terminal', () => {
    const { term } = renderView()
    const bytes = new Uint8Array([104, 105])
    socketOpts.onOutput(bytes)
    expect(term.write).toHaveBeenCalledWith(bytes)
  })

  it('tmux: resets and sends its size on open and on resize', () => {
    const { term } = renderView()
    socketOpts.onOpen()
    expect(term.reset).toHaveBeenCalled()
    expect(socket.sendResize).toHaveBeenCalledWith({ cols: 80, rows: 24 })
    term.resizeCb({ cols: 90, rows: 30 })
    expect(socket.sendResize).toHaveBeenLastCalledWith({ cols: 90, rows: 30 })
  })

  it('tmux: forwards typed data and query replies unchanged', () => {
    const { term } = renderView()
    term.dataCb('ls\x1b[?1;2c')
    expect(socket.send).toHaveBeenCalledWith('ls\x1b[?1;2c')
  })

  it('herdr: strips query replies and drops input that was only replies', () => {
    const { term } = renderView({ backend: 'herdr' })
    term.dataCb('x\x1b[>0;276;0c')
    expect(socket.send).toHaveBeenCalledWith('x')
    socket.send.mockClear()
    term.dataCb('\x1b[12;40R')
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('serverScroll: the wheel scrolls the pane history through the backend', async () => {
    const { term, ref } = renderView({
      backend: 'herdr',
      paneId: 'w1:p2',
      serverScroll: true,
      fontSize: 10, // 12px rows
    })
    // Wheel up two rows and a half, then the half left over.
    expect(term.wheelCb({ deltaY: -30, deltaMode: 0 })).toBe(false)
    await act(async () => {})
    expect(muxApi.scrollPane).toHaveBeenLastCalledWith('w1:p2', 2)
    term.wheelCb({ deltaY: -6, deltaMode: 0 })
    await act(async () => {})
    expect(muxApi.scrollPane).toHaveBeenLastCalledWith('w1:p2', 1)

    // Typing returns to the live screen before the input is sent, once.
    muxApi.scrollPane.mockClear()
    term.dataCb('x')
    await act(async () => {})
    expect(muxApi.scrollPane).toHaveBeenCalledWith('w1:p2', -10000)
    expect(socket.send).toHaveBeenCalledWith('x')
    term.dataCb('y')
    await act(async () => {})
    expect(muxApi.scrollPane).toHaveBeenCalledTimes(1)

    // So do toolbar keys and pastes, which go through the handle.
    for (const input of [
      () => ref.current!.send('\r'),
      () => ref.current!.paste('ls'),
    ]) {
      ref.current!.scrollHistory(3)
      await act(async () => {})
      muxApi.scrollPane.mockClear()
      input()
      await act(async () => {})
      expect(muxApi.scrollPane).toHaveBeenCalledWith('w1:p2', -10000)
    }

    // A program that asked for mouse reports gets the wheel itself.
    term.modes.mouseTrackingMode = 'vt200'
    expect(term.wheelCb({ deltaY: -30, deltaMode: 0 })).toBe(true)
    expect(ref.current!.scrollHistory(5)).toBe(true)
  })

  it('serverScroll: a new stream may show a view scrolled earlier, so input returns it', async () => {
    const { term } = renderView({ paneId: 'w1:p2', serverScroll: true })
    act(() => socketOpts.onOpen())
    term.dataCb('x')
    await act(async () => {})
    expect(muxApi.scrollPane).toHaveBeenCalledWith('w1:p2', -10000)
  })

  it('serverScroll: rows pending for a pane are not sent to the next one', async () => {
    let finish: () => void = () => {}
    muxApi.scrollPane.mockImplementationOnce(
      () => new Promise<boolean>((r) => (finish = () => r(true))),
    )
    const { ref, rerender } = renderView({
      paneId: 'w1:p2',
      serverScroll: true,
    })
    ref.current!.scrollHistory(5)
    ref.current!.scrollHistory(4) // pending for w1:p2
    rerender(<TerminalView ref={ref} paneId="w1:p3" serverScroll />)
    ref.current!.scrollHistory(2)
    await act(async () => finish())
    expect(muxApi.scrollPane.mock.calls).toEqual([
      ['w1:p2', 5],
      ['w1:p3', 2],
    ])
  })

  it('serverScroll: merges rows scrolled while a request is in flight', async () => {
    let finish: () => void = () => {}
    muxApi.scrollPane.mockImplementationOnce(
      () => new Promise<boolean>((r) => (finish = () => r(true))),
    )
    const { ref } = renderView({ paneId: 'w1:p2', serverScroll: true })
    ref.current!.scrollHistory(5)
    ref.current!.scrollHistory(5)
    ref.current!.scrollHistory(-3)
    expect(muxApi.scrollPane).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(muxApi.scrollPane).toHaveBeenCalledTimes(2)
    expect(muxApi.scrollPane).toHaveBeenLastCalledWith('w1:p2', 2)
  })

  it('serverScroll: skips partial rows, a failed request and a pane-less view', async () => {
    const { term, ref, rerender } = renderView({
      paneId: 'w1:p2',
      serverScroll: true,
    })
    // Less than a row (default 14px font when none is set): nothing to send.
    term.options.fontSize = undefined as unknown as number
    expect(term.wheelCb({ deltaY: -5, deltaMode: 0 })).toBe(false)
    expect(muxApi.scrollPane).not.toHaveBeenCalled()

    // A failed request does not stop the next one.
    muxApi.scrollPane.mockRejectedValueOnce(new Error('down'))
    ref.current!.scrollHistory(3)
    await act(async () => {})
    ref.current!.scrollHistory(2)
    await act(async () => {})
    expect(muxApi.scrollPane).toHaveBeenLastCalledWith('w1:p2', 2)

    muxApi.scrollPane.mockClear()
    rerender(<TerminalView ref={ref} serverScroll />)
    expect(ref.current!.scrollHistory(3)).toBe(true)
    await act(async () => {})
    expect(muxApi.scrollPane).not.toHaveBeenCalled()
  })

  it('without serverScroll leaves the wheel and scrolling to xterm.js', () => {
    const { term, ref } = renderView({ backend: 'herdr' })
    expect(term.wheelCb({ deltaY: -30, deltaMode: 0 })).toBe(true)
    expect(ref.current!.scrollHistory(5)).toBe(false)
    term.dataCb('x')
    expect(muxApi.scrollPane).not.toHaveBeenCalled()
  })

  it('sends binary input byte for byte', () => {
    const { term } = renderView()
    term.binaryCb('\x1b[M\xff!')
    expect(socket.send).toHaveBeenCalledWith(
      new Uint8Array([0x1b, 0x5b, 0x4d, 0xff, 0x21]),
    )
  })

  it('readOnly sends nothing typed and disables stdin', () => {
    const { term, rerender, ref } = renderView({ readOnly: true })
    expect(term.options.disableStdin).toBe(true)
    term.dataCb('x')
    term.binaryCb('\x1b[M\xff!')
    expect(socket.send).not.toHaveBeenCalled()
    // Toolbar keys, tmux copy-mode scrolling and paste go through the handle
    expect(ref.current!.send('\x1b[5~')).toBe(false)
    ref.current!.paste('rm -rf')
    expect(socket.send).not.toHaveBeenCalled()
    expect(term.paste).not.toHaveBeenCalled()
    rerender(<TerminalView ref={ref} paneId="0" />)
    expect(term.options.disableStdin).toBe(false)
    term.dataCb('y')
    expect(socket.send).toHaveBeenCalledWith('y')
  })

  it('herdr: never sends a resize and follows the server size', () => {
    const { term, fit } = renderView({ backend: 'herdr', fontSize: 14 })
    socketOpts.onOpen()
    term.resizeCb({ cols: 90, rows: 30 })
    expect(socket.sendResize).not.toHaveBeenCalled()

    // Room for 76x40 at 14px; the pane is 152x41 → half the font
    fit.proposeDimensions.mockReturnValue({ cols: 76, rows: 40 })
    fit.fit.mockClear()
    act(() => socketOpts.onControl({ type: 'size', cols: 152, rows: 41 }))
    expect(term.resize).toHaveBeenCalledWith(152, 41)
    expect(term.options.fontSize).toBe(7)
    expect(fit.fit).not.toHaveBeenCalled()

    // Container resize keeps the server size
    term.resize.mockClear()
    fit.proposeDimensions.mockReturnValue({ cols: 200, rows: 80 })
    resize()
    expect(term.resize).toHaveBeenCalledWith(152, 41)
    expect(term.options.fontSize).toBe(14)

    // A new stream drops the old server size until the next size frame
    socketOpts.onOpen()
    resize()
    expect(fit.fit).toHaveBeenCalled()
  })

  it('herdr: a grid taller than the view keeps its bottom rows in view', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    renderView({ backend: 'herdr', fontSize: 6 })
    const scroller = screen.getByTestId('terminal-view').parentElement!
    Object.defineProperty(scroller, 'scrollHeight', { value: 900 })
    act(() => socketOpts.onControl({ type: 'size', cols: 152, rows: 41 }))
    expect(scroller.scrollTop).toBe(900)
  })

  it('herdr: the font zooms the fixed grid from the size it fits at 14px', () => {
    // Room for 76x40 at 14px, so a 152x41 pane fits at 7px
    FakeFit.space = { width: 76 * 8.4, height: 40 * 16.8 }
    const { term, rerender, ref } = renderView({
      backend: 'herdr',
      fontSize: 14,
    })
    act(() => socketOpts.onControl({ type: 'size', cols: 152, rows: 41 }))
    expect(term.options.fontSize).toBe(7)

    rerender(
      <TerminalView ref={ref} paneId="0" backend="herdr" fontSize={20} />,
    )
    expect(term.options.fontSize).toBe(10)
    expect(term.resize).toHaveBeenLastCalledWith(152, 41)

    rerender(
      <TerminalView ref={ref} paneId="0" backend="herdr" fontSize={10} />,
    )
    expect(term.options.fontSize).toBe(MIN_FONT_SIZE)
  })

  it('herdr: a grid that fits at 14px takes the chosen font, shrunk to fit', () => {
    // Room for 100x50 at 14px; the pane is 80x24
    const { term, rerender, ref } = renderView({
      backend: 'herdr',
      fontSize: 6,
    })
    act(() => socketOpts.onControl({ type: 'size', cols: 80, rows: 24 }))
    expect(term.options.fontSize).toBe(6)

    // 24px would leave room for 58x29: shrunk to 80 columns
    rerender(
      <TerminalView ref={ref} paneId="0" backend="herdr" fontSize={24} />,
    )
    expect(term.options.fontSize).toBe(17)
    expect(term.resize).toHaveBeenLastCalledWith(80, 24)
  })

  it('an unfixed grid goes back to the chosen font after a fixed one', () => {
    FakeFit.space = { width: 76 * 8.4, height: 40 * 16.8 }
    const { term, fit } = renderView({ backend: 'herdr', fontSize: 16 })
    act(() => socketOpts.onControl({ type: 'size', cols: 152, rows: 41 }))
    expect(term.options.fontSize).toBe(8)

    // A new stream drops the fixed size
    fit.fit.mockClear()
    act(() => socketOpts.onOpen())
    expect(term.options.fontSize).toBe(16)
    expect(fit.fit).toHaveBeenCalled()
  })

  it('asks for the size at the chosen font, not the zoomed one', () => {
    FakeFit.space = { width: 76 * 8.4, height: 40 * 16.8 }
    const { term } = renderView({ backend: 'herdr', fontSize: 14 })
    act(() => socketOpts.onControl({ type: 'size', cols: 152, rows: 41 }))
    expect(term.options.fontSize).toBe(7)
    // At 7px it would be 152x80
    expect(socketOpts.getSize()).toEqual({ cols: 76, rows: 40 })
    expect(term.options.fontSize).toBe(7)
  })

  describe('herdr drive', () => {
    // fit.fit sizes the grid from the space at the current font, as xterm's.
    function renderDriving(
      props: Partial<React.ComponentProps<typeof TerminalView>> = {},
    ) {
      const r = renderView({ backend: 'herdr', driveSize: true, ...props })
      r.fit.fit.mockImplementation(() => {
        const d = r.fit.proposeDimensions()!
        r.term.cols = d.cols
        r.term.rows = d.rows
      })
      return r
    }

    it('asks to drive while shown, and gives the size back when hidden', () => {
      renderDriving()
      expect(socketOpts.drive?.()).toBe(true)
      // Nothing changed yet: the stream asks with drive=1 itself
      expect(socket.sendDrive).not.toHaveBeenCalled()

      act(() => setVisibility('hidden'))
      expect(socket.sendDrive).toHaveBeenLastCalledWith(false)
      expect(socketOpts.drive?.()).toBe(false)
      act(() => setVisibility('visible'))
      expect(socket.sendDrive).toHaveBeenLastCalledWith(true)
      act(() => {
        window.dispatchEvent(new Event('pagehide'))
      })
      expect(socket.sendDrive).toHaveBeenLastCalledWith(false)
    })

    it('follows the setting being turned off and on', () => {
      const { rerender, ref } = renderDriving()
      rerender(
        <TerminalView ref={ref} paneId="0" backend="herdr" driveSize={false} />,
      )
      expect(socket.sendDrive).toHaveBeenLastCalledWith(false)
      expect(socketOpts.drive?.()).toBe(false)
      // Hidden while off: nothing sent
      socket.sendDrive.mockClear()
      act(() => setVisibility('hidden'))
      act(() => setVisibility('visible'))
      expect(socket.sendDrive).not.toHaveBeenCalled()
      rerender(<TerminalView ref={ref} paneId="0" backend="herdr" driveSize />)
      expect(socket.sendDrive).toHaveBeenLastCalledWith(true)
    })

    it('sizes the terminal like tmux once the server says it drives', () => {
      FakeFit.space = { width: 76 * 8.4, height: 40 * 16.8 }
      const { term } = renderDriving({ fontSize: 14 })
      act(() => socketOpts.onOpen())
      // Desktop size first: shrunk to fit
      act(() => socketOpts.onControl({ type: 'size', cols: 152, rows: 41 }))
      expect(term.options.fontSize).toBe(7)
      expect(socket.sendResize).not.toHaveBeenCalled()

      act(() =>
        socketOpts.onControl({
          type: 'size',
          cols: 76,
          rows: 40,
          driving: true,
        }),
      )
      expect(term.options.fontSize).toBe(14)
      expect(socket.sendResize).toHaveBeenLastCalledWith({ cols: 76, rows: 40 })
      // Its own resizes now reach the pane
      term.resizeCb({ cols: 70, rows: 30 })
      expect(socket.sendResize).toHaveBeenLastCalledWith({ cols: 70, rows: 30 })

      // A later frame without driving wins: the desktop size again
      socket.sendResize.mockClear()
      act(() => socketOpts.onControl({ type: 'size', cols: 152, rows: 41 }))
      expect(term.resize).toHaveBeenLastCalledWith(152, 41)
      term.resizeCb({ cols: 70, rows: 30 })
      expect(socket.sendResize).not.toHaveBeenCalled()
    })

    it('a new stream starts out not driving', () => {
      const { term } = renderDriving()
      act(() =>
        socketOpts.onControl({
          type: 'size',
          cols: 100,
          rows: 50,
          driving: true,
        }),
      )
      socket.sendResize.mockClear()
      act(() => socketOpts.onOpen())
      term.resizeCb({ cols: 90, rows: 30 })
      expect(socket.sendResize).not.toHaveBeenCalled()
    })

    it.each([['taken-over' as const], ['failed' as const]])(
      'stops asking after %s until shown again',
      (reason) => {
        const onDriveLost = vi.fn()
        renderDriving({ onDriveLost })
        act(() =>
          socketOpts.onControl({
            type: 'size',
            cols: 100,
            rows: 50,
            driving: true,
          }),
        )
        act(() =>
          socketOpts.onControl({ type: 'size', cols: 152, rows: 41, reason }),
        )
        expect(onDriveLost).toHaveBeenCalledWith(reason)
        expect(socketOpts.drive?.()).toBe(false)

        // Hidden: gives it back; shown again: asks again
        act(() => setVisibility('hidden'))
        expect(socket.sendDrive).toHaveBeenLastCalledWith(false)
        act(() => setVisibility('visible'))
        expect(socket.sendDrive).toHaveBeenLastCalledWith(true)
        expect(socketOpts.drive?.()).toBe(true)
      },
    )

    it('turning the setting on again clears a takeover', () => {
      const { rerender, ref } = renderDriving()
      act(() =>
        socketOpts.onControl({
          type: 'size',
          cols: 152,
          rows: 41,
          reason: 'taken-over',
        }),
      )
      rerender(
        <TerminalView ref={ref} paneId="0" backend="herdr" driveSize={false} />,
      )
      rerender(<TerminalView ref={ref} paneId="0" backend="herdr" driveSize />)
      expect(socket.sendDrive).toHaveBeenLastCalledWith(true)
    })

    it('asks again when a size frame disagrees with what is wanted', () => {
      const { rerender, ref } = renderDriving()
      // Opened driving, then the switch went off before the socket was open
      rerender(
        <TerminalView ref={ref} paneId="0" backend="herdr" driveSize={false} />,
      )
      socket.sendDrive.mockClear()
      act(() =>
        socketOpts.onControl({
          type: 'size',
          cols: 100,
          rows: 50,
          driving: true,
        }),
      )
      expect(socket.sendDrive).toHaveBeenLastCalledWith(false)
      // Agreeing frames send nothing
      socket.sendDrive.mockClear()
      act(() => socketOpts.onControl({ type: 'size', cols: 152, rows: 41 }))
      expect(socket.sendDrive).not.toHaveBeenCalled()
    })

    it('does not send a size the view cannot fit yet', () => {
      const { fit } = renderDriving()
      fit.proposeDimensions.mockReturnValue(undefined)
      fit.fit.mockImplementation(() => {})
      act(() =>
        socketOpts.onControl({
          type: 'size',
          cols: 100,
          rows: 50,
          driving: true,
        }),
      )
      expect(socket.sendResize).not.toHaveBeenCalled()
    })

    it('a takeover seen while hidden shows no toast', () => {
      const onDriveLost = vi.fn()
      renderDriving({ onDriveLost })
      act(() => setVisibility('hidden'))
      act(() =>
        socketOpts.onControl({
          type: 'size',
          cols: 152,
          rows: 41,
          reason: 'taken-over',
        }),
      )
      expect(onDriveLost).not.toHaveBeenCalled()
    })

    it('asks again when restored from the back/forward cache', () => {
      renderDriving()
      act(() =>
        socketOpts.onControl({
          type: 'size',
          cols: 152,
          rows: 41,
          reason: 'taken-over',
        }),
      )
      socket.sendDrive.mockClear()
      act(() => {
        window.dispatchEvent(
          new PageTransitionEvent('pageshow', { persisted: false }),
        )
      })
      expect(socket.sendDrive).not.toHaveBeenCalled()
      act(() => {
        window.dispatchEvent(
          new PageTransitionEvent('pageshow', { persisted: true }),
        )
      })
      expect(socket.sendDrive).toHaveBeenLastCalledWith(true)
    })

    it('tmux never drives', () => {
      renderView({ driveSize: true })
      expect(socketOpts.drive?.()).toBe(false)
      act(() => setVisibility('hidden'))
      act(() => setVisibility('visible'))
      expect(socket.sendDrive).not.toHaveBeenCalled()
    })
  })

  it('reports exit and errors in the terminal', () => {
    const { term } = renderView()
    socketOpts.onControl({ type: 'exit', code: 0 })
    expect(term.write).toHaveBeenLastCalledWith('\r\n[process exited]\r\n')
    socketOpts.onControl({ type: 'error', message: 'too many streams' })
    expect(term.write).toHaveBeenLastCalledWith('\r\n[too many streams]\r\n')
    socketOpts.onControl({ type: 'error' })
    expect(term.write).toHaveBeenLastCalledWith('\r\n[stream error]\r\n')
    socketOpts.onControl({ type: 'other' } as unknown as StreamControl)
    expect(term.write).toHaveBeenCalledTimes(3)
  })

  it('exposes a stable handle reflecting the current terminal', () => {
    const { ref, term, rerender } = renderView({ copyModeSupported: false })
    const handle = ref.current!
    expect(handle.term).toBe(term)
    expect(handle.element).toBe(screen.getByTestId('terminal-view'))
    expect(handle.scroller).toBe(
      screen.getByTestId('terminal-view').parentElement,
    )
    expect(handle.connectionState).toBe('connected')
    expect(handle.copyModeSupported).toBe(false)
    expect(handle.copyMode).toBe(false)
    expect(handle.send('a')).toBe(true)
    expect(socket.send).toHaveBeenCalledWith('a')
    handle.reconnect()
    expect(socket.reconnect).toHaveBeenCalled()

    rerender(<TerminalView ref={ref} paneId="0" copyModeSupported />)
    expect(ref.current).toBe(handle)
    expect(handle.copyModeSupported).toBe(true)
  })

  it('pastes through xterm, or bracketed when asked', () => {
    const { ref, term, rerender } = renderView()
    expect(ref.current!.paste('a\nb')).toBe(true)
    expect(term.paste).toHaveBeenCalledWith('a\nb')
    expect(socket.send).not.toHaveBeenCalled()

    rerender(<TerminalView ref={ref} paneId="0" bracketedPaste />)
    expect(ref.current!.paste('a\nb')).toBe(true)
    expect(socket.send).toHaveBeenCalledWith('\x1b[200~a\nb\x1b[201~')
  })

  // xterm brackets a paste without removing an end marker inside it: the
  // rest would reach the program as typed keys.
  it('pastes through xterm without control characters', () => {
    const { ref, term } = renderView()
    expect(ref.current!.paste('a\x1b[201~\r!id\r\tb\x03\x9b')).toBe(true)
    expect(term.paste).toHaveBeenCalledWith('a\r!id\r\tb')
  })

  it('reports a paste that could not go out', () => {
    const { ref, term, rerender } = renderView()
    socket.state = 'disconnected'
    try {
      expect(ref.current!.paste('x')).toBe(false)
      expect(term.paste).not.toHaveBeenCalled()
      rerender(<TerminalView ref={ref} paneId="0" bracketedPaste />)
      socket.send.mockReturnValueOnce(false)
      expect(ref.current!.paste('x')).toBe(false)
    } finally {
      socket.state = 'connected'
    }
  })

  describe('paste event', () => {
    const image = new File(['x'], 'a.png', { type: 'image/png' })
    // jsdom's ClipboardEvent carries no clipboardData; attach one.
    function pasteEvent(types: string[], file: File | null, text = '') {
      const e = new Event('paste', {
        bubbles: true,
        cancelable: true,
      }) as ClipboardEvent
      Object.defineProperty(e, 'clipboardData', {
        value: {
          types,
          items: file
            ? [{ kind: 'file', type: file.type, getAsFile: () => file }]
            : [],
          getData: (type: string) => (type === 'text/plain' ? text : ''),
        },
      })
      return e
    }
    // Stands in for xterm's own paste listener on its textarea.
    function xtermTarget(container: HTMLElement) {
      const textarea = document.createElement('textarea')
      const xtermPaste = vi.fn()
      textarea.addEventListener('paste', xtermPaste)
      container.querySelector('[data-testid="terminal-view"]')!.append(textarea)
      return { textarea, xtermPaste }
    }

    it('takes an image-only paste before xterm sees it', () => {
      const onPasteImage = vi.fn()
      const { container } = renderView({ onPasteImage })
      const { textarea, xtermPaste } = xtermTarget(container)
      const e = pasteEvent(['Files'], image)
      textarea.dispatchEvent(e)
      expect(onPasteImage).toHaveBeenCalledWith(image)
      expect(e.defaultPrevented).toBe(true)
      expect(xtermPaste).not.toHaveBeenCalled()
      expect(socket.send).not.toHaveBeenCalled()
    })

    // Ctrl+V, the iOS Paste menu, a middle click: every paste of text is
    // cleaned the same way as the toolbar's, before xterm sees it.
    it('takes a text paste and sends it cleaned', () => {
      const { container, term } = renderView()
      const { textarea, xtermPaste } = xtermTarget(container)
      const e = pasteEvent(['text/plain'], null, 'ls\x1b[201~\r!id\r')
      textarea.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(true)
      expect(xtermPaste).not.toHaveBeenCalled()
      expect(term.paste).toHaveBeenCalledWith('ls\r!id\r')
    })

    it('a text paste in a herdr agent pane goes bracketed, cleaned', () => {
      const { container, term } = renderView({ bracketedPaste: true })
      const { textarea } = xtermTarget(container)
      textarea.dispatchEvent(pasteEvent(['text/plain'], null, 'a\x1b[201~b'))
      expect(socket.send).toHaveBeenCalledWith('\x1b[200~ab\x1b[201~')
      expect(term.paste).not.toHaveBeenCalled()
    })

    it('leaves a paste without clipboard data to xterm', () => {
      const { container, term } = renderView()
      const { textarea, xtermPaste } = xtermTarget(container)
      textarea.dispatchEvent(new Event('paste', { bubbles: true }))
      expect(xtermPaste).toHaveBeenCalledTimes(1)
      expect(term.paste).not.toHaveBeenCalled()
    })

    it('a text paste into a view-only terminal sends nothing', () => {
      const { container, term } = renderView({ readOnly: true })
      const { textarea, xtermPaste } = xtermTarget(container)
      textarea.dispatchEvent(pasteEvent(['text/plain'], null, 'rm -rf'))
      expect(xtermPaste).not.toHaveBeenCalled()
      expect(term.paste).not.toHaveBeenCalled()
      expect(socket.send).not.toHaveBeenCalled()
    })

    it('leaves empty pastes, read-only terminals and no handler to xterm', () => {
      const onPasteImage = vi.fn()
      const { container, rerender, ref } = renderView({ onPasteImage })
      const { textarea, xtermPaste } = xtermTarget(container)
      textarea.dispatchEvent(pasteEvent(['text/plain', 'Files'], image))
      textarea.dispatchEvent(pasteEvent([], null))
      rerender(
        <TerminalView
          ref={ref}
          paneId="0"
          onPasteImage={onPasteImage}
          readOnly
        />,
      )
      textarea.dispatchEvent(pasteEvent(['Files'], image))
      rerender(<TerminalView ref={ref} paneId="0" />)
      textarea.dispatchEvent(pasteEvent(['Files'], image))
      expect(onPasteImage).not.toHaveBeenCalled()
      expect(xtermPaste).toHaveBeenCalledTimes(4)
    })

    it('stops listening on unmount', () => {
      const onPasteImage = vi.fn()
      const { container, unmount } = renderView({ onPasteImage })
      const el = container.querySelector('[data-testid="terminal-view"]')!
      unmount()
      el.dispatchEvent(pasteEvent(['Files'], image))
      expect(onPasteImage).not.toHaveBeenCalled()
    })
  })

  it('applies theme, font size and context menu setting through the bridge', () => {
    const { ref, rerender, fit } = renderView({ theme: 'dark', fontSize: 14 })
    expect(bridge.setTerminalTheme).toHaveBeenCalledWith(
      ref.current,
      THEMES.dark,
    )
    expect(bridge.setTerminalFontSize).toHaveBeenCalledWith(ref.current, 14)
    expect(bridge.blockContextMenu).toHaveBeenCalledWith(ref.current)

    fit.fit.mockClear()
    rerender(
      <TerminalView
        ref={ref}
        paneId="0"
        theme="light"
        fontSize={18}
        disableContextMenu={false}
      />,
    )
    expect(bridge.setTerminalTheme).toHaveBeenLastCalledWith(
      ref.current,
      THEMES.light,
    )
    expect(bridge.setTerminalFontSize).toHaveBeenLastCalledWith(ref.current, 18)
    expect(fit.fit).toHaveBeenCalled()
    expect(bridge.unblockContextMenu).toHaveBeenCalledWith(ref.current)
  })

  it('creates the terminal with the font stack and refits on a new font', () => {
    const { ref, rerender, term, fit } = renderView({ fontFamily: 'Hack' })
    expect(term.options.fontFamily).toBe(terminalFontFamily('Hack'))

    fit.fit.mockClear()
    rerender(<TerminalView ref={ref} paneId="0" fontFamily="Fira Code" />)
    expect(bridge.setTerminalFontFamily).toHaveBeenLastCalledWith(
      ref.current,
      terminalFontFamily('Fira Code'),
    )
    expect(fit.fit).toHaveBeenCalled()
  })

  it('lets the context menu bubble only when blocked', () => {
    const parent = vi.fn()
    const { rerender } = render(
      <div onContextMenu={parent}>
        <TerminalView paneId="0" disableContextMenu />
      </div>,
    )
    fireEvent.contextMenu(screen.getByTestId('terminal-view'))
    expect(parent).toHaveBeenCalledTimes(1)
    rerender(
      <div onContextMenu={parent}>
        <TerminalView paneId="0" disableContextMenu={false} />
      </div>,
    )
    fireEvent.contextMenu(screen.getByTestId('terminal-view'))
    expect(parent).toHaveBeenCalledTimes(1)
  })

  it('reports connection state changes', () => {
    const onState = vi.fn()
    socket.state = 'connecting'
    const { rerender } = render(
      <TerminalView paneId="0" onConnectionStateChange={onState} />,
    )
    expect(onState).toHaveBeenLastCalledWith('connecting')
    socket.state = 'connected'
    rerender(<TerminalView paneId="0" onConnectionStateChange={onState} />)
    expect(onState).toHaveBeenLastCalledWith('connected')
  })

  it('shows a reconnect button only when the stream is down', () => {
    const { rerender } = renderView()
    expect(screen.queryByRole('button')).toBeNull()

    socket.state = 'disconnected'
    rerender(<TerminalView paneId="0" />)
    fireEvent.click(screen.getByRole('button', { name: /Disconnected/ }))
    expect(socket.reconnect).toHaveBeenCalled()

    socket.state = 'error'
    rerender(<TerminalView paneId="0" />)
    expect(screen.getByRole('button', { name: /Connection lost/ })).toBeTruthy()
  })

  it('paints its box with the terminal background token', () => {
    const { container } = renderView({ theme: 'light' })
    expect(container.firstElementChild?.className).toContain('bg-term')
  })

  it('takes the background from the style token and re-reads it on a new style', () => {
    const root = document.documentElement
    root.style.setProperty('--tm-term-bg', '#111111')
    try {
      const { ref, rerender, term } = renderView({
        theme: 'dark',
        uiStyle: 'neutral',
      })
      expect(term.options.theme).toEqual({
        ...THEMES.dark,
        background: '#111111',
        cursorAccent: '#111111',
      })

      root.style.setProperty('--tm-term-bg', '#222222')
      rerender(
        <TerminalView ref={ref} paneId="0" theme="dark" uiStyle="terminal" />,
      )
      expect(bridge.setTerminalTheme).toHaveBeenLastCalledWith(ref.current, {
        ...THEMES.dark,
        background: '#222222',
        cursorAccent: '#222222',
      })
    } finally {
      root.style.removeProperty('--tm-term-bg')
    }
  })

  it('disposes the terminal and its listeners on unmount', () => {
    const { unmount, term, ref } = renderView()
    const handle = ref.current!
    unmount()
    expect(observerDisconnect).toHaveBeenCalled()
    expect(term.dispose).toHaveBeenCalled()
    for (const d of term.disposables) expect(d.dispose).toHaveBeenCalled()
    expect(handle.term).toBeNull()
    // Output after unmount is dropped
    socketOpts.onOutput(new Uint8Array([1]))
    expect(term.write).not.toHaveBeenCalled()
    handle.paste('x')
    expect(term.paste).not.toHaveBeenCalled()
  })
})
