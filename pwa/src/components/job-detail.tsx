import { KeyRound, Pencil, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'
import { agentLabel } from '../chat-agents'
import type { Job, JobState } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { formatAgo } from '../utils/format-ago'
import { activeGrants, grantLabel, jobPaneRef } from '../utils/jobs'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { JOB_STATE_WORDS, jobBranch, jobLiveWords, LIVE_TONE } from './job-card'
import { Button } from './ui/button'

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
  // Opens the pane of the job's agent; absent when the overview does not
  // show it
  onOpenPane?: (paneId: string) => void
  // Absent where the job cannot be changed, or takes no grant
  onEdit?: (job: Job) => void
  onGrants?: (job: Job) => void
}

// What a full client knows of one job, under the title its panel gives it:
// what its agent does and since when, its pane, Grants and Edit, then each
// field it has: state, agent, branch, folder, changes, prompt, note, the
// grants in force, the answers given under one, and its history.
export function JobDetail({ job, now, onOpenPane, onEdit, onGrants }: Props) {
  const { t } = useT()
  const title = visibleUnsafe(job.title)
  const status = job.live.status
  const live = jobLiveWords(job, t)
  const ref = jobPaneRef(job)
  const paneId = job.live.paneId
  const branch = jobBranch(job)
  const tree = job.live.outsideWorktree ? undefined : job.worktree
  const dir = tree?.dir ?? job.live.dir
  const grants = activeGrants(job, now)
  const uses = (job.grants ?? [])
    .flatMap((g) => g.uses ?? [])
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const events = [...(job.events ?? [])].reverse()
  const ago = (at: string) => {
    const ms = Date.parse(at)
    return Number.isFinite(ms) ? formatAgo(Math.max(0, now - ms), t) : ''
  }
  const changed = ago(job.live.lastTs ?? job.updated)
  // The agent the job was given: its product's name (else the kind the
  // server recorded) and its pane
  const kind = job.agent && agentLabel(job.agent.kind)
  const agent = job.agent
    ? [
        kind === 'agent' ? visibleUnsafe(job.agent.kind) : kind,
        visibleUnsafe(job.agent.ref || job.agent.paneId),
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      {(live || changed) && (
        <p className="m-0 flex flex-wrap gap-x-2">
          {status && live && <span className={LIVE_TONE[status]}>{live}</span>}
          {changed && (
            <span className="text-fg-muted">
              {t('jobs.detail.changed', { ago: changed })}
            </span>
          )}
        </p>
      )}
      {((ref && paneId && onOpenPane) || onGrants || onEdit) && (
        <div className="flex flex-wrap items-center gap-1">
          {ref && paneId && onOpenPane && (
            <Button
              size="sm"
              onClick={() => onOpenPane(paneId)}
              aria-label={t('jobs.card.openPane', { ref })}
            >
              <SquareTerminal size={14} aria-hidden="true" />
              <span className="truncate font-term">{ref}</span>
            </Button>
          )}
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
      <Field label={t('jobs.detail.state')}>
        {t(JOB_STATE_WORDS[job.state])}
      </Field>
      {agent && <Field label={t('jobs.detail.agent')}>{agent}</Field>}
      {branch && (
        <Field label={t('jobs.detail.branch')}>
          <span className="break-all font-term text-[12px]">
            {visibleUnsafe(branch)}
          </span>
        </Field>
      )}
      {dir && (
        <Field label={t('jobs.card.dir')}>
          <span className="break-all font-term text-[12px]">
            {visibleUnsafe(dir)}
          </span>
        </Field>
      )}
      {job.diff && (
        <Field label={t('jobs.detail.changes')}>
          {t('jobs.card.commits', { count: job.diff.commits })}
          {' · '}
          {t('jobs.card.files', { count: job.diff.files })}
        </Field>
      )}
      {job.prompt && (
        <Field label={t('jobs.card.prompt')}>
          <p className="m-0 max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
            {visibleUnsafe(job.prompt, true)}
          </p>
        </Field>
      )}
      {job.note && (
        <Field label={t('jobs.card.note')}>
          <p className="m-0 whitespace-pre-wrap break-words">
            {visibleUnsafe(job.note, true)}
          </p>
        </Field>
      )}
      {grants.length > 0 && (
        <Field label={t('jobs.card.grants')}>
          <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
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
        </Field>
      )}
      {uses.length > 0 && (
        <Field label={t('jobs.card.delegated')}>
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
        </Field>
      )}
      {events.length > 0 && (
        <Field label={t('jobs.card.history')}>
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
        </Field>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h4 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
        {label}
      </h4>
      <div className="text-fg">{children}</div>
    </div>
  )
}
