import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useDevices } from '../hooks/use-devices'
import { type PairedDevice, revokeDevice } from '../hooks/use-mux-api'
import { PairDeviceSheet } from './pair-device-sheet'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { formatAgo } from './updates-section'

// The server keeps names free of control and format characters.
const ROLE_LABEL: Record<PairedDevice['role'], string> = {
  full: 'Full',
  view: 'View only',
}

// "used 3 min ago", or when it was paired for a device not used since.
function lastUse(d: PairedDevice, now: number): string {
  const used = Date.parse(d.lastUsedAt)
  if (Number.isFinite(used) && used > 0) return `used ${formatAgo(now - used)}`
  return `paired ${formatAgo(now - Date.parse(d.createdAt))}`
}

interface Props {
  // Revoking the device this page runs on signs it out, like Log out
  onSignedOut?: () => void
}

// Settings > Devices: the devices paired with this server, revoked one at a
// time, and the pairing of a new one. Shown to a full client only; the
// server refuses every route here to a view-only one.
export function DevicesSection({
  onSignedOut = () => window.location.assign('/login'),
}: Props) {
  const { devices, error, refresh, revoke, pair } = useDevices(true)
  const [pairing, setPairing] = useState(false)
  const [pending, setPending] = useState<PairedDevice | null>(null)
  const [problem, setProblem] = useState<string>()
  const now = Date.now()

  const confirmRevoke = async () => {
    const d = pending!
    setPending(null)
    setProblem(undefined)
    try {
      // This device: signed out at once, the list is never read again
      if (d.current) {
        await revokeDevice(d.id)
        onSignedOut()
        return
      }
      await revoke(d.id)
    } catch {
      setProblem(`Could not revoke ${d.name}. Try again`)
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <p className="m-0 text-[12px] text-fg-muted">
        A paired device signs in without the password. Changing the password
        (termote start --fresh) revokes every one.
      </p>
      {error && (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}
      {problem && (
        <p role="alert" className="m-0 text-sm text-danger">
          {problem}
        </p>
      )}
      {devices && devices.length === 0 && (
        <p className="m-0 text-sm text-fg-muted">No device is paired yet.</p>
      )}
      {devices && devices.length > 0 && (
        <ul
          aria-label="Paired devices"
          className="m-0 flex list-none flex-col p-0"
        >
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex min-h-12 items-center gap-3 border-b border-border py-1.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-[15px] text-fg">
                  {d.name}
                  {d.current && (
                    <span className="ml-2 text-[12px] text-fg-muted">
                      This device
                    </span>
                  )}
                </p>
                <p className="m-0 text-[12px] text-fg-muted">
                  {ROLE_LABEL[d.role]} · {lastUse(d, now)}
                </p>
              </div>
              <Button
                size="sm"
                variant="danger"
                onClick={() => setPending(d)}
                aria-label={`Revoke ${d.name}`}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="primary"
        className="self-start"
        onClick={() => setPairing(true)}
      >
        <Plus size={16} aria-hidden="true" />
        Pair a device
      </Button>
      <PairDeviceSheet
        isOpen={pairing}
        onClose={() => {
          setPairing(false)
          // The new device may have paired meanwhile
          void refresh()
        }}
        onPair={pair}
      />
      <ConfirmDialog
        isOpen={!!pending}
        title="Revoke this device?"
        confirmLabel="Revoke"
        destructive
        onConfirm={confirmRevoke}
        onCancel={() => setPending(null)}
      >
        <p className="m-0">
          {pending?.current
            ? 'This is the device you are using: it is signed out at once.'
            : `${pending?.name} is signed out at its next request, and its open terminals close.`}
        </p>
      </ConfirmDialog>
    </div>
  )
}
