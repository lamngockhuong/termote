import { Check, Copy } from 'lucide-react'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { type PairingCode, RequestError } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { Trans } from '../i18n/trans'
import type { Translate } from '../i18n/translate'
import { Button, FOCUS_RING } from './ui/button'
import { SegmentedControl } from './ui/segmented-control'
import { Sheet } from './ui/sheet'

type Role = 'full' | 'view'

const ROLE_OPTIONS: { value: Role; label: MessageKey }[] = [
  { value: 'view', label: 'settings.devices.viewOnly' },
  { value: 'full', label: 'settings.devices.full' },
]

const ROLE_HINT: Record<Role, MessageKey> = {
  view: 'settings.pair.viewHint',
  full: 'settings.pair.fullHint',
}

// The device names the server takes: 1-64 bytes, no control characters.
const MAX_NAME_BYTES = 64

// What a paired device can and cannot be trusted with, said once.
export const SECURITY_MODEL_URL = 'https://termote.ohnice.app/usage/security/'

const DAY = 86400

// How long the new device stays signed in once paired; null is no limit.
export const VALIDITY_OPTIONS: { secs: number | null }[] = [
  { secs: DAY },
  { secs: 7 * DAY },
  { secs: 30 * DAY },
  { secs: 90 * DAY },
  { secs: null },
]

// "7 days", or "Never" for no limit
export function validityOptionLabel(
  secs: number | null,
  t: Translate<MessageKey>,
): string {
  return secs === null
    ? t('settings.pair.never')
    : t('settings.pair.days', { count: secs / DAY })
}
const DEFAULT_VALIDITY = 30 * DAY

// The options a device whose own limit is left seconds away may pick: no
// "Never", none longer than what is left. The shortest stays, so there is
// always one; the server cuts it to what is left.
export function validityChoices(left?: number) {
  if (left === undefined) {
    return VALIDITY_OPTIONS.map((o) => ({ ...o, disabled: false }))
  }
  return VALIDITY_OPTIONS.filter((o) => o.secs !== null).map((o, i) => ({
    ...o,
    disabled: i > 0 && (o.secs as number) > left,
  }))
}

// The default choice: 30 days, or the longest a limited device may pick
// (a limited device has no Never).
function defaultValidity(left?: number): number {
  const allowed = validityChoices(left).filter((o) => !o.disabled)
  return allowed.some((o) => o.secs === DEFAULT_VALIDITY)
    ? DEFAULT_VALIDITY
    : (allowed[allowed.length - 1].secs as number)
}

// "for 30 days once used", "with no time limit", from the server's answer.
export function validityNote(
  secs: number | undefined,
  t: Translate<MessageKey>,
): string {
  if (!secs) return t('settings.pair.noLimit')
  if (secs % DAY === 0) return t('settings.pair.forDays', { count: secs / DAY })
  return t('settings.pair.forHours', { count: Math.ceil(secs / 3600) })
}

function SecurityModelLink() {
  const { t } = useT()
  return (
    <a
      href={SECURITY_MODEL_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-accent hover:underline ${FOCUS_RING}`}
    >
      {t('settings.securityModel')}
    </a>
  )
}

export function pairProblem(err: unknown, t: Translate<MessageKey>): string {
  const code = err instanceof RequestError ? err.code : ''
  switch (code) {
    case 'too_many_codes':
      return t('settings.pair.tooManyCodes')
    case 'invalid_name':
      return t('settings.pair.invalidName')
    case 'view_only':
      return t('settings.pair.viewOnly')
    case 'full_needs_password':
      return t('settings.pair.fullNeedsPassword')
    case 'creator_gone':
      return t('settings.pair.creatorGone')
    case 'invalid_validity':
      return t('settings.pair.invalidValidity')
    default:
      return t('settings.pair.failed')
  }
}

// "4:59", counting down to the code's expiry; "0:00" once it passed.
export function formatLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

interface Props {
  isOpen: boolean
  onClose: () => void
  // Makes a code; throws RequestError when refused
  onPair: (
    role: Role,
    name: string,
    validFor: number | null,
  ) => Promise<PairingCode>
  // Only a password sign-in pairs a full device: false on a paired device
  canPairFull?: boolean
  // Seconds left of this device's own limit, when it has one
  validityLeft?: number
}

// Pairing a new device: pick its role (view only unless asked), how long it
// stays signed in and a name, then show the code, its QR code (drawn by the
// server) and its link until it expires. The new device enters the code at
// /pair, or opens the link.
export function PairDeviceSheet({ isOpen, ...rest }: Props) {
  if (!isOpen) return null
  return <OpenPairSheet {...rest} />
}

function OpenPairSheet({
  onClose,
  onPair,
  canPairFull = true,
  validityLeft,
}: Omit<Props, 'isOpen'>) {
  const { t } = useT()
  const [role, setRole] = useState<Role>('view')
  const [validFor, setValidFor] = useState<number | null>(() =>
    defaultValidity(validityLeft),
  )
  const [name, setName] = useState('')
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [code, setCode] = useState<PairingCode | null>(null)
  // When the code stops working, on this device's clock: the server's
  // expiresIn from the reply, so a clock set wrong does not matter
  const [deadline, setDeadline] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  const nameId = useId()
  const errorId = useId()
  const validityId = useId()
  // A reply after the sheet closed shows nothing
  const closed = useRef(false)
  useEffect(
    () => () => {
      closed.current = true
    },
    [],
  )

  // A deadline that cannot be read is no code at all
  const expired = !!code && !(now < deadline)
  useEffect(() => {
    if (!code || expired) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [code, expired])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (new TextEncoder().encode(trimmed).length > MAX_NAME_BYTES) {
      setProblem(t('settings.pair.nameTooLong', { max: MAX_NAME_BYTES }))
      return
    }
    setSending(true)
    setProblem(undefined)
    try {
      const made = await onPair(canPairFull ? role : 'view', trimmed, validFor)
      if (closed.current) return
      const at = Date.now()
      setNow(at)
      setDeadline(at + (made.expiresIn ?? Number.NaN) * 1000)
      setCode(made)
    } catch (err) {
      if (!closed.current) setProblem(pairProblem(err, t))
    } finally {
      if (!closed.current) setSending(false)
    }
  }

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // No clipboard (an http page): the link stays selectable.
    }
  }

  return (
    <Sheet isOpen onClose={onClose} title={t('settings.devices.pair')}>
      {code ? (
        <div className="flex flex-col items-center gap-3 p-4 text-center">
          {expired ? (
            <p role="alert" className="m-0 text-sm text-danger">
              {t('settings.pair.expired')}
            </p>
          ) : (
            <>
              <p className="m-0 text-sm text-fg-muted">
                {t('settings.pair.howTo')}
              </p>
              <output
                aria-label={t('settings.pair.code')}
                className="font-term text-3xl font-semibold tracking-widest text-fg"
              >
                {code.code}
              </output>
              {code.qr && (
                <img
                  src={code.qr}
                  alt={t('settings.pair.qr')}
                  width={192}
                  height={192}
                  className="size-48 rounded-control bg-white p-2 [image-rendering:pixelated]"
                />
              )}
              <p className="m-0 text-sm text-fg-muted" aria-live="off">
                {t('settings.pair.expires', {
                  left: formatLeft(deadline - now),
                })}
              </p>
              <p className="m-0 text-[12px] text-fg-muted">
                {t('settings.pair.validFor', {
                  note: validityNote(code.validFor, t),
                })}
              </p>
              <p className="m-0 w-full break-all font-term text-xs text-fg-subtle select-all">
                {code.url}
              </p>
            </>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            {!expired && (
              <Button size="sm" onClick={() => copyLink(code.url)}>
                {copied ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
                {copied ? t('settings.copied') : t('settings.pair.copyLink')}
              </Button>
            )}
            {expired && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setCode(null)
                  setCopied(false)
                }}
              >
                {t('settings.pair.newCode')}
              </Button>
            )}
            <Button size="sm" onClick={onClose}>
              {t('common.done')}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-fg-muted">
              {t('settings.pair.role')}
            </span>
            {canPairFull ? (
              <>
                <SegmentedControl
                  label={t('settings.pair.role')}
                  options={ROLE_OPTIONS.map((o) => ({
                    value: o.value,
                    content: t(o.label),
                  }))}
                  value={role}
                  onChange={setRole}
                  className="self-start"
                />
                <p className="m-0 text-[12px] text-fg-muted">
                  {t(ROLE_HINT[role])}
                </p>
              </>
            ) : (
              <p className="m-0 text-[12px] text-fg-muted">
                <Trans
                  k="settings.pair.viewOnlyOnly"
                  vars={{ hint: t(ROLE_HINT.view) }}
                  tags={{ code: (s) => <code>{s}</code> }}
                />
              </p>
            )}
            <p className="m-0 text-[12px] text-fg-muted">
              {t('settings.pair.trust')} <SecurityModelLink />
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={validityId} className="text-sm text-fg-muted">
              {t('settings.pair.validity')}
            </label>
            <select
              id={validityId}
              value={validFor ?? 'never'}
              onChange={(e) =>
                setValidFor(
                  e.target.value === 'never' ? null : Number(e.target.value),
                )
              }
              className={`h-9 self-start rounded-control border border-border bg-bg px-2 text-[13px] text-fg pointer-coarse:h-touch ${FOCUS_RING}`}
            >
              {validityChoices(validityLeft).map((o) => (
                <option
                  key={o.secs ?? 'never'}
                  value={o.secs ?? 'never'}
                  disabled={o.disabled}
                >
                  {validityOptionLabel(o.secs, t)}
                </option>
              ))}
            </select>
            {validityLeft !== undefined && (
              <p className="m-0 text-[12px] text-fg-muted">
                {t('settings.pair.outlast')}
              </p>
            )}
          </div>
          <label htmlFor={nameId} className="text-sm text-fg-muted">
            {t('settings.pair.name')}
          </label>
          <input
            id={nameId}
            type="text"
            value={name}
            placeholder={t('settings.pair.namePlaceholder')}
            maxLength={MAX_NAME_BYTES}
            autoComplete="off"
            enterKeyHint="done"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? errorId : undefined}
            onChange={(e) => {
              setName(e.target.value)
              setProblem(undefined)
            }}
            className="h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch"
          />
          {problem && (
            <p id={errorId} role="alert" className="m-0 text-sm text-danger">
              {problem}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={sending}>
              {t('settings.pair.make')}
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  )
}
