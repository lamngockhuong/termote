import { type ReactNode, useState } from 'react'
import { agentLabel } from '../chat-agents'
import { revokeJobGrant } from '../hooks/use-jobs'
import {
  type Job,
  type JobGrant,
  type JobState,
  RequestError,
} from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { formatAgo } from '../utils/format-ago'
import { ciSetNumbers } from '../utils/job-ci'
import {
  activeGrants,
  grantLabel,
  grantLeft,
  grantUsed,
  jobPaneRef,
} from '../utils/jobs'
import { serverErrorText } from '../utils/server-error'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { JOB_STATE_WORDS, jobBranch, jobLiveWords, LIVE_TONE } from './job-card'
import { JobCISection } from './job-ci-section'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'

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
  pr: 'jobs.event.pr',
  ci: 'jobs.event.ci',
  ci_sent: 'jobs.event.ci_sent',
  ci_failed_send: 'jobs.event.ci_failed_send',
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
  // This browser may end a grant here (signed in with the password or a
  // full paired device, and the job can change)
  canEndGrants?: boolean
  // The server follows the jobs' pull requests
  ciAvailable?: boolean
}

// What a full client knows of one job, under the title its panel gives it:
// what its agent does and since when, its pane, Grants and Edit, then each
// field it has: state, agent, branch, folder, changes, prompt, note, the
// grants in force, the answers given under one, and its history.
export function JobDetail({
  job,
  now,
  onOpenPane,
  onEdit,
  onGrants,
  canEndGrants,
  ciAvailable,
}: Props) {
  const { t } = useT()
  // The grant whose end waits for a yes, and how the last end went
  const [ending, setEnding] = useState<JobGrant | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [ended, setEnded] = useState(false)
  const end = async (g: JobGrant) => {
    setEnding(null)
    setEnded(false)
    try {
      await revokeJobGrant(job, g.id)
      setProblem(null)
      setEnded(true)
    } catch (err) {
      setProblem(
        err instanceof RequestError
          ? serverErrorText(err, t)
          : t('jobs.grant.failed'),
      )
    }
  }
  const title = visibleUnsafe(job.title)
  const status = job.live.status
  const live = jobLiveWords(job, t)
  const ref = jobPaneRef(job)
  const paneId = job.live.paneId
  const branch = jobBranch(job)
  const tree = job.live.outsideWorktree ? undefined : job.worktree
  const dir = tree?.dir ?? job.live.dir
  const grants = activeGrants(job, now)
  // The answers given under a grant, and the failed checks a ci grant sent
  const uses = (job.grants ?? [])
    .flatMap((g) => (g.uses ?? []).map((u) => ({ ...u, kind: g.kind })))
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
    <div className="flex flex-col gap-4 text-[13px]">
      {(live || changed) && (
        <p className="m-0 -mt-2">
          {status && live && <span className={LIVE_TONE[status]}>{live}</span>}
          {live && changed && <span className="text-fg-muted"> · </span>}
          {changed && <span className="text-fg-muted">{changed}</span>}
        </p>
      )}
      {((ref && paneId && onOpenPane) || onGrants || onEdit) && (
        <div className="flex flex-wrap items-center gap-2">
          {ref && paneId && onOpenPane && (
            <Button
              variant="primary"
              onClick={() => onOpenPane(paneId)}
              aria-label={t('jobs.card.openPane', { ref })}
            >
              <span className="truncate">
                {t('jobs.card.openPane', { ref })}
              </span>
            </Button>
          )}
          {onGrants && (
            <Button
              onClick={() => onGrants(job)}
              aria-label={t('jobs.card.grantsFor', { title })}
            >
              {grants.length > 0
                ? t('jobs.detail.grantsCount', { count: grants.length })
                : t('jobs.card.grantsButton')}
            </Button>
          )}
          {onEdit && (
            <Button
              onClick={() => onEdit(job)}
              aria-label={t('jobs.card.editFor', { title })}
            >
              {t('jobs.card.edit')}
            </Button>
          )}
        </div>
      )}
      <dl className="m-0 grid grid-cols-[6rem_minmax(0,1fr)] gap-y-2 text-[12px]">
        <Row label={t('jobs.detail.state')}>
          {t(JOB_STATE_WORDS[job.state])}
        </Row>
        {agent && <Row label={t('jobs.detail.agent')}>{agent}</Row>}
        {branch && (
          <Row label={t('jobs.detail.branch')}>
            <span className="break-all font-term text-[11px]">
              {visibleUnsafe(branch)}
            </span>
          </Row>
        )}
        {dir && (
          <Row label={t('jobs.detail.folder')}>
            <span className="break-all font-term text-[11px]">
              {visibleUnsafe(dir)}
            </span>
          </Row>
        )}
        {job.diff && (
          <Row label={t('jobs.detail.changes')}>
            {t('jobs.card.commits', { count: job.diff.commits })}
            {' · '}
            {t('jobs.card.files', { count: job.diff.files })}
          </Row>
        )}
      </dl>
      {ciAvailable && <JobCISection job={job} now={now} />}
      {job.prompt && (
        <Section label={t('jobs.card.prompt')}>
          <p className="m-0 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-control bg-surface-raised px-3 py-2.5 leading-normal ui-terminal:bg-bg">
            {visibleUnsafe(job.prompt, true)}
          </p>
        </Section>
      )}
      {job.note && (
        <Section label={t('jobs.card.note')}>
          <p className="m-0 whitespace-pre-wrap break-words rounded-control bg-surface-raised px-3 py-2.5 leading-normal ui-terminal:bg-bg">
            {visibleUnsafe(job.note, true)}
          </p>
        </Section>
      )}
      {grants.length > 0 && (
        <Section label={t('jobs.card.grants')}>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {grants.map((g) => (
              <li
                key={g.id}
                className="flex items-center gap-2.5 rounded-control border border-border px-3 py-2.5"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="break-all font-term text-[12px]">
                    {grantLabel(g, t)}
                  </span>
                  <span className="text-[11px] text-fg-muted">
                    {grantLeft(g.expires, now, t)}
                    {' · '}
                    {grantUsed(g, t)}
                  </span>
                </span>
                {canEndGrants && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setEnding(g)}
                    aria-label={t('jobs.grant.revokeName', {
                      label: grantLabel(g, t),
                    })}
                  >
                    {t('jobs.grant.revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {problem && (
        <p role="alert" className="m-0 text-[12px] text-danger">
          {problem}
        </p>
      )}
      {ended && (
        <p role="status" className="m-0 text-[12px] text-fg-muted">
          {t('jobs.grant.revoked')}
        </p>
      )}
      <ConfirmDialog
        isOpen={!!ending}
        title={t('jobs.grant.revokeTitle')}
        confirmLabel={t('jobs.grant.revoke')}
        destructive
        onConfirm={() => void end(ending as JobGrant)}
        onCancel={() => setEnding(null)}
      >
        <p className="m-0 break-all">{ending && grantLabel(ending, t)}</p>
      </ConfirmDialog>
      {uses.length > 0 && (
        <Section label={t('jobs.card.delegated')}>
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-[12px]">
            {uses.map((u, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: answers have no id and never move
                key={i}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2"
              >
                <span className="min-w-0 break-all font-term">
                  {u.kind === 'ci'
                    ? t('jobs.ci.autoSent', {
                        prs: ciSetNumbers(u.command ?? ''),
                      })
                    : visibleUnsafe(u.command ?? u.path ?? '')}
                </span>
                <span className="shrink-0 text-fg-muted">{ago(u.at)}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}
      {events.length > 0 && (
        <Section label={t('jobs.card.history')}>
          <ol className="m-0 flex list-none flex-col gap-2 p-0 text-[12px]">
            {events.map((e, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: the history only grows at its end
                key={i}
                className="grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-baseline gap-2"
              >
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-border-strong"
                />
                <span className="min-w-0 break-words">
                  {Object.hasOwn(EVENT_WORDS, e.kind)
                    ? t(EVENT_WORDS[e.kind])
                    : visibleUnsafe(e.kind)}
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
                <span className="shrink-0 tabular-nums text-fg-muted">
                  {ago(e.at)}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}
    </div>
  )
}

// One field of the job: its name in a narrow column, then its value
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  )
}

// A longer part of the job under its own heading
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="m-0 text-[12px] font-semibold text-fg-muted">{label}</h4>
      {children}
    </section>
  )
}
