import { Check, Copy, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { InstallKind } from '../hooks/use-mux-api'
import { availableUpdate, useUpdateCheck } from '../hooks/use-update-check'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { APP_INFO } from '../utils/app-info'
import type { ServerInfo } from '../utils/app-update'
import { formatAgo } from '../utils/format-ago'
import { StarPromptCard } from './star-prompt-card'
import { Button, FOCUS_RING } from './ui/button'

// How to update each kind of install. The container's image comes from the
// host's termote, so it is updated there and the container made again. A
// checkout's commands differ by OS (make, termote.sh or termote.ps1), and an
// unknown install has none: those get a hint and the release notes only.
// A kind this page does not know (a newer server) reads as unknown.
const UPDATE_HOW: Record<InstallKind, { where: MessageKey; command?: string }> =
  {
    release: {
      where: 'settings.updates.howRelease',
      command: 'termote update',
    },
    homebrew: {
      where: 'settings.updates.howRelease',
      command: 'brew upgrade termote && termote restart',
    },
    container: {
      where: 'settings.updates.howContainer',
      command: 'termote update && termote container up',
    },
    checkout: {
      where: 'settings.updates.howCheckout',
    },
    unknown: {
      where: 'settings.updates.howUnknown',
    },
  }

interface Props {
  // What the server reported; null until its health was read
  server: ServerInfo | null
  // This page is older than the server (or a new worker waits)
  stale: boolean
  // The reload waits for the new service worker
  reloading?: boolean
  onReload: () => void
}

export function UpdatesSection({
  server,
  stale,
  reloading = false,
  onReload,
}: Props) {
  const { t } = useT()
  const { latest, checking, failed, check } = useUpdateCheck()
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(null)

  // The app checks when it opens or is shown again; a page left open past
  // the hour asks again here.
  useEffect(() => {
    check()
  }, [check])
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  // The server is what an update replaces; this page may be older.
  const running = server?.version ?? APP_INFO.version
  const hasUpdate = availableUpdate(running, latest) !== null
  const install = server?.install
  const how =
    install && Object.hasOwn(UPDATE_HOW, install)
      ? UPDATE_HOW[install]
      : UPDATE_HOW.unknown
  const command = how.command

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // No clipboard (an http page): the command stays selectable.
    }
  }

  let status: string
  if (failed) status = t('settings.updates.failed')
  else if (!latest) status = checking ? t('settings.updates.checkingFor') : ''
  else if (hasUpdate)
    status = t('settings.updates.available', { version: latest.version })
  else status = t('settings.updates.newest')

  return (
    <div className="flex flex-col gap-3 px-4 py-3 ui-native:bg-surface-raised">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-40">
          <p className="m-0 text-[15px] text-fg ui-terminal:font-label ui-terminal:text-[13px]">
            {t('settings.updates.running', { version: running })}
          </p>
          <p className="m-0 text-[12px] text-fg-muted">
            {latest
              ? t('settings.updates.checked', {
                  version: latest.version,
                  ago: formatAgo(Date.now() - latest.checkedAt, t),
                })
              : t('settings.updates.notChecked')}
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={checking}
          onClick={() => check(true)}
        >
          <RefreshCw
            size={16}
            aria-hidden="true"
            className={checking ? 'motion-safe:animate-spin' : ''}
          />
          {checking
            ? t('settings.updates.checking')
            : t('settings.updates.check')}
        </Button>
      </div>

      <StarPromptCard version={APP_INFO.version} />

      {stale && server && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control bg-info/12 px-3 py-2">
          <p className="m-0 min-w-0 flex-1 basis-40 text-[13px] text-fg">
            {t('settings.updates.stale', {
              page: APP_INFO.version,
              server: server.version,
            })}
          </p>
          <Button
            variant="primary"
            size="sm"
            disabled={reloading}
            onClick={onReload}
          >
            {reloading
              ? t('settings.updates.reloading')
              : t('settings.updates.reload')}
          </Button>
        </div>
      )}

      {/* Stays mounted so a screen reader announces the result */}
      <p
        role="status"
        className={`m-0 text-[13px] empty:hidden ${failed ? 'text-danger' : 'text-fg-muted'}`}
      >
        {status}
      </p>

      {hasUpdate && latest && (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-[12px] text-fg-muted">{t(how.where)}</p>
          {command && (
            <>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-control bg-surface px-2 py-1.5 font-mono text-[12px] text-fg select-all ui-native:bg-bg">
                  {command}
                </code>
                <Button variant="ghost" size="sm" onClick={() => copy(command)}>
                  {copied ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    <Copy size={16} aria-hidden="true" />
                  )}
                  {copied ? t('settings.copied') : t('settings.updates.copy')}
                </Button>
              </div>
              <span role="status" className="sr-only">
                {copied ? t('settings.updates.commandCopied') : ''}
              </span>
            </>
          )}
          <a
            href={latest.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`self-start text-[13px] text-accent hover:underline ${FOCUS_RING}`}
          >
            {t('settings.updates.notes', { version: latest.version })}
          </a>
        </div>
      )}
    </div>
  )
}
