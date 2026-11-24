import type {
  Job,
  JobCI,
  JobCISummary,
  JobGrant,
  JobLive,
  JobPR,
  JobPriority,
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
const MAX_AFTER = 20
const JOB_ID = /^[0-9a-f]{16}$/
const PRIORITIES = ['high', 'normal', 'low']
const JOB_FIELDS = ['priority', 'after', 'workspace']

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

// What j still waits on, as server/job_deps.go's jobWaits: the jobs of
// after not done, and of those the failed or abandoned ones
function waitsOf(state: DemoState, j: DemoJob) {
  const waitsOn: string[] = []
  const waitsOnFailed: string[] = []
  for (const id of j.after ?? []) {
    const o = state.jobs.find((x) => x.id === id)
    if (!o || o.state === 'done') continue
    waitsOn.push(id)
    if (o.state === 'failed' || o.state === 'abandoned') waitsOnFailed.push(id)
  }
  return { waitsOn, waitsOnFailed }
}

const rank = (j: DemoJob) =>
  j.priority === 'high' ? 0 : j.priority === 'low' ? 2 : 1

// The ledger's order, as server/job_deps.go's sortJobs: by priority, then
// the jobs to do oldest first, then the others newest first
function sortJobs(jobs: DemoJob[]): DemoJob[] {
  const at = (j: DemoJob) => Date.parse(j.created ?? '') || 0
  return [...jobs].sort((a, b) => {
    const d = rank(a) - rank(b)
    if (d !== 0) return d
    const at1 = a.state === 'todo'
    const bt = b.state === 'todo'
    if (at1 && bt) return at(a) - at(b)
    if (at1 !== bt) return at1 ? -1 : 1
    return at(b) - at(a)
  })
}

function view(state: DemoState, j: DemoJob): Job {
  const { unread: _, ...job } = j
  const { waitsOn, waitsOnFailed } = waitsOf(state, j)
  return {
    ...job,
    waitsOn: waitsOn.length ? waitsOn : undefined,
    waitsOnFailed: waitsOnFailed.length ? waitsOnFailed : undefined,
    ready: (j.state === 'todo' && waitsOn.length === 0) || undefined,
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
  const jobs = sortJobs(req.state.jobs)
    .filter((j) => all || !jobFinished(j.state))
    .map((j) => view(req.state, j))
  return json({
    jobs,
    readOnly: false,
    serverNow: iso(req.state),
    canGrant: true,
    ciAvailable: true,
    jobFields: JOB_FIELDS,
    // As a real server says; the demo removes nothing
    finishedKeepSeconds: 30 * 24 * 60 * 60,
    jobsMax: 200,
  })
}

// A request's priority, after and workspace checked against the jobs and
// groups as server/job_routes.go and server/job_deps.go check them, for
// the job id ('' for a new one): the refusal, or what to set
interface Order {
  priority?: JobPriority | ''
  after?: string[]
  workspace?: string
}

function checkOrder(
  req: DemoRequest,
  id: string,
): { refused: Response } | { order: Order } {
  const b = req.body ?? {}
  const order: Order = {}
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority))
      return { refused: invalid('unknown priority') }
    order.priority = b.priority === 'normal' ? '' : b.priority
  }
  if (b.after !== undefined) {
    if (!Array.isArray(b.after))
      return { refused: invalid('a job it waits on is not a job id') }
    const after: string[] = []
    for (const a of b.after as unknown[]) {
      if (typeof a !== 'string' || !JOB_ID.test(a))
        return { refused: invalid('a job it waits on is not a job id') }
      if (a === id) return { refused: invalid('a job cannot wait on itself') }
      if (!after.includes(a)) after.push(a)
    }
    if (after.length > MAX_AFTER)
      return { refused: invalid(`a job waits on up to ${MAX_AFTER} jobs`) }
    if (after.some((a) => !req.state.jobs.some((j) => j.id === a)))
      return {
        refused: fail(
          409,
          'job_after_missing',
          'a job it waits on does not exist',
        ),
      }
    // A cycle: id is reached from after through the jobs' own after
    const seen = new Set<string>()
    const stack = [...after]
    while (id && stack.length > 0) {
      const cur = stack.pop() as string
      if (cur === id)
        return {
          refused: fail(409, 'job_cycle', 'the jobs would wait on each other'),
        }
      if (seen.has(cur)) continue
      seen.add(cur)
      stack.push(...(req.state.jobs.find((j) => j.id === cur)?.after ?? []))
    }
    order.after = after
  }
  if (b.workspace !== undefined) {
    if (typeof b.workspace !== 'string')
      return { refused: invalid('the workspace is not a group id') }
    if (b.workspace && !req.state.groups.some((g) => g.id === b.workspace))
      return {
        refused: fail(
          409,
          'job_workspace_unknown',
          'no such workspace is open',
        ),
      }
    order.workspace = b.workspace
  }
  return { order }
}

// Sets order on j, with a history line for each change
function applyOrder(req: DemoRequest, j: DemoJob, order: Order) {
  if (order.priority !== undefined && order.priority !== (j.priority ?? '')) {
    j.priority = order.priority || undefined
    event(req, j, 'priority', order.priority || 'normal')
  }
  if (order.after !== undefined) {
    const now = order.after
    const was = j.after ?? []
    const diff = [
      ...now.filter((a) => !was.includes(a)).map((a) => `+${a}`),
      ...was.filter((a) => !now.includes(a)).map((a) => `-${a}`),
    ]
    j.after = now.length ? now : undefined
    if (diff.length) event(req, j, 'after', diff.join(' '))
  }
  if (
    order.workspace !== undefined &&
    order.workspace !== (j.workspace ?? '')
  ) {
    j.workspace = order.workspace || undefined
    event(req, j, 'workspace', order.workspace)
  }
}

const create: Handler = (req) => {
  const title = text(req.body?.title, 200)?.trim()
  if (!title) return invalid('the title is empty')
  if (req.state.jobs.length >= MAX_JOBS)
    return fail(409, 'too_many_jobs', 'too many jobs')
  const checked = checkOrder(req, '')
  if ('refused' in checked) return checked.refused
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
  const { order } = checked
  j.priority = order.priority || undefined
  j.after = order.after?.length ? order.after : undefined
  j.workspace = order.workspace || undefined
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
  const checked = checkOrder(req, j.id)
  if ('refused' in checked) return checked.refused
  const { order } = checked
  const ref = b.pane !== undefined ? findPane(req.state, String(b.pane)) : null
  if (b.pane !== undefined && !ref?.pane.agent)
    return fail(409, 'job_no_agent', 'the pane runs no agent')
  // A job given its first agent takes the agent's workspace; one with an
  // agent or a worktree keeps its own
  const bound = ref && !j.agent ? ref.group.id : (j.workspace ?? '')
  if (
    order.workspace !== undefined &&
    order.workspace !== bound &&
    (ref || j.agent || j.worktree)
  )
    return fail(
      409,
      'job_workspace_bound',
      'the job has an agent or a worktree: its workspace stays',
    )
  if (ref?.pane.agent && j.agent?.paneId !== ref.pane.id) {
    if (!j.agent && bound !== (j.workspace ?? '')) {
      j.workspace = bound
      event(req, j, 'workspace', bound)
    }
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
  applyOrder(req, j, order)
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

// The orchestrators' questions, as server/ask_routes.go answers a full
// client: an answer names the version it read and one choice or text. The
// demo has no orchestrator to type it to, so it is only recorded.
const listAsks: Handler = (req) =>
  json({ asks: req.state.asks, readOnly: false })

const answerAsk: Handler = (req) => {
  const q = req.state.asks.find((a) => a.id === req.params.id)
  if (!q) return fail(404, 'ask_not_found', 'no such question')
  if (q.state !== 'open')
    return fail(409, 'ask_closed', 'the question was answered already', {
      ask: q,
    })
  const { updated, choice, text } = req.body ?? {}
  if (updated !== q.updated)
    return fail(409, 'ask_conflict', 'the question was changed elsewhere', {
      ask: q,
    })
  if ((choice === undefined) === (text === undefined))
    return fail(400, 'ask_invalid', 'answer with a choice or with text')
  let answer = typeof text === 'string' ? text.trim() : ''
  if (choice !== undefined) {
    if (
      !Number.isInteger(choice) ||
      choice < 1 ||
      choice > (q.choices?.length ?? 0)
    )
      return fail(400, 'ask_invalid', 'no such choice')
    answer = q.choices?.[choice - 1] ?? ''
  }
  if (!answer) return fail(400, 'ask_invalid', 'the answer is empty')
  Object.assign(q, {
    state: 'answered',
    answer,
    choice: choice ?? undefined,
    answeredBy: 'pwa',
    updated: iso(req.state),
  })
  return json({ ask: q, queued: false, recorded: true })
}

// A dismissal: the open ask, at the version read, is only recorded.
const dismissAsk: Handler = (req) => {
  const q = req.state.asks.find((a) => a.id === req.params.id)
  if (!q) return fail(404, 'ask_not_found', 'no such question')
  if (q.state !== 'open')
    return fail(409, 'ask_closed', 'the question was answered already', {
      ask: q,
    })
  if (req.body?.updated !== q.updated)
    return fail(409, 'ask_conflict', 'the question was changed elsewhere', {
      ask: q,
    })
  Object.assign(q, {
    state: 'dismissed',
    answer: undefined,
    choice: undefined,
    answeredBy: 'pwa',
    updated: iso(req.state),
  })
  return json({ ask: q })
}

export const JOB_ROUTES: Record<string, Handler> = {
  'GET /asks': listAsks,
  'POST /asks/{id}/answer': answerAsk,
  'POST /asks/{id}/dismiss': dismissAsk,
  'GET /jobs': list,
  'POST /jobs': create,
  'PATCH /jobs/{id}': update,
  'DELETE /jobs/{id}': remove,
  'POST /jobs/{id}/grants': grant,
  'DELETE /jobs/{id}/grants/{gid}': revoke,
  'POST /jobs/{id}/ci': ci,
}
