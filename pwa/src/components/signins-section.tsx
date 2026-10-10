import { useState } from 'react'
import { revokeSignin, type SignedInBrowser } from '../hooks/use-mux-api'
import { useSignins } from '../hooks/use-signins'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { formatAgo } from './updates-section'

const VIA_LABEL: Record<SignedInBrowser['via'], string> = {
  form: 'Sign-in form',
  basic: 'Basic auth',
  link: 'Link from the CLI',
}

// Order matters: Edge and Opera name Chrome too, Chrome names Safari.
const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\b(OPR|Opera)\//, 'Opera'],
  [/\b(Firefox|FxiOS)\//, 'Firefox'],
  [/\b(Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
]
const SYSTEMS: Array<[RegExp, string]> = [
  [/\bAndroid\b/, 'Android'],
  [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bLinux\b/, 'Linux'],
]

// "Firefox on Linux" from a User-Agent; a client that is no known browser
// is named by its first word (curl/8.5.0 → curl).
export function browserLabel(ua: string): string {
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1]
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1]
  if (browser && system) return `${browser} on ${system}`
  if (browser) return browser
  const first = ua.trim().split(/[\s/]/)[0]
  if (first && first !== 'Mozilla') return first
  return system ? `A browser on ${system}` : 'Unknown browser'
}

function lastUse(s: SignedInBrowser, now: number): string {
  return `used ${formatAgo(Math.max(0, now - Date.parse(s.lastUsedAt)))}`
}

interface Props {
  // Signs this browser out: the app's Log out, which stops this device's
  // pushes first. Without it, the row's session is revoked and onSignedOut
  // runs.
  logOut?: () => Promise<void> | void
  // Signing this browser out ends this page's session, like Log out
  onSignedOut?: () => void
}

type Pending = { kind: 'one'; session: SignedInBrowser } | { kind: 'others' }

// Settings > Signed-in browsers: the browsers signed in with the password,
// signed out one at a time or all but this one. A paired device sees the
// list without the buttons (only the password signs browsers out); a
// view-only one never sees the section.
export function SigninsSection({
  logOut,
  onSignedOut = () => window.location.assign('/login'),
}: Props) {
  const { sessions, canRevoke, error, revoke, revokeOthers } = useSignins(true)
  const [pending, setPending] = useState<Pending | null>(null)
  const [problem, setProblem] = useState<string>()
  const [done, setDone] = useState<string>()
  const now = Date.now()
  const others = sessions?.filter((s) => !s.current) ?? []

  const confirm = async () => {
    const p = pending!
    setPending(null)
    setProblem(undefined)
    setDone(undefined)
    try {
      if (p.kind === 'others') {
        const n = await revokeOthers()
        setDone(
          n === 1
            ? 'Signed out 1 other browser'
            : `Signed out ${n} other browsers`,
        )
        return
      }
      const label = browserLabel(p.session.userAgent)
      // This browser: signed out at once, the list is never read again
      if (p.session.current) {
        if (logOut) {
          await logOut()
          return
        }
        await revokeSignin(p.session.id)
        onSignedOut()
        return
      }
      await revoke(p.session.id)
      setDone(`Signed out ${label}`)
    } catch {
      setProblem(
        p.kind === 'others'
          ? 'Could not sign the other browsers out. Try again'
          : `Could not sign ${browserLabel(p.session.userAgent)} out. Try again`,
      )
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <p className="m-0 text-[12px] text-fg-muted">
        Signing out ends the browser's cookie. If the password may be known, run{' '}
        <code>termote start --fresh</code>.
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
      {sessions && sessions.length === 0 && (
        <p className="m-0 text-sm text-fg-muted">
          No browser is signed in with the password.
        </p>
      )}
      {sessions && sessions.length > 0 && (
        <ul
          aria-label="Signed-in browsers"
          className="m-0 flex list-none flex-col p-0"
        >
          {sessions.map((s) => {
            const label = browserLabel(s.userAgent)
            return (
              <li
                key={s.id}
                className="flex min-h-12 items-center gap-3 border-b border-border py-1.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p
                    className="m-0 truncate text-[15px] text-fg"
                    title={s.userAgent || undefined}
                  >
                    {label}
                    {s.current && (
                      <span className="ml-2 text-[12px] text-fg-muted">
                        This browser
                      </span>
                    )}
                  </p>
                  <p className="m-0 truncate text-[12px] text-fg-muted">
                    {VIA_LABEL[s.via] ?? s.via}
                    {s.ip && ` · ${s.ip}`} · {lastUse(s, now)}
                  </p>
                </div>
                {canRevoke && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setPending({ kind: 'one', session: s })}
                    aria-label={`Sign out ${label}${s.current ? ' (this browser)' : ''}`}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {canRevoke && others.length > 0 && (
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => setPending({ kind: 'others' })}
        >
          Sign out all others
        </Button>
      )}
      <ConfirmDialog
        isOpen={!!pending}
        title={
          pending?.kind === 'others'
            ? 'Sign out every other browser?'
            : 'Sign out this browser?'
        }
        confirmLabel="Sign out"
        destructive
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      >
        <p className="m-0">
          {pending?.kind === 'others'
            ? `${others.length === 1 ? '1 browser is' : `${others.length} browsers are`} signed out at the next request, and their open terminals close. This browser stays signed in.`
            : pending?.session.current
              ? 'This is the browser you are using: it is signed out at once.'
              : `${pending ? browserLabel(pending.session.userAgent) : ''} is signed out at its next request, and its open terminals close.`}
        </p>
      </ConfirmDialog>
    </div>
  )
}
