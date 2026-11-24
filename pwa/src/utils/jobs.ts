import type { Job, JobGrant, JobState } from '../hooks/use-mux-api'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { visibleUnsafe } from './unsafe-chars'

// The Plan section's groups: the unfinished jobs whose agent waits on a
// dialog, the other active ones split by what they need from the user, then
// those to review, those not started and the finished ones.
export interface JobGroups {
  // Not finished, the agent waits for an answer to a dialog (a job moved to
  // review while its agent still runs asks the user all the same)
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
    if (!jobFinished(j.state) && j.live.status === 'blocked') {
      groups.waiting.push(j)
      continue
    }
    switch (j.state) {
      case 'active':
        if (j.live.unread) groups.unread.push(j)
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

// What a grant lets the orchestrator answer: "Run: pnpm test", "Edit files",
// or the server send: "Send failed checks to the agent"
export function grantLabel(g: JobGrant, t: Translate<MessageKey>): string {
  if (g.kind === 'bash')
    return t('jobs.grant.runLabel', { prefix: visibleUnsafe(g.prefix ?? '') })
  return g.kind === 'ci' ? t('jobs.grant.ciLabel') : t('jobs.grant.editLabel')
}

// How much of a grant was used: "used 2 times", or for a ci grant "sent 1
// of 3 times"
export function grantUsed(g: JobGrant, t: Translate<MessageKey>): string {
  const used = g.uses?.length ?? 0
  return g.kind === 'ci'
    ? t('jobs.grant.rounds', { used, most: CI_ROUNDS })
    : t('jobs.grant.uses', { count: used })
}

// How many times a ci grant sends (server/job_ci_send.go's maxCIRounds)
export const CI_ROUNDS = 3

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
