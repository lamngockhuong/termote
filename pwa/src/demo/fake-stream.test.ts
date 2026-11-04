import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeStream, installFakeWebSocket } from './fake-stream'
import { CLAUDE_STORY, LOG_MS, plainScreen } from './screens'
import { createState, type DemoState } from './state'

const decoder = new TextDecoder()
const URL_OF = (pane: string) =>
  `ws://127.0.0.1/api/mux/stream?token=demo&pane=${encodeURIComponent(pane)}`

function open(state: DemoState, pane: string) {
  const ws = new FakeStream(URL_OF(pane), state)
  ws.binaryType = 'arraybuffer'
  const frames: (string | ArrayBuffer)[] = []
  ws.onmessage = (ev) => frames.push(ev.data)
  const closes: number[] = []
  ws.onclose = (ev) => closes.push(ev.code)
  return { ws, frames, closes }
}

const screens = (frames: (string | ArrayBuffer)[]) =>
  frames.filter((f) => typeof f !== 'string').map((f) => decoder.decode(f))

describe('FakeStream', () => {
  let state: DemoState
  beforeEach(() => {
    vi.useFakeTimers()
    state = createState()
  })
  afterEach(() => vi.useRealTimers())

  it('opens with the pane size, then a full screen', async () => {
    const { ws, frames } = open(state, 'w1:p1')
    expect(ws.readyState).toBe(FakeStream.CONNECTING)
    await vi.advanceTimersByTimeAsync(0)
    expect(ws.readyState).toBe(FakeStream.OPEN)
    expect(JSON.parse(frames[0] as string)).toEqual({
      type: 'size',
      cols: 100,
      rows: 41,
      driving: false,
    })
    const [first] = screens(frames)
    expect(first.startsWith('\x1b[H\x1b[2J\x1b[3J')).toBe(true)
    expect(first).toContain('All auth tests pass.')
    expect(first).not.toMatch(/[^\r]\n/)
  })

  it('plays the next screen when this one is done', async () => {
    const { frames } = open(state, 'w1:p1')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(CLAUDE_STORY[0].ms)
    expect(screens(frames)[1]).toContain('Yes, run the auth tests')
    await vi.advanceTimersByTimeAsync(CLAUDE_STORY[1].ms)
    expect(screens(frames)[2]).toContain('go test ./auth/...')
  })

  it('waits while the page is hidden', async () => {
    const hidden = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    const { frames } = open(state, 'w1:p2')
    await vi.advanceTimersByTimeAsync(LOG_MS * 3)
    expect(screens(frames)).toHaveLength(1)
    hidden.mockRestore()
    await vi.advanceTimersByTimeAsync(LOG_MS)
    expect(screens(frames)).toHaveLength(2)
  })

  it('ignores input and draws again on resize', async () => {
    const { ws, frames } = open(state, 'w1:p3')
    await vi.advanceTimersByTimeAsync(0)
    ws.send(new TextEncoder().encode('ls\r'))
    ws.send('not json')
    expect(screens(frames)).toHaveLength(1)
    ws.send(JSON.stringify({ type: 'resize', cols: 50, rows: 20 }))
    expect(screens(frames)).toHaveLength(2)
  })

  it('stops on close', async () => {
    const { ws, frames, closes } = open(state, 'w1:p2')
    await vi.advanceTimersByTimeAsync(0)
    ws.close()
    ws.close()
    await vi.advanceTimersByTimeAsync(LOG_MS * 3)
    expect(screens(frames)).toHaveLength(1)
    expect(closes).toEqual([1000])
  })

  it('closes a stream of a pane that is gone', async () => {
    const { closes } = open(state, 'w9:p9')
    await vi.advanceTimersByTimeAsync(0)
    expect(closes).toEqual([1011])
  })

  it('sends Blobs unless asked for array buffers', async () => {
    const ws = new FakeStream(URL_OF('w3:p1'), state)
    const data: unknown[] = []
    ws.onmessage = (ev) => data.push(ev.data)
    await vi.advanceTimersByTimeAsync(0)
    expect(data[1]).toBeInstanceOf(Blob)
  })
})

describe('the panes screens', () => {
  it('shows a shell prompt in a pane made in the demo', () => {
    const state = createState()
    state.groups[0].tabs[1].panes.push({
      id: 'w1:p9',
      active: false,
      process: { name: 'bash', cwd: '/home/dev/acme-api' },
    })
    expect(plainScreen(state, 'w1:p9')).toBe('dev@laptop:~/acme-api$')
  })
})

describe('installFakeWebSocket', () => {
  it('answers stream URLs and leaves the others to the browser', () => {
    const Native = vi.fn()
    const win = {
      WebSocket: Native,
      location: { href: 'http://127.0.0.1/demo/' },
    } as unknown as Window & typeof globalThis
    installFakeWebSocket(createState(), win)
    expect(new win.WebSocket(URL_OF('w1:p1'))).toBeInstanceOf(FakeStream)
    new win.WebSocket('ws://127.0.0.1/other')
    expect(Native).toHaveBeenCalledWith('ws://127.0.0.1/other', undefined)
    expect(win.WebSocket.OPEN).toBe(1)
  })
})
