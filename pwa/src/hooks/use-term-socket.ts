import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionState } from '../components/connection-indicator'
import { fetchTerminalToken } from './use-mux-api'

// Server → client text frame on /api/mux/stream.
export type StreamControl =
  | {
      type: 'size'
      cols: number
      rows: number
      // herdr: whether this client now drives the pane size.
      driving?: boolean
      // Why driving stopped when the client did not ask it to.
      reason?: 'taken-over' | 'failed'
    }
  | { type: 'exit'; code?: number }
  | { type: 'error'; message?: string }

export interface TermSize {
  cols: number
  rows: number
}

interface Options {
  // Pane to stream. No connection is opened while it is undefined.
  paneId: string | undefined
  // Reconnect when paneId changes (herdr streams one pane per connection).
  // tmux attaches the whole session, so a new pane id is only used on the
  // next connect.
  followPane: boolean
  // Size requested when the stream opens.
  getSize: () => TermSize | null
  // Open already driving the pane size (herdr), so a reconnect does not start
  // at the desktop size only to switch at once.
  drive?: () => boolean
  onOutput: (data: Uint8Array) => void
  onControl?: (msg: StreamControl) => void
  // Called on every successful open, after the state becomes 'connected'.
  onOpen?: () => void
}

// Close code the server sends to a stream pushed out by a newer one. Not
// reconnecting stops two devices from evicting each other in a loop.
export const CLOSE_EVICTED = 4001
// A hidden page keeps its stream this long before closing it.
export const HIDDEN_CLOSE_MS = 30_000
const BACKOFF_BASE_MS = 1000
export const BACKOFF_MAX_MS = 30_000

// Exponential backoff with jitter in [0.5, 1) of the step, capped.
export function backoffDelay(attempt: number): number {
  const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.round(step * (0.5 + Math.random() / 2))
}

export function streamURL(
  token: string,
  pane: string,
  size: TermSize | null,
  drive = false,
) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const q = new URLSearchParams({ token, pane })
  if (size) {
    q.set('cols', String(size.cols))
    q.set('rows', String(size.rows))
  }
  if (drive) q.set('drive', '1')
  return `${proto}://${window.location.host}/api/mux/stream?${q}`
}

const encoder = new TextEncoder()

export function useTermSocket({
  paneId,
  followPane,
  getSize,
  drive,
  onOutput,
  onControl,
  onOpen,
}: Options) {
  const [state, setState] = useState<ConnectionState>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  // Bumped on every connect/teardown; callbacks of an older socket are ignored.
  const genRef = useRef(0)
  const attemptRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hiddenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Why the stream is closed on purpose: 'hidden' reopens when the page is
  // shown again; 'stopped' (process exited, evicted) waits for reconnect().
  const stopRef = useRef<'hidden' | 'stopped' | null>(null)
  const paneRef = useRef(paneId)
  paneRef.current = paneId

  // Callbacks change every render; the socket reads the latest through a ref.
  const cbRef = useRef({ getSize, drive, onOutput, onControl, onOpen })
  cbRef.current = { getSize, drive, onOutput, onControl, onOpen }

  const teardown = useCallback(() => {
    genRef.current++
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    const ws = wsRef.current
    wsRef.current = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
    }
  }, [])

  const connect = useCallback(async () => {
    teardown()
    const pane = paneRef.current
    if (!pane) return
    stopRef.current = null
    const gen = genRef.current
    setState('connecting')

    // teardown clears this timer, so it only fires for the current socket.
    const scheduleRetry = (next: ConnectionState) => {
      setState(next)
      retryTimerRef.current = setTimeout(
        connect,
        backoffDelay(attemptRef.current++),
      )
    }

    let token: string
    try {
      token = await fetchTerminalToken()
    } catch {
      if (gen === genRef.current) scheduleRetry('error')
      return
    }
    if (gen !== genRef.current) return

    const cb = cbRef.current
    const ws = new WebSocket(
      streamURL(token, pane, cb.getSize(), cb.drive?.() ?? false),
    )
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    // Set by an exit frame so the following close does not reconnect.
    let exited = false

    ws.onopen = () => {
      attemptRef.current = 0
      setState('connected')
      cbRef.current.onOpen?.()
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') {
        cbRef.current.onOutput(new Uint8Array(ev.data as ArrayBuffer))
        return
      }
      let msg: StreamControl
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === 'exit') exited = true
      cbRef.current.onControl?.(msg)
    }
    // teardown detaches these handlers, so they only run for the current socket.
    ws.onclose = (ev: CloseEvent) => {
      wsRef.current = null
      if (ev.code === CLOSE_EVICTED || exited) {
        stopRef.current = 'stopped'
        setState(exited ? 'disconnected' : 'error')
        return
      }
      scheduleRetry('disconnected')
    }
  }, [teardown])

  // Open on mount and when the pane first becomes known; follow pane changes
  // only when asked.
  const connectKey = followPane ? paneId : paneId ? 'pane' : undefined
  useEffect(() => {
    if (!connectKey) {
      setState('connecting')
      return
    }
    attemptRef.current = 0
    connect()
    return teardown
  }, [connectKey, connect, teardown])

  // Close a stream hidden for a while; reopen it when the page is shown again
  // or the network comes back. A socket can look open after it died: mobile
  // browsers freeze timers in the background (the close timer never fires)
  // and a network switch leaves the old connection half-open. Both cases
  // reconnect unconditionally.
  useEffect(() => {
    let hiddenAt: number | null = null
    let wentOffline = false
    const clearHidden = () => {
      if (hiddenTimerRef.current) {
        clearTimeout(hiddenTimerRef.current)
        hiddenTimerRef.current = null
      }
    }
    const reopen = () => {
      attemptRef.current = 0
      connect()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearHidden()
        hiddenAt = Date.now()
        hiddenTimerRef.current = setTimeout(() => {
          if (stopRef.current === 'stopped') return
          teardown()
          stopRef.current = 'hidden'
          setState('disconnected')
        }, HIDDEN_CLOSE_MS)
        return
      }
      clearHidden()
      const longHidden =
        hiddenAt !== null && Date.now() - hiddenAt >= HIDDEN_CLOSE_MS
      hiddenAt = null
      if (stopRef.current === 'stopped') return
      if (longHidden || !wsRef.current) reopen()
    }
    const onOffline = () => {
      wentOffline = true
    }
    const onOnline = () => {
      const forced = wentOffline
      wentOffline = false
      if (
        document.visibilityState === 'hidden' ||
        stopRef.current === 'stopped'
      )
        return
      if (forced || !wsRef.current) reopen()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      clearHidden()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [connect, teardown])

  const send = useCallback((data: string | Uint8Array<ArrayBuffer>) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(typeof data === 'string' ? encoder.encode(data) : data)
    return true
  }, [])

  const sendResize = useCallback((size: TermSize) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'resize', ...size }))
  }, [])

  // Ask to drive the pane size (herdr), or give it back.
  const sendDrive = useCallback((on: boolean) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'drive', on }))
  }, [])

  const reconnect = useCallback(() => {
    attemptRef.current = 0
    connect()
  }, [connect])

  return { state, send, sendResize, sendDrive, reconnect }
}
