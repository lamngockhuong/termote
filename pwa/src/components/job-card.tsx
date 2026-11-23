import { GitBranch, SquareTerminal } from 'lucide-react'
import { useId } from 'react'
import type { Job, JobLiveStatus, JobState } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { activeGrants, jobPaneRef } from '../utils/jobs'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { FOCUS_RING } from './ui/button'

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

export const LIVE_TONE: Record<JobLiveStatus, string> = {
  working: 'text-warning',
  blocked: 'text-danger',
  background: 'text-warning',
  idle: 'text-fg-muted',
  gone: 'text-fg-subtle',
  unknown: 'text-fg-subtle',
}

// What the job's agent does now, in words
export function jobLiveWords(job: Job, t: Translate<MessageKey>) {
  const status = job.live.status
  if (!status) return undefined
  return job.live.unread && status === 'idle'
    ? t('jobs.live.unread')
    : t(LIVE_WORDS[status])
}

// The branch a job's card and details show: its worktree's while its agent
// is in it, else its pane's (or a view-only client's brief one)
export function jobBranch(job: Job): string | undefined {
  const tree = job.live.outsideWorktree ? undefined : job.worktree
  return tree?.branch ?? job.branch ?? job.live.branch
}

interface Props {
  job: Job
  // Server time (ms)
  now: number
  // Opens the job's details; absent on a view-only device, whose card has
  // nothing to press
  onSelect?: (job: Job) => void
  // Its details are the ones open
  selected?: boolean
}

// One job of the Plan: its title and state, what its agent does, its pane
// and branch, and (a full client) its last diff and grants in force. A full
// client's card is one button opening the job's details.
export function JobCard({ job, now, onSelect, selected }: Props) {
  const { t } = useT()
  const detailsId = useId()
  const title = visibleUnsafe(job.title)
  const status = job.live.status
  const ref = jobPaneRef(job)
  const branch = jobBranch(job)
  const live = jobLiveWords(job, t)
  const grants = onSelect ? activeGrants(job, now).length : 0
  const counts = [
    onSelect &&
      job.diff &&
      `${t('jobs.card.commits', { count: job.diff.commits })} · ${t('jobs.card.files', { count: job.diff.files })}`,
    grants > 0 && t('jobs.card.grantCount', { count: grants }),
  ].filter(Boolean)

  const body = (
    <>
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-words text-[14px] font-medium text-fg">
          {title}
        </span>
        <span className="shrink-0 rounded-full border border-border px-1.5 text-[11px] text-fg-muted">
          {t(JOB_STATE_WORDS[job.state])}
        </span>
      </span>
      <span id={detailsId} className="contents">
        {(live || ref) && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {status && live && (
              <span className={LIVE_TONE[status]}>{live}</span>
            )}
            {ref && (
              <span className="inline-flex min-w-0 items-center gap-1 font-term text-[12px] text-fg-muted">
                <SquareTerminal size={13} aria-hidden="true" />
                <span className="truncate">{ref}</span>
              </span>
            )}
          </span>
        )}
        {(branch || counts.length > 0) && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-muted">
            {branch && (
              <span className="inline-flex min-w-0 items-center gap-1 font-term">
                <GitBranch size={13} aria-hidden="true" />
                <span className="truncate">{visibleUnsafe(branch)}</span>
              </span>
            )}
            {counts.map((c) => (
              <span key={c as string}>{c}</span>
            ))}
          </span>
        )}
      </span>
    </>
  )

  return (
    <article
      aria-label={title}
      data-testid="job-card"
      className={`rounded-panel border bg-surface text-[13px] ui-terminal:bg-bg ${
        selected ? 'border-accent ring-1 ring-accent' : 'border-border'
      }`}
    >
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(job)}
          aria-label={title}
          aria-describedby={detailsId}
          aria-pressed={!!selected}
          className={`flex min-h-touch w-full flex-col gap-1.5 rounded-panel p-2.5 text-left transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-raised ${FOCUS_RING}`}
        >
          {body}
        </button>
      ) : (
        <div className="flex flex-col gap-1.5 p-2.5">{body}</div>
      )}
    </article>
  )
}
