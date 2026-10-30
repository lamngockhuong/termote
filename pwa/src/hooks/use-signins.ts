import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageKey } from '../i18n/messages/en'
import {
  devicesKept,
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
  error: MessageKey | null
  refresh: () => Promise<void>
  // Resolves once the browser is gone from the list; throws RequestError
  // (devices_not_revoked: signed out, but the devices it paired stay)
  revoke: (id: string) => Promise<void>
  // Signs out every browser but this one and resolves to how many went;
  // throws RequestError, devices_not_revoked as revoke
  revokeOthers: () => Promise<number>
}

// The browsers signed in with the password, read when enabled (Settings
// shows the section) and again after each sign-out.
export function useSignins(enabled: boolean): SigninsState {
  const [sessions, setSessions] = useState<SignedInBrowser[] | null>(null)
  const [canRevoke, setCanRevoke] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)
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
      setError('dialogs.signins.readFailed')
    }
  }, [])

  useEffect(() => {
    if (enabled) void refresh()
  }, [enabled, refresh])

  const revoke = useCallback(
    async (id: string) => {
      let kept: unknown
      try {
        await revokeSignin(id)
      } catch (err) {
        // Signed out meanwhile (another browser, the CLI, its 24 hours):
        // gone all the same. devices_not_revoked: gone too.
        if (devicesKept(err)) kept = err
        else if (
          !(err instanceof RequestError && err.code === 'unknown_session')
        )
          throw err
      }
      setSessions((list) => list?.filter((s) => s.id !== id) ?? null)
      void refresh()
      if (kept) throw kept
    },
    [refresh],
  )

  const revokeOthers = useCallback(async () => {
    const gone = () => {
      setSessions((list) => list?.filter((s) => s.current) ?? null)
      void refresh()
    }
    try {
      const n = await revokeOtherSignins()
      gone()
      return n
    } catch (err) {
      if (devicesKept(err)) gone()
      throw err
    }
  }, [refresh])

  return { sessions, canRevoke, error, refresh, revoke, revokeOthers }
}
