import { SCREEN } from './fixtures/workspace'
import { screenAt, stepMs } from './screens'
import { type DemoState, findPane } from './state'

// A stand-in for the WebSocket of /api/mux/stream (hooks/use-term-socket.ts):
// it opens, sends the pane's size as Herdr's stream does (the pane is drawn
// at the desktop's size) and its screen as a full redraw, then the next
// screen on a timer while the page is shown. Input is taken and ignored; a
// resize draws the screen again.

const encoder = new TextEncoder()

// Clears the screen and its scrollback before each full redraw
const REDRAW = '\x1b[H\x1b[2J\x1b[3J'

export const STREAM_PATH = '/api/mux/stream'

export class FakeStream {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState: number = FakeStream.CONNECTING
  binaryType: BinaryType = 'blob'
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  private readonly pane: string
  private step = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly url: string,
    private readonly state: DemoState,
  ) {
    this.pane = new URL(url).searchParams.get('pane') ?? ''
    setTimeout(() => this.open(), 0)
  }

  private open() {
    if (this.readyState !== FakeStream.CONNECTING) return
    if (!findPane(this.state, this.pane)) {
      this.close(1011)
      return
    }
    this.readyState = FakeStream.OPEN
    this.onopen?.(new Event('open'))
    this.sendSize()
    this.draw()
    this.schedule()
  }

  private sendSize() {
    const ref = findPane(this.state, this.pane)
    const at = ref?.tab.layout?.panes.find((p) => p.id === this.pane)
    const size = at ? { cols: at.cols, rows: at.rows } : SCREEN
    this.emit(JSON.stringify({ type: 'size', ...size, driving: false }))
  }

  private draw() {
    const screen = screenAt(this.state, this.pane, this.step)
    const bytes = encoder.encode(REDRAW + screen.replace(/\r?\n/g, '\r\n'))
    this.emit(
      this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]),
    )
  }

  private emit(data: string | ArrayBuffer | Blob) {
    if (this.readyState === FakeStream.OPEN)
      this.onmessage?.(new MessageEvent('message', { data }))
  }

  // The next screen once this one's time is up; a hidden page waits
  private schedule() {
    const ms = stepMs(this.pane, this.step)
    if (ms === null) return
    this.timer = setTimeout(() => {
      if (document.visibilityState === 'visible') {
        this.step++
        this.draw()
      }
      this.schedule()
    }, ms)
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== FakeStream.OPEN) return
    if (typeof data !== 'string') return
    try {
      if (JSON.parse(data)?.type === 'resize') this.draw()
    } catch {
      // Not a control frame
    }
  }

  close(code = 1000) {
    if (this.readyState === FakeStream.CLOSED) return
    clearTimeout(this.timer)
    this.readyState = FakeStream.CLOSED
    this.onclose?.(new CloseEvent('close', { code, wasClean: code === 1000 }))
  }
}

// Puts the stand-in in place of WebSocket for stream URLs; any other URL
// gets the browser's own
export function installFakeWebSocket(
  state: DemoState,
  win: Window & typeof globalThis = window,
) {
  const Native = win.WebSocket
  function DemoWebSocket(url: string | URL, protocols?: string | string[]) {
    const u = new URL(url, win.location.href)
    if (u.pathname === STREAM_PATH) return new FakeStream(u.href, state)
    return new Native(url, protocols)
  }
  Object.assign(DemoWebSocket, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  })
  win.WebSocket = DemoWebSocket as unknown as typeof WebSocket
}
