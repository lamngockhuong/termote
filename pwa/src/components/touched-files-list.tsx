import { ChevronRight } from 'lucide-react'
import { useId, useState } from 'react'
import { type ChangeSide, useGitChanges } from '../hooks/use-git-changes'
import type {
  ChangeEntry,
  HistoryAgent,
  TouchedFile,
} from '../hooks/use-mux-api'
import {
  type TouchedError,
  type TouchedState,
  useTouchedFiles,
} from '../hooks/use-touched-files'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { ChangeRowButton } from './change-status'
import { FOCUS_RING } from './ui/button'
import { SkeletonLines } from './ui/skeleton'

// Where a touched file opens: its diff in Changes while git lists it, else
// the file in Files; a file deleted since opens nowhere.
export type TouchedTarget =
  | { kind: 'diff'; side: ChangeSide }
  | { kind: 'file'; path: string }

export interface TouchedRow {
  file: TouchedFile
  // The git status letter, '' when git lists no change of it
  code: string
  // git status was read and lists no change of it
  clean: boolean
  target?: TouchedTarget
}

// A touched file with its git status from entries (undefined: not read, or
// no repository). A change on the worktree side opens that side's diff, one
// only staged the staged side's.
export function touchedRow(
  file: TouchedFile,
  entries: ChangeEntry[] | undefined,
): TouchedRow {
  const entry = entries?.find((e) => e.path === file.path)
  if (entry) {
    const staged = !entry.conflict && !entry.unstaged
    const code = entry.conflict
      ? 'U'
      : ((staged ? entry.staged : entry.unstaged) as string)
    return {
      file,
      code,
      clean: false,
      target: {
        kind: 'diff',
        side: { path: entry.path, orig: entry.orig, staged },
      },
    }
  }
  const ops = file.ops ?? []
  const gone = ops.includes('delete') && !ops.includes('write')
  return {
    file,
    code: '',
    clean: !!entries,
    target: gone ? undefined : { kind: 'file', path: file.path },
  }
}

const ERRORS: Record<TouchedError, MessageKey> = {
  'view-only': 'files.touched.viewOnly',
  none: 'files.touched.none',
  failed: 'files.touched.failed',
}

const Note = ({ children }: { children: string }) => (
  <p className="m-0 px-3 py-1 text-[12px] text-fg-subtle">{children}</p>
)

const Badge = ({ children, title }: { children: string; title?: string }) => (
  <span
    title={title}
    className="shrink-0 rounded-control border border-border px-1 text-[11px] text-fg-muted"
  >
    {children}
  </span>
)

// The files a session changed, the latest first, each with its git status
// now. The note on shell commands always shows: the list is never all a
// session changed.
export function TouchedFilesList({
  state,
  entries,
  onOpen,
}: {
  state: TouchedState
  entries: ChangeEntry[] | undefined
  onOpen: (target: TouchedTarget) => void
}) {
  const { t } = useT()
  const { data, error } = state
  if (!data) {
    if (error) {
      return (
        <p role="alert" className="m-0 px-3 py-3 text-[13px] text-fg-muted">
          {t(ERRORS[error])}
        </p>
      )
    }
    return <SkeletonLines label={t('files.loading')} icon className="py-3" />
  }
  return (
    <section aria-label={t('files.touched.list')} className="py-1">
      <Note>{t('files.touched.shellNote')}</Note>
      {data.skipped > 0 && (
        <Note>{t('files.touched.skipped', { count: data.skipped })}</Note>
      )}
      {data.truncated && <Note>{t('files.touched.truncated')}</Note>}
      {data.files.length === 0 ? (
        <p role="status" className="m-0 px-3 py-2 text-[13px] text-fg-muted">
          {t('files.touched.empty')}
        </p>
      ) : (
        <ul>
          {data.files.map((f) => {
            const row = touchedRow(f, entries)
            const target = row.target
            return (
              <li key={f.path}>
                <ChangeRowButton
                  code={row.code}
                  path={f.path}
                  sensitive={f.sensitive}
                  disabled={!target}
                  onOpen={() => target && onOpen(target)}
                  className="w-full hover:bg-surface"
                  extra={
                    <>
                      {f.running && <Badge>{t('files.touched.running')}</Badge>}
                      {f.sub && <Badge>{t('files.touched.sub')}</Badge>}
                      {!!f.count && f.count > 1 && (
                        <Badge
                          title={t('files.touched.countTitle', {
                            count: f.count,
                          })}
                        >
                          {t('files.touched.count', { count: f.count })}
                        </Badge>
                      )}
                      {!target ? (
                        <Badge>{t('files.touched.gone')}</Badge>
                      ) : (
                        row.clean && <Badge>{t('files.touched.clean')}</Badge>
                      )}
                    </>
                  }
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// A section of an old session's screen: the files it changed, read once
// it is opened. onOpen gets the pane's root (known once git status is
// read: a row opens nothing before).
export function TouchedFilesSection({
  paneId,
  agent,
  sessionId,
  onOpen,
}: {
  paneId: string
  agent: HistoryAgent
  sessionId: string
  onOpen: (target: TouchedTarget, root: string) => void
}) {
  const { t } = useT()
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <div className="shrink-0 border-b border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className={`flex min-h-9 w-full items-center gap-1.5 px-3 text-left text-[13px] text-fg-muted hover:text-fg pointer-coarse:min-h-touch ${FOCUS_RING}`}
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {t('chat.history.touched')}
      </button>
      {open && (
        <div id={id} className="max-h-[40vh] overflow-y-auto">
          <SessionTouched
            paneId={paneId}
            agent={agent}
            sessionId={sessionId}
            onOpen={onOpen}
          />
        </div>
      )}
    </div>
  )
}

function SessionTouched({
  paneId,
  agent,
  sessionId,
  onOpen,
}: {
  paneId: string
  agent: HistoryAgent
  sessionId: string
  onOpen: (target: TouchedTarget, root: string) => void
}) {
  const state = useTouchedFiles(paneId, true, { agent, id: sessionId })
  const c = useGitChanges(paneId)
  const root = c.loaded ? c.root : undefined
  return (
    <TouchedFilesList
      state={state}
      entries={root && c.isRepo ? c.entries : undefined}
      onOpen={(target) => root && onOpen(target, root)}
    />
  )
}
