import { useState } from 'react'
import {
  devicesKept,
  revokeSignin,
  type SignedInBrowser,
} from '../hooks/use-mux-api'
import { useSignins } from '../hooks/use-signins'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { Trans } from '../i18n/trans'
import type { Translate } from '../i18n/translate'
import { signOutPage } from '../utils/files-persist'
import { formatAgo } from '../utils/format-ago'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'

const VIA_LABEL: Record<SignedInBrowser['via'], MessageKey> = {
  form: 'settings.signins.viaForm',
  basic: 'settings.signins.viaBasic',
  link: 'settings.signins.viaLink',
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
export function browserLabel(ua: string, t: Translate<MessageKey>): string {
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1]
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1]
  if (browser && system)
    return t('settings.signins.browserOn', { browser, system })
  if (browser) return browser
  const first = ua.trim().split(/[\s/]/)[0]
  if (first && first !== 'Mozilla') return first
  return system
    ? t('settings.signins.aBrowserOn', { system })
    : t('settings.signins.unknown')
}

function lastUse(
  s: SignedInBrowser,
  now: number,
  t: Translate<MessageKey>,
): string {
  return t('settings.used', {
    ago: formatAgo(Math.max(0, now - Date.parse(s.lastUsedAt)), t),
  })
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
export function SigninsSection({ logOut, onSignedOut = signOutPage }: Props) {
  const { t } = useT()
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
        setDone(t('settings.signins.signedOutOthers', { count: n }))
        return
      }
      const label = browserLabel(p.session.userAgent, t)
      // This browser: signed out at once, the list is never read again
      if (p.session.current) {
        if (logOut) {
          await logOut()
          return
        }
        try {
          await revokeSignin(p.session.id)
        } catch (err) {
          // Signed out all the same: only its devices stay
          if (!devicesKept(err)) throw err
        }
        onSignedOut()
        return
      }
      await revoke(p.session.id)
      setDone(t('settings.signins.signedOut', { name: label }))
    } catch (err) {
      const kept = devicesKept(err)
      if (p.kind === 'others')
        setProblem(
          t(
            kept
              ? 'settings.signins.keptOthers'
              : 'settings.signins.failedOthers',
          ),
        )
      else
        setProblem(
          t(kept ? 'settings.signins.keptOne' : 'settings.signins.failedOne', {
            name: browserLabel(p.session.userAgent, t),
          }),
        )
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <p className="m-0 text-[12px] text-fg-muted">
        <Trans
          k="settings.signins.intro"
          tags={{ code: (s) => <code>{s}</code> }}
        />
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
          {t('settings.signins.none')}
        </p>
      )}
      {sessions && sessions.length > 0 && (
        <ul
          aria-label={t('settings.group.signins')}
          className="m-0 flex list-none flex-col p-0"
        >
          {sessions.map((s) => {
            const label = browserLabel(s.userAgent, t)
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
                        {t('settings.signins.thisBrowser')}
                      </span>
                    )}
                  </p>
                  <p className="m-0 truncate text-[12px] text-fg-muted">
                    {VIA_LABEL[s.via] ? t(VIA_LABEL[s.via]) : s.via}
                    {s.ip && ` · ${s.ip}`} · {lastUse(s, now, t)}
                  </p>
                </div>
                {canRevoke && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setPending({ kind: 'one', session: s })}
                    aria-label={t(
                      s.current
                        ? 'settings.signins.signOutCurrent'
                        : 'settings.signins.signOutName',
                      { name: label },
                    )}
                  >
                    {t('settings.signins.signOut')}
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
          {t('settings.signins.signOutOthers')}
        </Button>
      )}
      <ConfirmDialog
        isOpen={!!pending}
        title={t(
          pending?.kind === 'others'
            ? 'settings.signins.confirmOthersTitle'
            : 'settings.signins.confirmTitle',
        )}
        confirmLabel={t('settings.signins.signOut')}
        destructive
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      >
        <p className="m-0">
          {pending?.kind === 'others'
            ? t('settings.signins.confirmOthers', { count: others.length })
            : pending?.session.current
              ? t(
                  logOut
                    ? 'settings.signins.confirmCurrent'
                    : 'settings.signins.confirmCurrentDevices',
                )
              : t('settings.signins.confirmOther', {
                  name: pending
                    ? browserLabel(pending.session.userAgent, t)
                    : '',
                })}
        </p>
      </ConfirmDialog>
    </div>
  )
}
