import { Check, Copy } from 'lucide-react'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { type PairingCode, RequestError } from '../hooks/use-mux-api'
import { Button, FOCUS_RING } from './ui/button'
import { SegmentedControl } from './ui/segmented-control'
import { Sheet } from './ui/sheet'

type Role = 'full' | 'view'

const ROLE_OPTIONS = [
  { value: 'view' as const, content: 'View only' },
  { value: 'full' as const, content: 'Full' },
]

const ROLE_HINT: Record<Role, string> = {
  view: 'Watches the terminal, Chat and Files; changes nothing.',
  full: 'Everything this device can do: typing, files, agents, devices.',
}

// The device names the server takes: 1-64 bytes, no control characters.
const MAX_NAME_BYTES = 64

// What a paired device can and cannot be trusted with, said once.
export const SECURITY_MODEL_URL = 'https://termote.ohnice.app/usage/security/'

const DAY = 86400

// How long the new device stays signed in once paired; null is no limit.
export const VALIDITY_OPTIONS: { label: string; secs: number | null }[] = [
  { label: '1 day', secs: DAY },
  { label: '7 days', secs: 7 * DAY },
  { label: '30 days', secs: 30 * DAY },
  { label: '90 days', secs: 90 * DAY },
  { label: 'Never', secs: null },
]
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
export function validityNote(secs?: number): string {
  if (!secs) return 'stays signed in with no time limit'
  if (secs % DAY === 0) {
    const d = secs / DAY
    return `stays signed in for ${d} ${d === 1 ? 'day' : 'days'}`
  }
  const h = Math.ceil(secs / 3600)
  return `stays signed in for ${h} ${h === 1 ? 'hour' : 'hours'}`
}

function SecurityModelLink() {
  return (
    <a
      href={SECURITY_MODEL_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-accent hover:underline ${FOCUS_RING}`}
    >
      Security model
    </a>
  )
}

export function pairProblem(err: unknown): string {
  const code = err instanceof RequestError ? err.code : ''
  switch (code) {
    case 'too_many_codes':
      return 'Too many codes are waiting. Use one, or wait 5 minutes'
    case 'invalid_name':
      return 'Use a shorter name without special characters'
    case 'view_only':
      return 'This device is view-only'
    case 'full_needs_password':
      return 'A full device is paired from a password sign-in or the CLI'
    case 'creator_gone':
      return 'This device can no longer pair devices'
    case 'invalid_validity':
      return 'Pick how long the new device stays signed in'
    default:
      return 'Could not make a pairing code. Try again'
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
      setProblem('Use a name of at most 64 characters')
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
      if (!closed.current) setProblem(pairProblem(err))
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
    <Sheet isOpen onClose={onClose} title="Pair a device">
      {code ? (
        <div className="flex flex-col items-center gap-3 p-4 text-center">
          {expired ? (
            <p role="alert" className="m-0 text-sm text-danger">
              This code expired. Make a new one.
            </p>
          ) : (
            <>
              <p className="m-0 text-sm text-fg-muted">
                On the new device, scan the code or open the link. In the
                installed app, use “Have a pairing code?” on the sign-in page.
              </p>
              <output
                aria-label="Pairing code"
                className="font-term text-3xl font-semibold tracking-widest text-fg"
              >
                {code.code}
              </output>
              {code.qr && (
                <img
                  src={code.qr}
                  alt="QR code of the pairing link"
                  width={192}
                  height={192}
                  className="size-48 rounded-control bg-white p-2 [image-rendering:pixelated]"
                />
              )}
              <p className="m-0 text-sm text-fg-muted" aria-live="off">
                Expires in {formatLeft(deadline - now)} · works once
              </p>
              <p className="m-0 text-[12px] text-fg-muted">
                The new device {validityNote(code.validFor)}.
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
                {copied ? 'Copied' : 'Copy link'}
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
                New code
              </Button>
            )}
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-fg-muted">Role</span>
            {canPairFull ? (
              <>
                <SegmentedControl
                  label="Role"
                  options={ROLE_OPTIONS}
                  value={role}
                  onChange={setRole}
                  className="self-start"
                />
                <p className="m-0 text-[12px] text-fg-muted">
                  {ROLE_HINT[role]}
                </p>
              </>
            ) : (
              <p className="m-0 text-[12px] text-fg-muted">
                View only. {ROLE_HINT.view} Full devices are paired from a
                password sign-in or <code>termote pair --role full</code>.
              </p>
            )}
            <p className="m-0 text-[12px] text-fg-muted">
              A full device can do anything your user account can; a view device
              sees everything printed. <SecurityModelLink />
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={validityId} className="text-sm text-fg-muted">
              Stays signed in for
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
                  key={o.label}
                  value={o.secs ?? 'never'}
                  disabled={o.disabled}
                >
                  {o.label}
                </option>
              ))}
            </select>
            {validityLeft !== undefined && (
              <p className="m-0 text-[12px] text-fg-muted">
                Can't outlast this device
              </p>
            )}
          </div>
          <label htmlFor={nameId} className="text-sm text-fg-muted">
            Name (optional; the new device can name itself)
          </label>
          <input
            id={nameId}
            type="text"
            value={name}
            placeholder="Phone"
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
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={sending}>
              Make code
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  )
}
