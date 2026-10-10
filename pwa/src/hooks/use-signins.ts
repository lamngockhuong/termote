import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchSignins,
  RequestError,
  revokeOtherSignins,
  revokeSignin,
  type SignedInBrowser,
} from './use-mux-api'

export interface SigninsState {
  // null until the first read answers
  sessions: SignedInBrowser[] | null
  // This client may sign browsers out (a paired device only lists them)
  canRevoke: boolean
  // Why the last read failed; cleared by the next one that works
  error: string | null
  refresh: () => Promise<void>
  // Resolves once the browser is gone from the list; throws RequestError
  revoke: (id: string) => Promise<void>
  // Signs out every browser but this one and resolves to how many went;
  // throws RequestError
  revokeOthers: () => Promise<number>
}

// The browsers signed in with the password, read when enabled (Settings
// shows the section) and again after each sign-out.
export function useSignins(enabled: boolean): SigninsState {
  const [sessions, setSessions] = useState<SignedInBrowser[] | null>(null)
  const [canRevoke, setCanRevoke] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only the latest read lands: a slow one never replaces a newer list.
  const readRef = useRef(0)

  const refresh = useCallback(async () => {
    const id = ++readRef.current
    try {
      const list = await fetchSignins()
      if (id !== readRef.current) return
      setSessions(list.sessions)
      setCanRevoke(list.canRevoke)
      setError(null)
    } catch {
      if (id !== readRef.current) return
      setError('Could not read the signed-in browsers')
    }
  }, [])

  useEffect(() => {
    if (enabled) void refresh()
  }, [enabled, refresh])

  const revoke = useCallback(
    async (id: string) => {
      try {
        await revokeSignin(id)
      } catch (err) {
        // Signed out meanwhile (another browser, the CLI, its 24 hours):
        // gone all the same.
        if (!(err instanceof RequestError && err.code === 'unknown_session')) {
          throw err
        }
      }
      setSessions((list) => list?.filter((s) => s.id !== id) ?? null)
      void refresh()
    },
    [refresh],
  )

  const revokeOthers = useCallback(async () => {
    const n = await revokeOtherSignins()
    setSessions((list) => list?.filter((s) => s.current) ?? null)
    void refresh()
    return n
  }, [refresh])

  return { sessions, canRevoke, error, refresh, revoke, revokeOthers }
}
