import { fetchTerminalToken } from '../hooks/use-mux-api'
import { apiBase } from './api-base'

// One stream token fetched ahead, so the next stream opens with only its
// WebSocket handshake (a tmux session switch, the first stream of a layout
// view, a short network drop). Only a full-role client keeps one: a
// view-only device holds at most 4 unused tokens on the server and 4 token
// requests per 30 seconds through a machine. Fetched once after a stream
// opens, never on a timer; the server gives no way to give one back, so one
// dropped stays valid there until its 30 second TTL. apiBase() is fixed for
// the page's life (switching machines and signing in again both load the
// page), so a single slot does.

// Whether a client keeps a spare: one with the full role, or one of a server
// without sign-in (caps.role is absent only there: a server with sign-in
// names every client's role, and a machine is always given one), never a
// read-only one. Until a snapshot's caps are in, none: a view-only device
// must not hold one.
export function spareAllowed(
  role: 'full' | 'view' | undefined,
  capsLoaded: boolean,
  readOnly: boolean,
): boolean {
  if (readOnly) return false
  return role === 'full' || (capsLoaded && role === undefined)
}

// Older than this, a spare is dropped for a fresh one: the server's TTL is
// 30 seconds from when it made it, and the page's clock keeps running in
// the background where timers stand still.
export const SPARE_MAX_AGE_MS = 20_000

let spare: { token: string; at: number } | null = null
let inflight = false

export function resetSpareForTest(): void {
  spare = null
  inflight = false
}

// A token for a new stream: the spare when one is fresh (and allowed), else
// one fetched now. spare says which, so a refused spare is retried at once.
export async function takeToken(
  allowSpare = true,
): Promise<{ token: string; spare: boolean }> {
  if (allowSpare) {
    const kept = spare
    spare = null
    if (kept && Date.now() - kept.at < SPARE_MAX_AGE_MS) {
      return { token: kept.token, spare: true }
    }
  }
  return { token: await fetchTerminalToken(), spare: false }
}

// A spare request still unanswered after this is dropped (a connection left
// half-open by a network switch), as fetchTerminalToken drops its own
export const REFILL_TIMEOUT_MS = 5000

// Fetches a spare when there is none and none is on its way. One request,
// no retries: a failure leaves the next stream to fetch its own.
export function refill(): void {
  if (spare || inflight) return
  inflight = true
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REFILL_TIMEOUT_MS)
  fetch(`${apiBase()}/stream-token`, { signal: ctrl.signal })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { token?: unknown } | null) => {
      if (typeof data?.token === 'string' && data.token) {
        spare = { token: data.token, at: Date.now() }
      }
    })
    .catch(() => {
      // Offline or refused: nothing kept
    })
    .finally(() => {
      clearTimeout(timer)
      inflight = false
    })
}
