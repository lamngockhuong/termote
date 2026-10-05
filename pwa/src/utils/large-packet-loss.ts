// Small requests get through but large replies never arrive: the network
// drops packets above some size without telling either end (seen on mobile
// data, where the carrier's IPv6 path is narrower than Tailscale's tunnel).
// The session poll and the terminal stream report it; the app explains the
// fix once.

type Listener = () => void

const listeners = new Set<Listener>()

export const LARGE_PACKET_HELP_URL =
  'https://termote.ohnice.app/installation/tailscale/#stalls-on-mobile-data'

export function reportLargePacketLoss(): void {
  for (const listener of listeners) listener()
}

// Returns the unsubscribe function, so it can be an effect's cleanup.
export function onLargePacketLoss(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// A fetch given up by AbortSignal.timeout (some engines report AbortError).
export function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  )
}
