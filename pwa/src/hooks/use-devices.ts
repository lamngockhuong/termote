import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageKey } from '../i18n/messages/en'
import {
  createPairingCode,
  fetchDevices,
  type PairedDevice,
  type PairingCode,
  RequestError,
  revokeDevice,
} from './use-mux-api'

export interface DevicesState {
  // null until the first read answers
  devices: PairedDevice[] | null
  // Why the last read failed; cleared by the next one that works
  error: MessageKey | null
  refresh: () => Promise<void>
  // Resolves to the ids revoked (the device and those it paired) once they
  // are gone from the list; throws RequestError
  revoke: (id: string) => Promise<string[]>
  // Throws RequestError (too_many_codes, invalid_name, invalid_validity,
  // full_needs_password)
  pair: (
    role: 'full' | 'view',
    name: string,
    validFor: number | null,
  ) => Promise<PairingCode>
}

// The paired devices, read when enabled (Settings shows the section) and
// again after each revoke or pairing code, which a device spends later.
export function useDevices(enabled: boolean): DevicesState {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null)
  const [error, setError] = useState<MessageKey | null>(null)
  // Only the latest read lands: a slow one never replaces a newer list.
  const readRef = useRef(0)

  const refresh = useCallback(async () => {
    const id = ++readRef.current
    try {
      const list = await fetchDevices()
      if (id !== readRef.current) return
      setDevices(list)
      setError(null)
    } catch {
      if (id !== readRef.current) return
      setError('dialogs.devices.readFailed')
    }
  }, [])

  useEffect(() => {
    if (enabled) void refresh()
  }, [enabled, refresh])

  const revoke = useCallback(
    async (id: string) => {
      let gone = [id]
      try {
        gone = await revokeDevice(id)
      } catch (err) {
        // Revoked meanwhile (another device, the CLI): gone all the same.
        if (!(err instanceof RequestError && err.code === 'unknown_device')) {
          throw err
        }
      }
      setDevices((list) => list?.filter((d) => !gone.includes(d.id)) ?? null)
      void refresh()
      return gone
    },
    [refresh],
  )

  const pair = useCallback(
    (role: 'full' | 'view', name: string, validFor: number | null) =>
      createPairingCode(role, name, validFor),
    [],
  )

  return { devices, error, refresh, revoke, pair }
}
