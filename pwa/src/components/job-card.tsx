import {
  ChevronDown,
  GitBranch,
  KeyRound,
  Pencil,
  SquareTerminal,
} from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import type { Job, JobLiveStatus, JobState } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { formatAgo } from '../utils/format-ago'
import { activeGrants, grantLabel, jobPaneRef } from '../utils/jobs'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button, FOCUS_RING } from './ui/button'

export const JOB_STATE_WORDS: Record<JobState, MessageKey> = {
  todo: 'jobs.state.todo',
  active: 'jobs.state.active',
  review: 'jobs.state.review',
  done: 'jobs.state.done',
  failed: 'jobs.state.failed',
  abandoned: 'jobs.state.abandoned',
}

const LIVE_WORDS: Record<JobLiveStatus, MessageKey> = {
  working: 'jobs.live.working',
  blocked: 'jobs.live.blocked',
  background: 'jobs.live.background',
  idle: 'jobs.live.idle',
  gone: 'jobs.live.gone',
  unknown: 'jobs.live.unknown',
}

const LIVE_TONE: Record<JobLiveStatus, string> = {
  working: 'text-warning',
  blocked: 'text-danger',
  background: 'text-warning',
  idle: 'text-fg-muted',
  gone: 'text-fg-subtle',
  unknown: 'text-fg-subtle',
}

// A history line's words, by its kind; one this version does not know is
// told by its kind alone
const EVENT_WORDS: Record<string, MessageKey> = {
  created: 'jobs.event.created',
  started: 'jobs.event.started',
  continued: 'jobs.event.continued',
  sent: 'jobs.event.sent',
  read: 'jobs.event.read',
  answered: 'jobs.event.answered',
  delegated: 'jobs.event.delegated',
  reported: 'jobs.event.reported',
  stopped: 'jobs.event.stopped',
  diff: 'jobs.event.diff',
  state: 'jobs.event.state',
  agent: 'jobs.event.agent',
  note: 'jobs.event.note',
  grant: 'jobs.event.grant',
  revoked: 'jobs.event.revoked',
}

interface Props {
  job: Job
  // Server time (ms)
  now: number
  // Opens the pane of the job's agent; absent when it is not among the
  // agents the overview shows
  onOpenPane?: (paneId: string) => void
  // Absent on a view-only device
  onEdit?: (job: Job) => void
  // Absent where the job takes no grant (view-only, finished, no agent)
  onGrants?: (job: Job) => void
}

// One job of the Plan section: its title, what its agent does, its pane,
// branch and last diff, and the grants in force. A full client opens its
// prompt, note, directory, history and the answers given under a grant.
export function JobCard({ job, now, onOpenPane, onEdit, onGrants }: Props) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const title = visibleUnsafe(job.title)
  const status = job.live.status
  const paneId = job.live.paneId
  const ref = jobPaneRef(job)
  // A job made without a worktree, or given a pane outside it, shows its
  // pane's folder and branch now.
  const tree = job.live.outsideWorktree ? undefined : job.worktree
  const branch = tree?.branch ?? job.branch ?? job.live.branch
  const dir = tree?.dir ?? job.live.dir
  const grants = activeGrants(job, now)
  const uses = (job.grants ?? [])
    .flatMap((g) => g.uses ?? [])
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const events = [...(job.events ?? [])].reverse()
  const hasDetails =
    !!job.prompt || !!job.note || !!dir || uses.length > 0 || events.length > 0
  const ago = (at: string) => formatAgo(Math.max(0, now - Date.parse(at)), t)

  return (
    <article
      aria-label={title}
      data-testid="job-card"
      className="flex flex-col gap-1.5 rounded-panel border border-border bg-surface p-2.5 text-[13px]"
    >
      <div className="flex items-start gap-2">
        <h5 className="m-0 min-w-0 flex-1 break-words text-[14px] font-medium text-fg">
          {title}
        </h5>
        <span className="shrink-0 rounded-full border border-border px-1.5 text-[11px] text-fg-muted">
          {t(JOB_STATE_WORDS[job.state])}
        </span>
      </div>
      {(status || ref) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {status && (
            <span className={LIVE_TONE[status]}>
              {job.live.unread && status === 'idle'
                ? t('jobs.live.unread')
                : t(LIVE_WORDS[status])}
            </span>
          )}
          {ref &&
            (paneId && onOpenPane ? (
              <button
                type="button"
                onClick={() => onOpenPane(paneId)}
                aria-label={t('jobs.card.openPane', { ref })}
                className={`inline-flex min-w-0 items-center gap-1 rounded-control px-1 font-term text-[12px] text-accent hover:underline ${FOCUS_RING}`}
              >
                <SquareTerminal size={13} aria-hidden="true" />
                <span className="truncate">{ref}</span>
              </button>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1 font-term text-[12px] text-fg-muted">
                <SquareTerminal size={13} aria-hidden="true" />
                <span className="truncate">{ref}</span>
              </span>
            ))}
        </div>
      )}
      {(branch || job.diff) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-muted">
          {branch && (
            <span className="inline-flex min-w-0 items-center gap-1 font-term">
              <GitBranch size={13} aria-hidden="true" />
              <span className="truncate">{visibleUnsafe(branch)}</span>
            </span>
          )}
          {job.diff && (
            <span>
              {t('jobs.card.commits', { count: job.diff.commits })}
              {' · '}
              {t('jobs.card.files', { count: job.diff.files })}
            </span>
          )}
        </div>
      )}
      {grants.length > 0 && (
        <ul
          aria-label={t('jobs.card.grants')}
          className="m-0 flex list-none flex-wrap gap-1 p-0"
        >
          {grants.map((g) => (
            <li
              key={g.id}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[12px] text-accent"
            >
              <KeyRound size={12} aria-hidden="true" />
              <span className="truncate">{grantLabel(g, t)}</span>
            </li>
          ))}
        </ul>
      )}
      {(onEdit || onGrants || hasDetails) && (
        <div className="flex flex-wrap items-center gap-1">
          {hasDetails && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen((v) => !v)}
            >
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={open ? 'rotate-180' : ''}
              />
              {t('jobs.card.details')}
            </Button>
          )}
          <span className="flex-1" />
          {onGrants && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onGrants(job)}
              aria-label={t('jobs.card.grantsFor', { title })}
            >
              <KeyRound size={14} aria-hidden="true" />
              {t('jobs.card.grantsButton')}
            </Button>
          )}
          {onEdit && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onEdit(job)}
              aria-label={t('jobs.card.editFor', { title })}
            >
              <Pencil size={14} aria-hidden="true" />
              {t('jobs.card.edit')}
            </Button>
          )}
        </div>
      )}
      {open && (
        <div
          id={detailsId}
          className="flex flex-col gap-2 border-t border-border pt-2"
        >
          {job.prompt && (
            <Detail label={t('jobs.card.prompt')}>
              <p className="m-0 max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
                {visibleUnsafe(job.prompt, true)}
              </p>
            </Detail>
          )}
          {job.note && (
            <Detail label={t('jobs.card.note')}>
              <p className="m-0 whitespace-pre-wrap break-words">
                {visibleUnsafe(job.note, true)}
              </p>
            </Detail>
          )}
          {dir && (
            <Detail label={t('jobs.card.dir')}>
              <p className="m-0 break-all font-term text-[12px]">
                {visibleUnsafe(dir)}
              </p>
            </Detail>
          )}
          {uses.length > 0 && (
            <Detail label={t('jobs.card.delegated')}>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {uses.map((u, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: answers have no id and never move
                    key={i}
                    className="flex gap-2 text-[12px]"
                  >
                    <span className="shrink-0 text-fg-subtle">{ago(u.at)}</span>
                    <span className="min-w-0 break-all font-term">
                      {visibleUnsafe(u.command ?? u.path ?? '')}
                    </span>
                  </li>
                ))}
              </ul>
            </Detail>
          )}
          {events.length > 0 && (
            <Detail label={t('jobs.card.history')}>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {events.map((e, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: the history only grows at its end
                    key={i}
                    className="flex gap-2 text-[12px]"
                  >
                    <span className="shrink-0 text-fg-subtle">{ago(e.at)}</span>
                    <span className="min-w-0 break-words">
                      {Object.hasOwn(EVENT_WORDS, e.kind)
                        ? t(EVENT_WORDS[e.kind])
                        : e.kind}
                      {e.text && (
                        <span className="text-fg-muted">
                          {': '}
                          {e.kind === 'state' &&
                          Object.hasOwn(JOB_STATE_WORDS, e.text)
                            ? t(JOB_STATE_WORDS[e.text as JobState])
                            : visibleUnsafe(e.text)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Detail>
          )}
        </div>
      )}
    </article>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h6 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
        {label}
      </h6>
      <div className="text-fg">{children}</div>
    </div>
  )
}
