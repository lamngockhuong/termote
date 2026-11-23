import type { Job, JobGrant, JobState } from '../hooks/use-mux-api'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { visibleUnsafe } from './unsafe-chars'

// The Plan section's groups: the active jobs split by what they need from
// the user, then those to review, those not started and the finished ones.
export interface JobGroups {
  // Active, the agent waits for an answer to a dialog
  waiting: Job[]
  // Active, a turn ended that the orchestrator has not read
  unread: Job[]
  // Active, anything else
  running: Job[]
  review: Job[]
  todo: Job[]
  // done, failed, abandoned
  finished: Job[]
}

// done, failed and abandoned end a job: no grant, nothing to answer
export function jobFinished(state: JobState): boolean {
  return state === 'done' || state === 'failed' || state === 'abandoned'
}

export function groupJobs(jobs: readonly Job[]): JobGroups {
  const groups: JobGroups = {
    waiting: [],
    unread: [],
    running: [],
    review: [],
    todo: [],
    finished: [],
  }
  for (const j of jobs) {
    switch (j.state) {
      case 'active':
        if (j.live.status === 'blocked') groups.waiting.push(j)
        else if (j.live.unread) groups.unread.push(j)
        else groups.running.push(j)
        break
      case 'review':
      case 'todo':
        groups[j.state].push(j)
        break
      default:
        groups.finished.push(j)
    }
  }
  return groups
}

// The grants of job still in force at now (server time, ms)
export function activeGrants(job: Job, now: number): JobGrant[] {
  return (job.grants ?? []).filter(
    (g) => !g.revoked && Date.parse(g.expires) > now,
  )
}

// How long a grant has left at now (server time, ms): "Ends in 12 min"
export function grantLeft(
  expires: string,
  now: number,
  t: Translate<MessageKey>,
): string {
  const min = Math.max(1, Math.ceil((Date.parse(expires) - now) / 60_000))
  return min < 60
    ? t('jobs.grant.leftMinutes', { n: min })
    : t('jobs.grant.leftHours', { n: Math.floor(min / 60) })
}

// What a grant lets the orchestrator answer: "Run: pnpm test", "Edit files"
export function grantLabel(g: JobGrant, t: Translate<MessageKey>): string {
  return g.kind === 'bash'
    ? t('jobs.grant.runLabel', { prefix: visibleUnsafe(g.prefix ?? '') })
    : t('jobs.grant.editLabel')
}

// The pane a job's agent runs in, as the card names it
export function jobPaneRef(job: Job): string {
  return visibleUnsafe(
    job.live.ref ||
      job.live.paneId ||
      job.agent?.ref ||
      job.agent?.paneId ||
      '',
  )
}
