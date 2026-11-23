import { useSyncExternalStore } from 'react'
import { followOverview } from './use-agent-overview'
import {
  createGrant,
  createJob,
  deleteJob,
  fetchJobs,
  type GrantKind,
  type Job,
  type JobState,
  jobCI,
  RequestError,
  revokeGrant,
  updateJob,
} from './use-mux-api'

// The job ledger (/api/mux/jobs?all=1), read right after each read of the
// agent overview (use-agent-overview.ts): the same timer, stopped with it
// while the page is hidden. One copy, shared by every reader.

export interface JobsState {
  jobs: Job[]
  // Nothing can be changed here: a newer Termote saved the ledger, or this
  // device is view-only
  readOnly: boolean
  // This browser may give and end grants (signed in with the password or a
  // full paired device)
  canGrant: boolean
  // The server follows the jobs' pull requests (never in a container)
  ciAvailable: boolean
  // Server time minus this device's (ms), from the last read
  clockOffset: number
  loaded: boolean
  // The last read failed; the jobs are the last ones read
  error: boolean
  // The server keeps no ledger (an older Termote, or none could be made):
  // the Plan section is not shown
  unavailable: boolean
}

const INITIAL: JobsState = {
  jobs: [],
  readOnly: false,
  canGrant: false,
  ciAvailable: false,
  clockOffset: 0,
  loaded: false,
  error: false,
  unavailable: false,
}

let state = INITIAL
const listeners = new Set<() => void>()
// Only the latest read lands: one begun before a write would undo it
let readSeq = 0
let stopFollowing: (() => void) | undefined

function set(next: Partial<JobsState>) {
  state = { ...state, ...next }
  for (const fn of listeners) fn()
}

// Reads the jobs again. Never rejects.
export async function reloadJobs(): Promise<void> {
  const id = ++readSeq
  try {
    const list = await fetchJobs()
    if (id !== readSeq) return
    const server = Date.parse(list.serverNow)
    set({
      jobs: list.jobs,
      readOnly: list.readOnly,
      canGrant: list.canGrant,
      ciAvailable: list.ciAvailable,
      clockOffset: Number.isNaN(server) ? 0 : server - Date.now(),
      loaded: true,
      error: false,
      unavailable: false,
    })
  } catch (err) {
    if (id !== readSeq) return
    const unavailable =
      err instanceof RequestError &&
      (err.status === 404 || err.code === 'jobs_unavailable')
    set({ error: true, unavailable })
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  if (listeners.size === 1) stopFollowing = followOverview(reloadJobs)
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0) {
      stopFollowing?.()
      stopFollowing = undefined
    }
  }
}

const get = () => state

// The ledger, read while the agent overview polls (call useAgentOverview
// too, before this).
export function useJobs(): JobsState {
  return useSyncExternalStore(subscribe, get)
}

// Puts the job a write answered with in place of the one held, so the
// screen shows it before the next read.
function put(job: Job) {
  readSeq++
  const at = state.jobs.findIndex((j) => j.id === job.id)
  set({
    jobs:
      at === -1
        ? [...state.jobs, job]
        : state.jobs.map((j, i) => (i === at ? job : j)),
  })
}

// A write's refusal for its caller to explain; a job changed or removed
// elsewhere is read again first, so what the user looks at next is current.
async function write<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (
      err instanceof RequestError &&
      (err.code === 'job_conflict' ||
        err.code === 'job_not_found' ||
        err.code === 'grant_not_found')
    )
      await reloadJobs()
    throw err
  }
}

const saved = async (job: Promise<Job>) => {
  const j = await job
  put(j)
  return j
}

// Adds a todo job. Throws RequestError.
export function addJob(j: {
  title: string
  prompt?: string
  note?: string
}): Promise<Job> {
  return write(() => saved(createJob(j)))
}

// Changes job as it was read. Throws RequestError (job_conflict after
// reading the jobs again).
export function changeJob(
  job: Job,
  change: {
    title?: string
    prompt?: string
    note?: string
    state?: JobState
    pane?: string
  },
): Promise<Job> {
  return write(() =>
    saved(updateJob(job.id, { ...change, updated: job.updated })),
  )
}

// Removes job as it was read. Throws RequestError.
export function removeJob(job: Job): Promise<void> {
  return write(async () => {
    await deleteJob(job.id, job.updated)
    readSeq++
    set({ jobs: state.jobs.filter((j) => j.id !== job.id) })
  })
}

// Attaches and detaches pull requests of job by number. Throws
// RequestError (job_invalid).
export function pinJobPRs(
  job: Job,
  addPrs: number[],
  removePrs: number[],
): Promise<Job> {
  return write(() =>
    saved(updateJob(job.id, { addPrs, removePrs, updated: job.updated })),
  )
}

// Reads job's pull requests again (refresh) or sends their failed checks
// to its agent (send); queued: the agent was working. Throws RequestError.
export function runJobCI(
  job: Job,
  action: 'refresh' | 'send',
): Promise<{ job: Job; queued: boolean }> {
  return write(async () => {
    const r = await jobCI(job.id, action)
    put(r.job)
    return r
  })
}

// Gives job's agent a grant. Throws RequestError.
export function grantJob(
  job: Job,
  g: { kind: GrantKind; prefix?: string; minutes?: number },
): Promise<Job> {
  return write(() => saved(createGrant(job.id, g)))
}

// Ends a grant of job. Throws RequestError.
export function revokeJobGrant(job: Job, grantId: string): Promise<Job> {
  return write(() => saved(revokeGrant(job.id, grantId)))
}

// The job held now by id, or the one given when it is gone: a sheet opened
// on a job shows it as the last read has it.
export function useCurrentJob(job: Job): Job {
  const { jobs } = useJobs()
  return jobs.find((j) => j.id === job.id) ?? job
}

// Forgets what was read (tests).
export function resetJobs() {
  stopFollowing?.()
  stopFollowing = undefined
  listeners.clear()
  state = INITIAL
  readSeq = 0
}
