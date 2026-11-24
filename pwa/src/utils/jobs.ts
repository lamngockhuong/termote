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

// The rank of a job's priority: high first, low last
function priorityRank(job: Job): number {
  return job.priority === 'high' ? 0 : job.priority === 'low' ? 2 : 1
}

// jobs by priority, keeping their order otherwise (the server's)
export function sortByPriority(jobs: readonly Job[]): Job[] {
  return [...jobs].sort((a, b) => priorityRank(a) - priorityRank(b))
}

// The jobs job still waits on (not done yet), as the server worked them out
export function jobWaits(job: Job): number {
  return job.waitsOn?.length ?? 0
}

// The jobs to do: those that wait on nothing first (what to start next),
// then the waiting ones, each by priority
export function sortTodo(jobs: readonly Job[]): Job[] {
  const sorted = sortByPriority(jobs)
  return [
    ...sorted.filter((j) => jobWaits(j) === 0),
    ...sorted.filter((j) => jobWaits(j) > 0),
  ]
}

// The workspace (group id) job belongs to, '' for none: the one the server
// found it in now, else the one it was set to
export function jobWorkspace(job: Job): string {
  return job.workspaceNow || job.workspace || ''
}

// What a workspace is called: its group's name, else its id as the server
// keeps it (a group closed since, or not in the snapshot yet)
export function workspaceName(
  id: string,
  groups: readonly { id: string; name: string }[] = [],
): string {
  return visibleUnsafe(groups.find((g) => g.id === id)?.name || id)
}

// jobs split by workspace, in the order of order (the groups' ids), then
// the workspaces order does not name as they come, then the jobs with none
// ('' as their workspace); each keeps the jobs' order
export function jobsByWorkspace(
  jobs: readonly Job[],
  order: readonly string[] = [],
): { workspace: string; jobs: Job[] }[] {
  const by = new Map<string, Job[]>()
  for (const j of jobs) {
    const ws = jobWorkspace(j)
    const list = by.get(ws)
    if (list) list.push(j)
    else by.set(ws, [j])
  }
  const ids = [
    ...order.filter((id) => id && by.has(id)),
    ...[...by.keys()].filter((id) => id && !order.includes(id)),
  ]
  if (by.has('')) ids.push('')
  return ids.map((workspace) => ({
    workspace,
    jobs: by.get(workspace) as Job[],
  }))
}

// The jobs whose after names job: those that wait on it, however done
export function jobsNeeding(job: Job, jobs: readonly Job[]): Job[] {
  return jobs.filter((j) => j.after?.includes(job.id))
}

// The ids of the jobs that wait on id, however far round: picking one of
// them for id to wait on would make a cycle
export function jobDependents(id: string, jobs: readonly Job[]): Set<string> {
  const found = new Set<string>()
  const stack = [id]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    for (const j of jobs)
      if (!found.has(j.id) && j.after?.includes(cur)) {
        found.add(j.id)
        stack.push(j.id)
      }
  }
  found.delete(id)
  return found
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
  // Each open column by priority; the finished ones keep their order
  groups.waiting = sortByPriority(groups.waiting)
  groups.unread = sortByPriority(groups.unread)
  groups.running = sortByPriority(groups.running)
  groups.review = sortByPriority(groups.review)
  groups.todo = sortTodo(groups.todo)
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

// PR_PATH: /<owner>/<repo>/pull/<n>, the only path of a pull request link
const PR_PATH = /^\/[^/]+\/[^/]+\/pull\/([1-9][0-9]*)$/

// url when it is an https link to pull request n of repo (host/owner/name),
// else undefined. The server keeps such links only, but through Machines the
// ledger is the machine's JSON, which a hostile machine writes as it likes:
// a link to another host would pass for that repo's pull request.
export function safePRUrl(
  url: string | undefined,
  n: number,
  repo: string,
): string | undefined {
  if (!url) return undefined
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
    return undefined
  const m = PR_PATH.exec(u.pathname)
  if (!m || Number(m[1]) !== n) return undefined
  return `${u.host}${u.pathname}`.toLowerCase() ===
    `${repo}/pull/${n}`.toLowerCase()
    ? url
    : undefined
}

const DAY_MS = 86_400_000
// A finished job this close to its keep time is marked on its row
export const EXPIRY_WARN_MS = 3 * DAY_MS

// When a finished job may go: the server drops one not changed for
// finishedKeepMs at the next write to the ledger (a change to the job keeps
// it), so this tells how far that is, never a date. soon: within
// EXPIRY_WARN_MS, in whole days rounded up; due: past it, gone at the next
// write. null when the job is unfinished, its time unreadable, the time far
// off or the server keeps no limit.
export type JobExpiry = { kind: 'soon'; days: number } | { kind: 'due' }

export function jobExpiry(
  job: Job,
  finishedKeepMs: number | null,
  now: number,
): JobExpiry | null {
  if (finishedKeepMs === null || !jobFinished(job.state)) return null
  const at = Date.parse(job.updated)
  if (Number.isNaN(at)) return null
  const left = at + finishedKeepMs - now
  if (left <= 0) return { kind: 'due' }
  if (left > EXPIRY_WARN_MS) return null
  return { kind: 'soon', days: Math.ceil(left / DAY_MS) }
}
