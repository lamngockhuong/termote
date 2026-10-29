import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useDevices } from '../hooks/use-devices'
import { type PairedDevice, revokeDevice } from '../hooks/use-mux-api'
import type { Locale } from '../i18n'
import { formatDate } from '../i18n/format'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { Trans } from '../i18n/trans'
import type { Translate } from '../i18n/translate'
import { signOutPage } from '../utils/files-persist'
import { formatAgo } from '../utils/format-ago'
import { PairDeviceSheet, SECURITY_MODEL_URL } from './pair-device-sheet'
import { Button, FOCUS_RING } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'

// The server keeps names free of control and format characters.
const ROLE_LABEL: Record<PairedDevice['role'], MessageKey> = {
  full: 'settings.devices.full',
  view: 'settings.devices.viewOnly',
}

// "used 3 min ago", or when it was paired for a device not used since.
function lastUse(
  d: PairedDevice,
  now: number,
  t: Translate<MessageKey>,
): string {
  const used = Date.parse(d.lastUsedAt)
  if (Number.isFinite(used) && used > 0)
    return t('settings.used', { ago: formatAgo(now - used) })
  return t('settings.paired', {
    ago: formatAgo(now - Date.parse(d.createdAt)),
  })
}

// Where a device came from. One paired with the password stays when a
// browser signs out: the CLI pairs that way, and so did a signed-in browser
// before 2.0.1.
export function originLabel(d: PairedDevice, t: Translate<MessageKey>): string {
  if (d.pairedBy === 'password') return t('settings.devices.byPassword')
  if (d.pairedBy === 'unknown' || !d.pairedBy)
    return t('settings.devices.unknownOrigin')
  // The session's id, as `termote devices` and `termote signins` show it
  if (d.pairedBy.startsWith('session:'))
    return t('settings.devices.fromSignin', {
      id: d.pairedBy.slice('session:'.length),
    })
  if (d.pairedByName)
    return t('settings.devices.pairedBy', { name: d.pairedByName })
  return t('settings.devices.byRemoved')
}

// "Valid until Oct 17, 2026" (the date as locale writes it), "Expired", or
// nothing without a limit.
export function validityLabel(
  d: PairedDevice,
  t: Translate<MessageKey>,
  locale: Locale,
): string | null {
  if (d.expired) return t('settings.devices.expired')
  if (!d.validUntil) return null
  const at = new Date(d.validUntil)
  if (Number.isNaN(at.getTime())) return null
  return t('settings.devices.validUntil', { date: formatDate(at, locale) })
}

interface Props {
  // Revoking the device this page runs on signs it out, like Log out
  onSignedOut?: () => void
}

// Settings > Devices: the devices paired with this server, revoked one at a
// time, and the pairing of a new one. Shown to a full client only; the
// server refuses every route here to a view-only one.
export function DevicesSection({ onSignedOut = signOutPage }: Props) {
  const { t, locale } = useT()
  const { devices, error, refresh, revoke, pair } = useDevices(true)
  const [pairing, setPairing] = useState(false)
  const [pending, setPending] = useState<PairedDevice | null>(null)
  const [problem, setProblem] = useState<string>()
  const [done, setDone] = useState<string>()
  const now = Date.now()
  const current = devices?.find((d) => d.current)
  const left = current?.validUntil
    ? Math.max(0, Math.floor((Date.parse(current.validUntil) - now) / 1000))
    : undefined
  // The devices a revoke takes along: the ones the device paired. Asked
  // only of a device picked from the list.
  const pairedBy = (id: string) => devices!.filter((d) => d.pairedBy === id)

  const confirmRevoke = async () => {
    const d = pending!
    setPending(null)
    setProblem(undefined)
    setDone(undefined)
    try {
      // This device: signed out at once, the list is never read again
      if (d.current) {
        await revokeDevice(d.id)
        onSignedOut()
        return
      }
      // Named from the list as it was: the server's answer says which
      // went, the list may be older.
      const names = new Map(devices?.map((x) => [x.id, x.name]))
      const also = (await revoke(d.id))
        .filter((id) => id !== d.id)
        .map((id) => names.get(id) ?? id)
      setDone(
        also.length
          ? t('settings.devices.revokedAlso', {
              name: d.name,
              names: also.join(', '),
            })
          : t('settings.devices.revoked', { name: d.name }),
      )
    } catch {
      setProblem(t('settings.devices.revokeFailed', { name: d.name }))
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <p className="m-0 text-[12px] text-fg-muted">
        {t('settings.devices.intro')}
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
      {done && (
        <p role="status" className="m-0 text-sm text-fg-muted">
          {done}
        </p>
      )}
      {devices && devices.length === 0 && (
        <p className="m-0 text-sm text-fg-muted">
          {t('settings.devices.none')}
        </p>
      )}
      {devices && devices.length > 0 && (
        <ul
          aria-label={t('settings.devices.list')}
          className="m-0 flex list-none flex-col p-0"
        >
          {devices.map((d) => {
            const validity = validityLabel(d, t, locale)
            return (
              <li
                key={d.id}
                className="flex min-h-12 items-center gap-3 border-b border-border py-1.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-[15px] text-fg">
                    {d.name}
                    {d.current && (
                      <span className="ml-2 text-[12px] text-fg-muted">
                        {t('settings.devices.thisDevice')}
                      </span>
                    )}
                  </p>
                  <p className="m-0 text-[12px] text-fg-muted">
                    {t(ROLE_LABEL[d.role])} · {lastUse(d, now, t)}
                  </p>
                  <p className="m-0 text-[12px] text-fg-muted">
                    {originLabel(d, t)}
                    {validity && (
                      <span className={d.expired ? 'text-danger' : undefined}>
                        {' · '}
                        {validity}
                      </span>
                    )}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setPending(d)}
                  aria-label={t('settings.devices.revokeName', {
                    name: d.name,
                  })}
                >
                  {t('settings.devices.revoke')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {/* What the sheet offers depends on this device's row: wait for it */}
      <Button
        variant="primary"
        className="self-start"
        disabled={!devices}
        onClick={() => setPairing(true)}
      >
        <Plus size={16} aria-hidden="true" />
        {t('settings.devices.pair')}
      </Button>
      <PairDeviceSheet
        isOpen={pairing}
        onClose={() => {
          setPairing(false)
          // The new device may have paired meanwhile
          void refresh()
        }}
        onPair={pair}
        canPairFull={!current}
        validityLeft={left}
      />
      <ConfirmDialog
        isOpen={!!pending}
        title={t('settings.devices.confirmTitle')}
        confirmLabel={t('settings.devices.revoke')}
        destructive
        onConfirm={confirmRevoke}
        onCancel={() => setPending(null)}
      >
        <p className="m-0">
          {pending?.current
            ? t('settings.devices.confirmCurrent')
            : t('settings.devices.confirmOther', { name: pending?.name ?? '' })}
        </p>
        {pending && pairedBy(pending.id).length > 0 && (
          <p className="m-0 mt-2">
            {t('settings.devices.confirmPaired', {
              names: pairedBy(pending.id)
                .map((d) => d.name)
                .join(', '),
            })}
          </p>
        )}
        {pending?.role === 'full' && (
          <p className="m-0 mt-2">
            <Trans
              k="settings.devices.confirmFull"
              tags={{ code: (s) => <code>{s}</code> }}
            />{' '}
            <a
              href={SECURITY_MODEL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-accent hover:underline ${FOCUS_RING}`}
            >
              {t('settings.securityModel')}
            </a>
          </p>
        )}
      </ConfirmDialog>
    </div>
  )
}
