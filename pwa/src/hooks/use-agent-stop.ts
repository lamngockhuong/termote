import { useCallback, useEffect, useRef, useState } from 'react'
import { interruptAgent } from './use-mux-api'

// How long a Stop shows as stopping at most when the pane's status does not
// change: the server answers once the key is sent, not once the agent
// stopped.
export const STOP_HOLD_MS = 10_000

interface Pending {
  paneId: string
  status?: string
  since?: string
}

// A Stop of the agent in paneId: stopping from the press until the pane's
// status (or when it began) changes, at most STOP_HOLD_MS, and never for
// another pane (the composer stays mounted as the pane changes). stop
// resolves to the error to show, or null; an answer for a pane no longer
// shown is dropped.
export function useAgentStop(
  paneId: string,
  status: string | undefined,
  since: string | undefined,
) {
  const [pending, setPending] = useState<Pending | null>(null)
  const shown = useRef(paneId)
  shown.current = paneId
  useEffect(() => {
    if (pending && pending.paneId !== paneId) setPending(null)
  }, [paneId, pending])
  const stopping =
    !!pending &&
    pending.paneId === paneId &&
    pending.status === status &&
    pending.since === since
  useEffect(() => {
    if (!stopping) return
    const id = setTimeout(() => setPending(null), STOP_HOLD_MS)
    return () => clearTimeout(id)
  }, [stopping])
  const stop = useCallback(
    async (cursor: string): Promise<unknown> => {
      const target = paneId
      setPending({ paneId: target, status, since })
      try {
        await interruptAgent(target, cursor)
        return null
      } catch (err) {
        if (shown.current !== target) return null
        setPending(null)
        return err
      }
    },
    [paneId, status, since],
  )
  return { stopping, stop }
}
