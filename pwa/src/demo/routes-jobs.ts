import type {
  Job,
  JobCI,
  JobCISummary,
  JobGrant,
  JobLive,
  JobPR,
} from '../hooks/use-mux-api'
import { grantPrefixProblem } from '../utils/grant-prefix'
import { jobFinished } from '../utils/jobs'
import type { DemoJob } from './fixtures/jobs'
import { type DemoRequest, fail, type Handler, json } from './http'
import { type DemoState, findPane, iso, newId } from './state'

// The plan's routes (/api/mux/jobs*), as server/job_routes.go and
// server/job_grants.go answer a full client signed in with the password:
// a change or a delete names the version it read, a grant is pinned to the
// job's agent and ends with it.

const STATES = ['todo', 'active', 'review', 'done', 'failed', 'abandoned']
const MAX_JOBS = 200
const MOST_MINUTES = 1440

const conflict = (job: DemoJob) =>
  fail(409, 'job_conflict', 'the job was changed elsewhere', { job })
const invalid = (msg: string) => fail(400, 'job_invalid', msg)
const notFound = () => fail(404, 'job_not_found', 'no such job')

// What the job's agent does now, from the demo's panes
function liveOf(state: DemoState, j: DemoJob): JobLive {
  if (!j.agent) return {}
  const ref = findPane(state, j.agent.paneId)
  const status = ref?.pane.agent?.status
  if (!status)
    return { status: 'gone', paneId: j.agent.paneId, ref: j.agent.ref }
  const live: JobLive = { paneId: j.agent.paneId, ref: j.agent.ref }
  live.status = status === 'working' || status === 'blocked' ? status : 'idle'
  if (live.status === 'idle' && j.unread) live.unread = true
  return live
}

// What a card shows of the pull requests, as server/job_pr.go's ciSummary
function ciSummary(ci?: JobCI): JobCISummary | undefined {
  const prs = ci?.prs ?? []
  if (prs.length === 0) return undefined
  const rank = (p: JobPR): [number, JobCISummary['worst']] => {
    if (p.state !== 'open') return [0, 'merged']
    if (p.checks === 'fail') return [4, 'fail']
    if (p.checks === 'pending') return [3, 'pending']
    if (p.draft) return [1, 'draft']
    return [2, 'open']
  }
  let best = -1
  let worst: JobCISummary['worst']
  for (const p of prs) {
    const [r, w] = rank(p)
    if (r > best) [best, worst] = [r, w]
  }
  return {
    worst,
    count: prs.length,
    allMerged: prs.every((p) => p.state !== 'open') || undefined,
    numbers: prs.map((p) => p.number),
  }
}

// The failing set's key, as server/job_pr.go's ciFailKey
function ciFailKey(prs: JobPR[]): string {
  const parts = prs
    .filter((p) => p.state === 'open' && p.checks === 'fail')
    .map((p) => `${p.number}@${p.head ?? ''}`)
    .sort()
  return parts.length ? `fail:${parts.join(',')}` : ''
}

function view(state: DemoState, j: DemoJob): Job {
  const { unread: _, ...job } = j
  return {
    ...job,
    live: liveOf(state, j),
    ciSummary: ciSummary(j.ci),
    ciChecked: j.ci ? iso(state, -40_000) : undefined,
  }
}

const find = (req: DemoRequest) =>
  req.state.jobs.find((j) => j.id === req.params.id)

function event(req: DemoRequest, j: DemoJob, kind: string, text?: string) {
  j.events = [...(j.events ?? []), { at: iso(req.state), kind, text }].slice(
    -50,
  )
}

const revokeAll = (req: DemoRequest, j: DemoJob) => {
  for (const g of j.grants ?? []) g.revoked ??= iso(req.state)
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  return v.length > max ? null : v
}

const list: Handler = (req) => {
  const all = req.query.get('all') === '1'
  const jobs = req.state.jobs
    .filter((j) => all || !jobFinished(j.state))
    .map((j) => view(req.state, j))
  return json({
    jobs,
    readOnly: false,
    serverNow: iso(req.state),
    canGrant: true,
    ciAvailable: true,
  })
}

const create: Handler = (req) => {
  const title = text(req.body?.title, 200)?.trim()
  if (!title) return invalid('the title is empty')
  if (req.state.jobs.length >= MAX_JOBS)
    return fail(409, 'too_many_jobs', 'too many jobs')
  const at = iso(req.state)
  const j: DemoJob = {
    id: newId(req.state),
    title,
    prompt: text(req.body?.prompt, 16384) ?? undefined,
    note: text(req.body?.note, 4096) ?? undefined,
    state: 'todo',
    createdBy: 'pwa',
    created: at,
    updated: at,
  }
  event(req, j, 'created')
  req.state.jobs.push(j)
  return json({ job: view(req.state, j) }, 201)
}

const update: Handler = (req) => {
  const j = find(req)
  if (!j) return notFound()
  if (req.body?.updated !== j.updated) return conflict(j)
  const b = req.body
  if (b.state !== undefined && !STATES.includes(b.state))
    return invalid('unknown state')
  if (b.title !== undefined && !text(b.title, 200)?.trim())
    return invalid('the title is empty')
  if (b.pane !== undefined) {
    const ref = findPane(req.state, String(b.pane))
    if (!ref?.pane.agent)
      return fail(409, 'job_no_agent', 'the pane runs no agent')
    if (j.agent?.paneId !== ref.pane.id) {
      revokeAll(req, j)
      j.agent = {
        key: ref.pane.id,
        paneId: ref.pane.id,
        kind: ref.pane.agent.name,
        groupId: ref.group.id,
        ref: `${ref.group.name}:${ref.tab.name}`,
      }
      j.unread = false
      event(req, j, 'agent', j.agent.ref)
    }
  }
  const add: unknown[] = Array.isArray(b.addPrs) ? b.addPrs : []
  const drop: unknown[] = Array.isArray(b.removePrs) ? b.removePrs : []
  if (
    [...add, ...drop].some(
      (n) => !Number.isInteger(n) || (n as number) < 1 || (n as number) > 1e9,
    )
  )
    return invalid('a pull request number is 1 or more')
  if (add.length || drop.length) {
    j.ci ??= {}
    const ci = j.ci
    let pins = (ci.pins ?? []).filter((n) => !drop.includes(n))
    for (const n of add as number[]) if (!pins.includes(n)) pins = [...pins, n]
    if (pins.length > 10)
      return invalid('up to 10 pull requests can be attached')
    ci.pins = pins
    ci.prs = (ci.prs ?? []).filter((p) => !p.pinned || pins.includes(p.number))
    if (add.length)
      event(req, j, 'pr', `pinned ${add.map((n) => `#${n}`).join(', ')}`)
    if (drop.length)
      event(req, j, 'pr', `unpinned ${drop.map((n) => `#${n}`).join(', ')}`)
  }
  if (b.title !== undefined) j.title = b.title.trim()
  if (typeof b.prompt === 'string') j.prompt = b.prompt
  if (typeof b.note === 'string') {
    j.note = b.note
    event(req, j, 'note')
  }
  if (b.state !== undefined) {
    j.state = b.state
    event(req, j, 'state', b.state)
  }
  if (jobFinished(j.state)) revokeAll(req, j)
  j.updated = iso(req.state, 1)
  return json({ job: view(req.state, j) })
}

const remove: Handler = (req) => {
  const j = find(req)
  if (!j) return notFound()
  if (req.query.get('updated') !== j.updated) return conflict(j)
  req.state.jobs.splice(req.state.jobs.indexOf(j), 1)
  return json({ ok: true })
}

const grant: Handler = (req) => {
  const j = find(req)
  if (!j) return notFound()
  const kind = req.body?.kind
  if (kind !== 'bash' && kind !== 'edit' && kind !== 'ci')
    return invalid(
      'a grant is to run a command (bash), edit files (edit) or send failed checks (ci)',
    )
  const prefix = typeof req.body?.prefix === 'string' ? req.body.prefix : ''
  const problem = kind === 'bash' ? grantPrefixProblem(prefix) : null
  if (problem || (kind !== 'bash' && prefix))
    return fail(400, 'grant_invalid', 'the command prefix is refused')
  const minutes = req.body?.minutes ?? MOST_MINUTES
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MOST_MINUTES)
    return invalid('a grant lasts 1 minute to 24 hours')
  const live = liveOf(req.state, j)
  if (!j.agent || jobFinished(j.state) || live.status === 'gone')
    return invalid("the job's agent does not run: a grant needs it")
  if (kind === 'edit' && !j.worktree)
    return invalid("a grant to edit files needs the job's worktree")
  const g: JobGrant = {
    id: newId(req.state),
    job: j.id,
    agent: j.agent,
    kind,
    prefix: kind === 'bash' ? prefix.trim() : undefined,
    dir: kind === 'edit' ? j.worktree?.dir : undefined,
    created: iso(req.state),
    expires: iso(req.state, minutes * 60_000),
  }
  if (kind === 'ci')
    for (const old of j.grants ?? [])
      if (old.kind === 'ci') old.revoked ??= iso(req.state)
  j.grants = [...(j.grants ?? []), g]
  event(
    req,
    j,
    'grant',
    kind === 'bash'
      ? `run ${g.prefix}`
      : kind === 'ci'
        ? 'send failed checks to the agent (up to 3 times)'
        : 'edit files',
  )
  return json({ job: view(req.state, j), grant: g.id }, 201)
}

const revoke: Handler = (req) => {
  const j = find(req)
  if (!j) return notFound()
  const g = j.grants?.find((x) => x.id === req.params.gid)
  if (!g) return fail(404, 'grant_not_found', 'no such grant')
  if (!g.revoked) {
    g.revoked = iso(req.state)
    event(req, j, 'revoked')
  }
  return json({ job: view(req.state, j) })
}

// The job's pull requests read again, or its failed checks sent to its
// agent, as server/job_ci_send.go's handleJobCI
const ci: Handler = (req) => {
  const j = find(req)
  if (!j) return notFound()
  const action = req.body?.action
  if (action === 'refresh') return json({ job: view(req.state, j) })
  if (action !== 'send') return invalid('action is refresh or send')
  const key = ciFailKey(j.ci?.prs ?? [])
  if (!j.ci || !key)
    return fail(
      409,
      'ci_nothing_failed',
      "no check of the job's pull requests failed",
    )
  if (!j.agent || liveOf(req.state, j).status === 'gone')
    return fail(409, 'job_no_agent', "the job's agent does not run")
  j.ci.sent = key
  const prs = key
    .slice(5)
    .split(',')
    .map((p) => `#${p.split('@')[0]}`)
    .join(', ')
  event(req, j, 'ci_sent', `sent CI failure of ${prs}`)
  return json({ job: view(req.state, j), queued: false })
}

export const JOB_ROUTES: Record<string, Handler> = {
  'GET /jobs': list,
  'POST /jobs': create,
  'PATCH /jobs/{id}': update,
  'DELETE /jobs/{id}': remove,
  'POST /jobs/{id}/grants': grant,
  'DELETE /jobs/{id}/grants/{gid}': revoke,
  'POST /jobs/{id}/ci': ci,
}
