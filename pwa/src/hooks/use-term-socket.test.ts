import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKOFF_MAX_MS,
  backoffDelay,
  CLOSE_EVICTED,
  HIDDEN_CLOSE_MS,
  STREAM_START_TIMEOUT_MS,
  streamURL,
  useTermSocket,
} from './use-term-socket'

const mockFetchTerminalToken = vi.fn()
vi.mock('./use-mux-api', () => ({
  fetchTerminalToken: () => mockFetchTerminalToken(),
}))

const mockReportLargePacketLoss = vi.fn()
vi.mock('../utils/large-packet-loss', () => ({
  reportLargePacketLoss: () => mockReportLargePacketLoss(),
}))

// Fake WebSocket that tests drive by hand; every instance is recorded.
class FakeWS {
  static OPEN = 1
  static instances: FakeWS[] = []
  readyState = 0
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor(public url: string) {
    FakeWS.instances.push(this)
  }
  open() {
    this.readyState = FakeWS.OPEN
    this.onopen?.()
  }
  message(data: unknown) {
    this.onmessage?.({ data })
  }
  closeWith(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const last = () => FakeWS.instances[FakeWS.instances.length - 1]
const flush = () => act(async () => {})

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

interface Opts {
  paneId?: string
  followPane?: boolean
  drive?: () => boolean
}

function setup(initial: Opts = { paneId: 'p1' }) {
  const onOutput = vi.fn()
  const onControl = vi.fn()
  const onOpen = vi.fn()
  const getSize = vi.fn(() => ({ cols: 80, rows: 24 }))
  const hook = renderHook(
    (props: Opts) =>
      useTermSocket({
        paneId: props.paneId,
        followPane: props.followPane ?? false,
        getSize,
        drive: props.drive,
        onOutput,
        onControl,
        onOpen,
      }),
    { initialProps: initial },
  )
  return { ...hook, onOutput, onControl, onOpen, getSize }
}

describe('backoffDelay', () => {
  afterEach(() => vi.restoreAllMocks())

  it('doubles per attempt with jitter in [0.5, 1)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(backoffDelay(0)).toBe(500)
    expect(backoffDelay(1)).toBe(1000)
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    expect(backoffDelay(0)).toBe(1000)
  })

  it('caps at BACKOFF_MAX_MS', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    expect(backoffDelay(50)).toBeLessThanOrEqual(BACKOFF_MAX_MS)
  })
})

describe('streamURL', () => {
  const orig = window.location
  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: orig,
    })
  })

  it('uses ws on http and carries size', () => {
    const url = streamURL('t', 'p:1', { cols: 80, rows: 24 })
    expect(url).toBe(
      `ws://${window.location.host}/api/mux/stream?token=t&pane=p%3A1&cols=80&rows=24`,
    )
  })

  it('asks to drive the size with drive=1', () => {
    expect(streamURL('t', 'p', null, true)).toBe(
      `ws://${window.location.host}/api/mux/stream?token=t&pane=p&drive=1`,
    )
  })

  it('uses wss on https and omits a missing size', () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { protocol: 'https:', host: 'h.example' },
    })
    expect(streamURL('t', 'p', null)).toBe(
      'wss://h.example/api/mux/stream?token=t&pane=p',
    )
  })
})

describe('useTermSocket', () => {
  beforeEach(() => {
    FakeWS.instances = []
    vi.stubGlobal('WebSocket', FakeWS)
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    mockFetchTerminalToken.mockReset().mockResolvedValue('tok')
    mockReportLargePacketLoss.mockReset()
    setVisibility('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not connect without a pane', async () => {
    const { result } = setup({ paneId: undefined })
    await flush()
    expect(mockFetchTerminalToken).not.toHaveBeenCalled()
    // reconnect() without a pane is a no-op too
    act(() => result.current.reconnect())
    await flush()
    expect(FakeWS.instances).toHaveLength(0)
    expect(result.current.state).toBe('connecting')
  })

  it('opens the stream with token, pane and size, then reports connected', async () => {
    const { result, onOpen } = setup()
    expect(result.current.state).toBe('connecting')
    await flush()
    const ws = last()
    expect(ws.url).toContain('token=tok&pane=p1&cols=80&rows=24')
    expect(ws.binaryType).toBe('arraybuffer')
    act(() => ws.open())
    expect(result.current.state).toBe('connected')
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('routes binary frames to onOutput and JSON frames to onControl', async () => {
    const { onOutput, onControl } = setup()
    await flush()
    const ws = last()
    act(() => ws.open())
    ws.message(new Uint8Array([104, 105]).buffer)
    expect(onOutput).toHaveBeenCalledWith(new Uint8Array([104, 105]))
    ws.message('{"type":"size","cols":152,"rows":41}')
    expect(onControl).toHaveBeenCalledWith({
      type: 'size',
      cols: 152,
      rows: 41,
    })
    ws.message('not json')
    expect(onControl).toHaveBeenCalledTimes(1)
  })

  it('works without an onControl or onOpen callback', async () => {
    const { result } = renderHook(() =>
      useTermSocket({
        paneId: 'p1',
        followPane: false,
        getSize: () => null,
        onOutput: vi.fn(),
      }),
    )
    await flush()
    const ws = last()
    expect(ws.url).not.toContain('cols=')
    act(() => ws.open())
    ws.message('{"type":"error","message":"x"}')
    expect(result.current.state).toBe('connected')
  })

  it('send and sendResize write only while the socket is open', async () => {
    const { result } = setup()
    // No socket yet
    expect(result.current.send('a')).toBe(false)
    act(() => result.current.sendResize({ cols: 1, rows: 1 }))
    await flush()
    const ws = last()
    // Socket exists but is still connecting
    expect(result.current.send('a')).toBe(false)
    act(() => result.current.sendResize({ cols: 1, rows: 1 }))
    expect(ws.send).not.toHaveBeenCalled()

    act(() => ws.open())
    expect(result.current.send('hé')).toBe(true)
    expect(ws.send).toHaveBeenLastCalledWith(new TextEncoder().encode('hé'))
    const bytes = new Uint8Array([27, 91, 77])
    result.current.send(bytes)
    expect(ws.send).toHaveBeenLastCalledWith(bytes)
    result.current.sendResize({ cols: 100, rows: 30 })
    expect(ws.send).toHaveBeenLastCalledWith(
      '{"type":"resize","cols":100,"rows":30}',
    )
  })

  it('opens with drive=1 while driving is wanted, and sends drive messages', async () => {
    let want = true
    const { result, rerender } = setup({ paneId: 'p1', drive: () => want })
    await flush()
    const ws = last()
    expect(ws.url).toContain('drive=1')
    // Not open yet: nothing is sent
    act(() => result.current.sendDrive(false))
    expect(ws.send).not.toHaveBeenCalled()
    act(() => ws.open())
    act(() => result.current.sendDrive(false))
    expect(ws.send).toHaveBeenLastCalledWith('{"type":"drive","on":false}')
    act(() => result.current.sendDrive(true))
    expect(ws.send).toHaveBeenLastCalledWith('{"type":"drive","on":true}')

    // The next stream asks again only if still wanted
    want = false
    rerender({ paneId: 'p1', drive: () => want })
    act(() => result.current.reconnect())
    await flush()
    expect(last()).not.toBe(ws)
    expect(last().url).not.toContain('drive=')
  })

  it('reconnects with backoff after an unexpected close', async () => {
    const { result } = setup()
    await flush()
    act(() => last().closeWith(1006))
    expect(result.current.state).toBe('disconnected')
    expect(FakeWS.instances).toHaveLength(1)
    // First retry after 500ms (random=0), second after 1000ms
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(FakeWS.instances).toHaveLength(2)
    act(() => last().closeWith(1006))
    await act(async () => {
      vi.advanceTimersByTime(999)
    })
    expect(FakeWS.instances).toHaveLength(2)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(FakeWS.instances).toHaveLength(3)
    // A successful open resets the backoff
    act(() => last().open())
    act(() => last().closeWith(1006))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(FakeWS.instances).toHaveLength(4)
  })

  it('stays stopped after eviction', async () => {
    const { result } = setup()
    await flush()
    act(() => last().open())
    act(() => last().closeWith(CLOSE_EVICTED))
    expect(result.current.state).toBe('error')
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    // Neither the network coming back nor the page showing again reopens it
    act(() => {
      window.dispatchEvent(new Event('online'))
      setVisibility('visible')
    })
    await flush()
    expect(FakeWS.instances).toHaveLength(1)
    // An explicit reconnect does
    act(() => result.current.reconnect())
    await flush()
    expect(FakeWS.instances).toHaveLength(2)
  })

  it('stays disconnected after the process exited', async () => {
    const { result, onControl } = setup()
    await flush()
    const ws = last()
    act(() => ws.open())
    ws.message('{"type":"exit","code":0}')
    expect(onControl).toHaveBeenCalledWith({ type: 'exit', code: 0 })
    act(() => ws.closeWith(1000))
    expect(result.current.state).toBe('disconnected')
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(FakeWS.instances).toHaveLength(1)
  })

  it('reports error and retries when the token request fails', async () => {
    mockFetchTerminalToken.mockRejectedValueOnce(new Error('503'))
    const { result } = setup()
    await flush()
    expect(result.current.state).toBe('error')
    expect(FakeWS.instances).toHaveLength(0)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(FakeWS.instances).toHaveLength(1)
  })

  it('drops a token that arrives after a newer connect started', async () => {
    let resolveFirst: (t: string) => void = () => {}
    mockFetchTerminalToken.mockImplementationOnce(
      () => new Promise<string>((r) => (resolveFirst = r)),
    )
    const { result } = setup()
    act(() => result.current.reconnect())
    await flush()
    expect(FakeWS.instances).toHaveLength(1)
    await act(async () => resolveFirst('stale'))
    expect(FakeWS.instances).toHaveLength(1)
    expect(last().url).toContain('token=tok')
  })

  it('ignores a token failure from a superseded connect', async () => {
    let rejectFirst: (e: Error) => void = () => {}
    mockFetchTerminalToken.mockImplementationOnce(
      () => new Promise<string>((_, r) => (rejectFirst = r)),
    )
    const { result } = setup()
    act(() => result.current.reconnect())
    await flush()
    act(() => last().open())
    await act(async () => rejectFirst(new Error('late')))
    expect(result.current.state).toBe('connected')
  })

  it('reconnect replaces the open socket', async () => {
    const { result } = setup()
    await flush()
    const first = last()
    act(() => first.open())
    act(() => result.current.reconnect())
    await flush()
    expect(first.close).toHaveBeenCalled()
    expect(first.onclose).toBeNull()
    expect(FakeWS.instances).toHaveLength(2)
  })

  it('follows pane changes only when followPane is set', async () => {
    const { rerender } = setup({ paneId: 'p1', followPane: false })
    await flush()
    rerender({ paneId: 'p2', followPane: false })
    await flush()
    expect(FakeWS.instances).toHaveLength(1)
    // The new pane is used on the next connect
    act(() => last().closeWith(1006))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(last().url).toContain('pane=p2')

    rerender({ paneId: 'p3', followPane: true })
    await flush()
    rerender({ paneId: 'p4', followPane: true })
    await flush()
    expect(last().url).toContain('pane=p4')
  })

  it('closes a stream hidden for 30s and reopens it when shown', async () => {
    const { result } = setup()
    await flush()
    const ws = last()
    act(() => ws.open())
    act(() => ws.message(new ArrayBuffer(1)))
    act(() => setVisibility('hidden'))
    act(() => {
      vi.advanceTimersByTime(HIDDEN_CLOSE_MS - 1)
    })
    expect(ws.close).not.toHaveBeenCalled()
    // Hiding again restarts the countdown
    act(() => setVisibility('hidden'))
    act(() => {
      vi.advanceTimersByTime(HIDDEN_CLOSE_MS)
    })
    expect(ws.close).toHaveBeenCalled()
    expect(result.current.state).toBe('disconnected')
    // No reconnect while hidden, even when the network comes back
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await flush()
    expect(FakeWS.instances).toHaveLength(1)
    act(() => setVisibility('visible'))
    await flush()
    expect(FakeWS.instances).toHaveLength(2)
  })

  it('keeps a stream shown again before the hidden timeout', async () => {
    setup()
    await flush()
    const ws = last()
    act(() => ws.open())
    act(() => ws.message(new ArrayBuffer(1)))
    act(() => setVisibility('hidden'))
    act(() => setVisibility('visible'))
    act(() => {
      vi.advanceTimersByTime(HIDDEN_CLOSE_MS)
    })
    expect(ws.close).not.toHaveBeenCalled()
    expect(FakeWS.instances).toHaveLength(1)
  })

  it('does not replace a stopped stream when the page is hidden', async () => {
    const { result } = setup()
    await flush()
    act(() => last().closeWith(CLOSE_EVICTED))
    act(() => setVisibility('hidden'))
    act(() => {
      vi.advanceTimersByTime(HIDDEN_CLOSE_MS)
    })
    expect(result.current.state).toBe('error')
  })

  it('retries at once when shown or back online during a backoff', async () => {
    setup()
    await flush()
    act(() => last().closeWith(1006))
    act(() => setVisibility('visible'))
    await flush()
    expect(FakeWS.instances).toHaveLength(2)

    act(() => last().closeWith(1006))
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await flush()
    expect(FakeWS.instances).toHaveLength(3)
    // Online with a live socket changes nothing
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await flush()
    expect(FakeWS.instances).toHaveLength(3)
  })

  it('closes the socket and removes listeners on unmount', async () => {
    const { unmount } = setup()
    await flush()
    const ws = last()
    act(() => setVisibility('hidden'))
    unmount()
    expect(ws.close).toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(HIDDEN_CLOSE_MS)
      setVisibility('visible')
      window.dispatchEvent(new Event('online'))
    })
    await flush()
    expect(FakeWS.instances).toHaveLength(1)
  })

  it('reconnects a socket that looks open after the page was frozen in the background', async () => {
    setup()
    await flush()
    const ws = last()
    act(() => ws.open())
    act(() => setVisibility('hidden'))
    // Timers do not run while the page is frozen; only the clock moves
    vi.setSystemTime(Date.now() + HIDDEN_CLOSE_MS)
    act(() => setVisibility('visible'))
    await flush()
    expect(ws.close).toHaveBeenCalled()
    expect(FakeWS.instances).toHaveLength(2)
  })

  it('reconnects a socket that looks open after the network went away', async () => {
    setup()
    await flush()
    const ws = last()
    act(() => ws.open())
    act(() => {
      window.dispatchEvent(new Event('offline'))
      window.dispatchEvent(new Event('online'))
    })
    await flush()
    expect(ws.close).toHaveBeenCalled()
    expect(FakeWS.instances).toHaveLength(2)
    // A second online without an offline in between keeps the new socket
    act(() => last().open())
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await flush()
    expect(FakeWS.instances).toHaveLength(2)
  })

  it('goes back to connecting when the pane disappears', async () => {
    const { result, rerender } = setup({ paneId: 'p1', followPane: true })
    await flush()
    act(() => last().open())
    expect(result.current.state).toBe('connected')
    rerender({ paneId: undefined, followPane: true })
    expect(result.current.state).toBe('connecting')
    expect(last().close).toHaveBeenCalled()
  })

  it('drops an open stream that shows no output and reports lost replies', async () => {
    const { result } = setup()
    await flush()
    const ws = last()
    act(() => ws.open())
    act(() => {
      vi.advanceTimersByTime(STREAM_START_TIMEOUT_MS - 1)
    })
    expect(ws.close).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(ws.close).toHaveBeenCalled()
    expect(result.current.state).toBe('error')
    expect(mockReportLargePacketLoss).toHaveBeenCalledTimes(1)
    // Retried after the backoff
    act(() => {
      vi.advanceTimersByTime(backoffDelay(0))
    })
    await flush()
    expect(FakeWS.instances).toHaveLength(2)
  })

  it('retries a stream that never opens without reporting lost replies', async () => {
    const { result } = setup()
    await flush()
    const ws = last()
    act(() => {
      vi.advanceTimersByTime(STREAM_START_TIMEOUT_MS)
    })
    expect(ws.close).toHaveBeenCalled()
    expect(result.current.state).toBe('error')
    expect(mockReportLargePacketLoss).not.toHaveBeenCalled()
  })

  it('keeps a stream whose output arrived', async () => {
    const { result, onOutput } = setup()
    await flush()
    const ws = last()
    act(() => ws.open())
    act(() => ws.message(new ArrayBuffer(1)))
    expect(onOutput).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(STREAM_START_TIMEOUT_MS)
    })
    expect(ws.close).not.toHaveBeenCalled()
    expect(result.current.state).toBe('connected')
  })

  it('does not reopen a stream that closed before any output', async () => {
    const { result } = setup()
    await flush()
    const ws = last()
    act(() => ws.open())
    act(() => ws.closeWith(CLOSE_EVICTED))
    act(() => {
      vi.advanceTimersByTime(STREAM_START_TIMEOUT_MS)
    })
    await flush()
    expect(FakeWS.instances).toHaveLength(1)
    expect(result.current.state).toBe('error')
    expect(mockReportLargePacketLoss).not.toHaveBeenCalled()
  })
})
