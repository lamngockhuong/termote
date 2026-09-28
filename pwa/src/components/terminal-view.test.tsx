import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamControl, TermSize } from '../hooks/use-term-socket'
import { terminalFontFamily } from '../utils/terminal-font'
import {
  bracketPaste,
  fitFontSize,
  MIN_FONT_SIZE,
  stripTerminalReplies,
  type TerminalHandle,
  TerminalView,
  THEMES,
  wheelRows,
} from './terminal-view'

type Listener<T> = (v: T) => void

// vi.mock factories run before module code, so the fakes are hoisted too.
const { FakeTerminal, FakeFit } = vi.hoisted(() => {
  // Fake xterm.js Terminal; the latest instance is kept for assertions.
  class FakeTerminal {
    static last: FakeTerminal
    options: { fontSize: number; fontFamily?: string; theme: unknown }
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
    }) {
      this.options = {
        fontSize: opts.fontSize,
        fontFamily: opts.fontFamily,
        theme: opts.theme,
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
    proposeDimensions = vi.fn<() => TermSize | undefined>(() => ({
      cols: 100,
      rows: 50,
    }))
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
  getSize: () => TermSize | null
  onOutput: (d: Uint8Array) => void
  onControl: (m: StreamControl) => void
  onOpen: () => void
}
let socketOpts: SocketOpts
const socket = {
  state: 'connected' as string,
  send: vi.fn(() => true),
  sendResize: vi.fn(),
  reconnect: vi.fn(),
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
}))
vi.mock('../utils/terminal-bridge', () => bridge)

let resizeObserverCb: () => void
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

describe('TerminalView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('passes pane and followPane to the socket', () => {
    renderView({ paneId: 'w1:p2', followPane: true })
    expect(socketOpts.paneId).toBe('w1:p2')
    expect(socketOpts.followPane).toBe(true)
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
    act(() => resizeObserverCb())
    expect(term.resize).toHaveBeenCalledWith(152, 41)
    expect(term.options.fontSize).toBe(14)

    // A new stream drops the old server size until the next size frame
    socketOpts.onOpen()
    act(() => resizeObserverCb())
    expect(fit.fit).toHaveBeenCalled()
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
    ref.current!.paste('a\nb')
    expect(term.paste).toHaveBeenCalledWith('a\nb')
    expect(socket.send).not.toHaveBeenCalled()

    rerender(<TerminalView ref={ref} paneId="0" bracketedPaste />)
    ref.current!.paste('a\nb')
    expect(socket.send).toHaveBeenCalledWith('\x1b[200~a\nb\x1b[201~')
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

  it('uses the light background class for the light theme', () => {
    const { container } = renderView({ theme: 'light' })
    expect(container.firstElementChild?.className).toContain('bg-[#f6f8fa]')
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
