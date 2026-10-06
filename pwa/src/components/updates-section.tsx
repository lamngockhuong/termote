import { Check, Copy, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { InstallKind } from '../hooks/use-mux-api'
import { compareVersions, useUpdateCheck } from '../hooks/use-update-check'
import { APP_INFO } from '../utils/app-info'
import type { ServerInfo } from '../utils/app-update'
import { Button, FOCUS_RING } from './ui/button'

// How to update each kind of install. The container's image comes from the
// host's termote, so it is updated there and the container made again. A
// checkout's commands differ by OS (make, termote.sh or termote.ps1), and an
// unknown install has none: those get a hint and the release notes only.
const UPDATE_HOW: Record<InstallKind, { where: string; command?: string }> = {
  release: {
    where: 'Run in a terminal on the host (a Termote one works too):',
    command: 'termote update',
  },
  container: {
    where:
      'Run on the host, not in this container (a container built from a checkout: git pull, then termote container up --build):',
    command: 'termote update && termote container up',
  },
  checkout: {
    where:
      'This server runs from a git checkout: pull, rebuild and restart it there.',
  },
  unknown: {
    where: 'Update it the way it was installed.',
  },
}

export function formatAgo(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  return `${Math.floor(min / 60)} h ago`
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
  const { latest, checking, failed, check } = useUpdateCheck()
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(null)

  // Opening Settings reads the kept result, or asks GitHub once an hour.
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
  const hasUpdate = !!latest && compareVersions(running, latest.version) < 0
  const how = UPDATE_HOW[server?.install ?? 'unknown']
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
  if (failed) status = 'Could not reach GitHub to check for updates.'
  else if (!latest) status = checking ? 'Checking for updates…' : ''
  else if (hasUpdate) status = `Version ${latest.version} is available.`
  else status = 'You are on the newest version.'

  return (
    <div className="flex flex-col gap-3 px-4 py-3 ui-native:bg-surface-raised">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-40">
          <p className="m-0 text-[15px] text-fg ui-terminal:font-label ui-terminal:text-[13px]">
            Running v{running}
          </p>
          <p className="m-0 text-[12px] text-fg-muted">
            {latest
              ? `Newest v${latest.version} · checked ${formatAgo(Date.now() - latest.checkedAt)}`
              : 'Not checked yet'}
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
          {checking ? 'Checking…' : 'Check for updates'}
        </Button>
      </div>

      {stale && server && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control bg-info/12 px-3 py-2">
          <p className="m-0 min-w-0 flex-1 basis-40 text-[13px] text-fg">
            This page is v{APP_INFO.version}; reload to use v{server.version}.
          </p>
          <Button
            variant="primary"
            size="sm"
            disabled={reloading}
            onClick={onReload}
          >
            {reloading ? 'Reloading…' : 'Reload'}
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
          <p className="m-0 text-[12px] text-fg-muted">{how.where}</p>
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
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <span role="status" className="sr-only">
                {copied ? 'Command copied' : ''}
              </span>
            </>
          )}
          <a
            href={latest.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`self-start text-[13px] text-accent hover:underline ${FOCUS_RING}`}
          >
            Release notes for v{latest.version}
          </a>
        </div>
      )}
    </div>
  )
}
