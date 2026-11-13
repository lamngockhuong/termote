import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentMachineForTest } from '../utils/api-base'
import {
  resetSpareForTest,
  SPARE_MAX_AGE_MS,
} from '../utils/spare-stream-token'
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
  streamKey?: string
  paneSeen?: unknown
  drive?: () => boolean
  visible?: boolean
  spareToken?: boolean
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
        streamKey: props.streamKey,
        paneSeen: props.paneSeen,
        getSize,
        drive: props.drive,
        visible: props.visible,
        spareToken: props.spareToken,
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

  it("streams the open machine's pane through this server", () => {
    setCurrentMachineForTest('0123456789abcdef')
    try {
      expect(streamURL('t', 'p', null)).toBe(
        `ws://${window.location.host}/api/machines/0123456789abcdef/mux/stream?token=t&pane=p`,
      )
    } finally {
      setCurrentMachineForTest('')
    }
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
    resetSpareForTest()
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
    ws.message('{"type":"layout"}')
    expect(onControl).toHaveBeenLastCalledWith({ type: 'layout' })
    ws.message('not json')
    expect(onControl).toHaveBeenCalledTimes(2)
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

  it('tells the server while the pane is on screen and the page shown', async () => {
    const visible = (ws: FakeWS) =>
      ws.send.mock.calls
        .map(([m]) => m)
        .filter((m) => typeof m === 'string' && m.includes('visible'))
    const { rerender } = setup({ paneId: 'p1', visible: true })
    await flush()
    const ws = last()
    // Not open yet: nothing is sent
    expect(ws.send).not.toHaveBeenCalled()
    act(() => ws.open())
    expect(visible(ws)).toEqual(['{"type":"visible","on":true}'])
    // The same value again sends nothing
    rerender({ paneId: 'p1', visible: true })
    expect(visible(ws)).toHaveLength(1)
    // The page in the background, then back
    act(() => setVisibility('hidden'))
    act(() => setVisibility('visible'))
    // Another view covers the pane
    rerender({ paneId: 'p1', visible: false })
    // Hidden while not shown: already off
    act(() => setVisibility('hidden'))
    act(() => setVisibility('visible'))
    expect(visible(ws)).toEqual([
      '{"type":"visible","on":true}',
      '{"type":"visible","on":false}',
      '{"type":"visible","on":true}',
      '{"type":"visible","on":false}',
    ])

    // A new socket starts unseen: it is told again once open
    rerender({ paneId: 'p1', visible: true })
    expect(visible(ws)).toHaveLength(5)
    ws.closeWith(1006)
    await act(async () => {
      vi.advanceTimersByTime(BACKOFF_MAX_MS)
    })
    await flush()
    const next = last()
    expect(next).not.toBe(ws)
    act(() => next.open())
    expect(visible(next)).toEqual(['{"type":"visible","on":true}'])
  })

  it('never sends visible for a pane not looked at', async () => {
    setup({ paneId: 'p1' })
    await flush()
    act(() => last().open())
    act(() => setVisibility('hidden'))
    act(() => setVisibility('visible'))
    expect(last().send).not.toHaveBeenCalled()
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
    expect(result.current.state).toBe('evicted')
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

  it('opens on the pane picked while its token was on the way (tmux: a link)', async () => {
    let resolveToken: (t: string) => void = () => {}
    mockFetchTerminalToken.mockImplementationOnce(
      () => new Promise<string>((r) => (resolveToken = r)),
    )
    const { rerender } = setup({ paneId: '0', streamKey: 'main' })
    await flush()
    expect(FakeWS.instances).toHaveLength(0)
    rerender({ paneId: '1', streamKey: 'main' })
    await act(async () => resolveToken('tok'))
    expect(FakeWS.instances).toHaveLength(1)
    expect(last().url).toContain('pane=1')
  })

  it('reconnects when the stream key changes (tmux: another session)', async () => {
    const { rerender } = setup({ paneId: '0', streamKey: 'main' })
    await flush()
    rerender({ paneId: '1', streamKey: 'main' })
    await flush()
    expect(FakeWS.instances).toHaveLength(1)
    rerender({ paneId: '$3:0', streamKey: '$3' })
    await flush()
    expect(FakeWS.instances).toHaveLength(2)
    expect(last().url).toContain('pane=%243%3A0')
  })

  it('reconnects an exited stream once while its pane is still listed', async () => {
    const { result, rerender } = setup({ paneId: '0', paneSeen: 1 })
    await flush()
    act(() => last().open())
    // A poll while the stream runs changes nothing.
    rerender({ paneId: '0', paneSeen: 2 })
    await flush()
    expect(FakeWS.instances).toHaveLength(1)
    last().message('{"type":"exit","code":0}')
    act(() => last().closeWith(1000))
    expect(result.current.state).toBe('disconnected')
    // The pane is gone from the next snapshot: nothing.
    rerender({ paneId: '0', paneSeen: undefined })
    await flush()
    expect(FakeWS.instances).toHaveLength(1)
    // Listed again (the session was made again): one reconnect.
    rerender({ paneId: '0', paneSeen: 3 })
    await flush()
    expect(FakeWS.instances).toHaveLength(2)
    rerender({ paneId: '0', paneSeen: 4 })
    await flush()
    expect(FakeWS.instances).toHaveLength(2)
    // Each exit gets its own retry, at the next poll at most.
    last().message('{"type":"exit","code":1}')
    act(() => last().closeWith(1000))
    rerender({ paneId: '0', paneSeen: 5 })
    await flush()
    expect(FakeWS.instances).toHaveLength(3)
  })

  it('does not reconnect an evicted stream when its pane is listed', async () => {
    const { rerender } = setup({ paneId: '0', paneSeen: 1 })
    await flush()
    act(() => last().open())
    act(() => last().closeWith(CLOSE_EVICTED))
    rerender({ paneId: '0', paneSeen: 2 })
    await flush()
    expect(FakeWS.instances).toHaveLength(1)
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
    expect(result.current.state).toBe('evicted')
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
    expect(result.current.state).toBe('evicted')
    expect(mockReportLargePacketLoss).not.toHaveBeenCalled()
  })
})

describe('useTermSocket spare token', () => {
  // The spare's own request goes through fetch; tokens a stream fetches
  // itself through fetchTerminalToken (mocked above)
  const fetchMock = vi.fn()
  let spares = 0
  beforeEach(() => {
    FakeWS.instances = []
    vi.stubGlobal('WebSocket', FakeWS)
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    spares = 0
    fetchMock.mockReset().mockImplementation(async () => {
      spares++
      return new Response(JSON.stringify({ token: `spare${spares}` }), {
        status: 200,
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    mockFetchTerminalToken.mockReset().mockResolvedValue('tok')
    resetSpareForTest()
    setVisibility('visible')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  const token = (ws: FakeWS) => new URL(ws.url).searchParams.get('token')

  it('opens the next stream with the token fetched after the last one opened', async () => {
    const { rerender } = setup({
      paneId: 'p1',
      streamKey: 'a',
      spareToken: true,
    })
    await flush()
    expect(token(last())).toBe('tok')
    act(() => last().open())
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/mux/stream-token')
    // Another tmux session: no token request before its socket
    rerender({ paneId: 'p1', streamKey: 'b', spareToken: true })
    await flush()
    expect(mockFetchTerminalToken).toHaveBeenCalledTimes(1)
    expect(token(last())).toBe('spare1')
    act(() => last().open())
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fetches a token itself when the spare is too old', async () => {
    const { rerender } = setup({
      paneId: 'p1',
      streamKey: 'a',
      spareToken: true,
    })
    await flush()
    act(() => last().open())
    await flush()
    vi.setSystemTime(Date.now() + SPARE_MAX_AGE_MS)
    rerender({ paneId: 'p1', streamKey: 'b', spareToken: true })
    await flush()
    expect(token(last())).toBe('tok')
    expect(mockFetchTerminalToken).toHaveBeenCalledTimes(2)
  })

  it('retries a refused spare at once with a fresh token, once', async () => {
    const { rerender, result } = setup({
      paneId: 'p1',
      streamKey: 'a',
      spareToken: true,
    })
    await flush()
    act(() => last().open())
    await flush()
    rerender({ paneId: 'p1', streamKey: 'b', spareToken: true })
    await flush()
    const refused = last()
    expect(token(refused)).toBe('spare1')
    act(() => refused.closeWith(1006))
    await flush()
    // No backoff wait: a new socket with a fetched token already
    const retry = last()
    expect(retry).not.toBe(refused)
    expect(token(retry)).toBe('tok')
    expect(result.current.state).toBe('connecting')
    // That one failing too takes the usual way
    act(() => retry.closeWith(1006))
    await flush()
    expect(last()).toBe(retry)
    expect(result.current.state).toBe('disconnected')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a stream that opened with a spare and closed later takes the usual way', async () => {
    const { rerender, result } = setup({
      paneId: 'p1',
      streamKey: 'a',
      spareToken: true,
    })
    await flush()
    act(() => last().open())
    await flush()
    rerender({ paneId: 'p1', streamKey: 'b', spareToken: true })
    await flush()
    const ws = last()
    act(() => ws.open())
    act(() => ws.closeWith(1006))
    await flush()
    expect(last()).toBe(ws)
    expect(result.current.state).toBe('disconnected')
  })

  it('never fetches a spare without spareToken (view role, or caps not in yet)', async () => {
    const { rerender } = setup({ paneId: 'p1', streamKey: 'a' })
    await flush()
    act(() => last().open())
    await flush()
    rerender({ paneId: 'p1', streamKey: 'b' })
    await flush()
    act(() => last().open())
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockFetchTerminalToken).toHaveBeenCalledTimes(2)
  })

  it('a long outage asks for no more tokens than its retries plus one', async () => {
    setup({ paneId: 'p1', spareToken: true })
    await flush()
    act(() => last().open())
    await flush()
    act(() => last().closeWith(1006))
    // Retries that never open
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS)
      })
      act(() => last().closeWith(1006))
    }
    const sockets = FakeWS.instances.length
    const requests =
      mockFetchTerminalToken.mock.calls.length + fetchMock.mock.calls.length
    // The first open's token, its spare, and one per retry
    expect(requests).toBeLessThanOrEqual(sockets + 1)
  })
})
