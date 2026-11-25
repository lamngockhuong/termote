import { beforeEach, describe, expect, it } from 'vitest'
import type { Job } from '../hooks/use-mux-api'
import { route } from './router'
import { createState, type DemoState } from './state'

const URL_BASE = 'http://127.0.0.1/api/mux'

// The fixture's jobs (fixtures/jobs.ts)
const DARK = 'a0b1c2d3e4f50617'
const RATE = 'c2d3e4f506172839'
const DOCS = 'd3e4f5061728394a'
const NOTES = 'e4f5061728394a5b'
const BLOG = 'f5061728394a5b6c'
const SEARCH = '061728394a5b6c7d'
// Done 28 days ago, close to the server's keep time
const OLD = '728394a5b6c7d8e9'

describe('demo plan routes: priority, dependencies and workspace', () => {
  let state: DemoState
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await route(
      state,
      method,
      new URL(URL_BASE + path),
      body === undefined ? undefined : JSON.stringify(body),
    )
    return { status: res.status, body: await res.json() }
  }
  const jobs = async (): Promise<Job[]> =>
    (await call('GET', '/jobs?all=1')).body.jobs
  const get = async (id: string) =>
    (await jobs()).find((j) => j.id === id) as Job
  const patch = async (id: string, change: Record<string, unknown>) =>
    call('PATCH', `/jobs/${id}`, {
      ...change,
      updated: (await get(id)).updated,
    })

  beforeEach(() => {
    const now = Date.parse('2026-11-24T08:00:00Z')
    state = createState(() => now)
  })

  it('lists the jobs by priority with what each waits on', async () => {
    const res = await call('GET', '/jobs?all=1')
    expect(res.body.jobFields).toEqual(['priority', 'after', 'workspace'])
    expect(res.body.jobs.map((j: Job) => j.id)).toEqual([
      RATE,
      NOTES,
      SEARCH,
      DARK,
      DOCS,
      OLD,
      BLOG,
    ])
    const notes = await get(NOTES)
    expect(notes.waitsOn).toEqual([DOCS])
    expect(notes.ready).toBeUndefined()
    expect((await get(SEARCH)).ready).toBe(true)
    // A dependency done no longer holds the job; a failed one flags it
    await patch(DOCS, { state: 'done' })
    expect((await get(NOTES)).ready).toBe(true)
    await patch(NOTES, { state: 'failed' })
    expect(await get(BLOG)).toMatchObject({
      waitsOn: [NOTES],
      waitsOnFailed: [NOTES],
    })
    // Only unfinished jobs without all=1
    const open = (await call('GET', '/jobs')).body.jobs as Job[]
    expect(open.some((j) => j.id === DOCS)).toBe(false)
  })

  it('adds a job with its priority, dependencies and workspace', async () => {
    const res = await call('POST', '/jobs', {
      title: 'New',
      priority: 'high',
      after: [SEARCH, SEARCH],
      workspace: 'w2',
    })
    expect(res.status).toBe(201)
    expect(res.body.job).toMatchObject({
      priority: 'high',
      after: [SEARCH],
      waitsOn: [SEARCH],
      workspace: 'w2',
    })
    const plain = await call('POST', '/jobs', {
      title: 'Plain',
      priority: 'normal',
      after: [],
      workspace: '',
    })
    expect(plain.body.job.priority).toBeUndefined()
    expect(plain.body.job.after).toBeUndefined()
    expect(plain.body.job.workspace).toBeUndefined()
  })

  it.each([
    [{ priority: 'urgent' }, 400, 'job_invalid'],
    [{ after: 'x' }, 400, 'job_invalid'],
    [{ after: ['nope'] }, 400, 'job_invalid'],
    [{ after: ['ffffffffffffffff'] }, 409, 'job_after_missing'],
    [
      {
        after: Array.from({ length: 21 }, (_, i) =>
          i.toString(16).padStart(16, '0'),
        ),
      },
      400,
      'job_invalid',
    ],
    [{ workspace: 3 }, 400, 'job_invalid'],
    [{ workspace: 'w9' }, 409, 'job_workspace_unknown'],
  ])('refuses a new job with %j', async (order, status, code) => {
    const res = await call('POST', '/jobs', { title: 'T', ...order })
    expect(res.status).toBe(status)
    expect(res.body.code).toBe(code)
  })

  it('changes them, with a history line each, refusing a cycle and itself', async () => {
    expect((await patch(BLOG, { priority: 'high' })).body.job.priority).toBe(
      'high',
    )
    let job = (await patch(BLOG, { priority: 'normal', after: [SEARCH] })).body
      .job as Job
    expect(job.priority).toBeUndefined()
    expect(job.after).toEqual([SEARCH])
    job = (await patch(BLOG, { workspace: 'w1' })).body.job
    expect(job.workspace).toBe('w1')
    job = (await patch(BLOG, { workspace: '', after: [] })).body.job
    expect(job.workspace).toBeUndefined()
    expect(job.after).toBeUndefined()
    expect(job.events?.slice(-6).map((e) => [e.kind, e.text])).toEqual([
      ['priority', 'high'],
      ['priority', 'normal'],
      ['after', `+${SEARCH} -${NOTES}`],
      ['workspace', 'w1'],
      ['after', `-${SEARCH}`],
      ['workspace', ''],
    ])
    // The same again changes nothing
    const n = (await get(BLOG)).events?.length
    await patch(BLOG, { priority: 'normal', after: [], workspace: '' })
    expect((await get(BLOG)).events?.length).toBe(n)
    // Docs waiting on the blog post would close the circle: the blog post
    // waits on the notes, which wait on the docs
    await patch(BLOG, { after: [NOTES] })
    expect((await patch(DOCS, { after: [BLOG] })).body.code).toBe('job_cycle')
    expect((await patch(NOTES, { after: [NOTES] })).body.code).toBe(
      'job_invalid',
    )
  })

  it('keeps the workspace of a started job, and gives a new agent its own', async () => {
    // An agent, or a worktree
    expect((await patch(RATE, { workspace: 'w2' })).body.code).toBe(
      'job_workspace_bound',
    )
    expect((await patch(DOCS, { workspace: 'w2' })).body.code).toBe(
      'job_workspace_bound',
    )
    // The same workspace is no change
    expect((await patch(RATE, { workspace: 'w1' })).status).toBe(200)
    // A job given its first agent takes the agent's workspace
    const job = (await patch(SEARCH, { pane: 'w1:p1' })).body.job as Job
    expect(job.workspace).toBe('w1')
    expect(job.events?.map((e) => e.kind)).toContain('workspace')
    // Another workspace with the pane is refused
    expect(
      (await patch(BLOG, { pane: 'w1:p1', workspace: 'w2' })).body.code,
    ).toBe('job_workspace_bound')
    expect((await patch(BLOG, { pane: 'nope' })).body.code).toBe('job_no_agent')
  })
})

describe('demo plan routes: a cleanup waiting on .env files', () => {
  let state: DemoState
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await route(
      state,
      method,
      new URL(URL_BASE + path),
      body === undefined ? undefined : JSON.stringify(body),
    )
    return { status: res.status, body: await res.json() }
  }
  const waiting = () => {
    const j = state.jobs.find((x) => x.id === DARK)!
    j.envConfirm = { files: ['.env.local', 'app/.env'], at: 'x' }
    return j
  }

  beforeEach(() => {
    state = createState(() => Date.parse('2026-11-24T08:00:00Z'))
  })

  it('runs the cleanup on the names that wait, else says why', async () => {
    const path = `/jobs/${DARK}/finish/env`
    let res = await call('POST', path, { updated: 'x', files: ['.env'] })
    expect(res.body.code).toBe('finish_env_none')
    const j = waiting()
    res = await call('POST', path, {
      updated: j.updated,
      files: ['.env.local'],
    })
    expect(res.body.code).toBe('finish_env_changed')
    res = await call('POST', path, { updated: j.updated, files: 'x' })
    expect(res.body.code).toBe('finish_env_changed')
    res = await call('POST', path, {
      updated: 'old',
      files: ['app/.env', '.env.local'],
    })
    expect(res.body.code).toBe('job_conflict')
    res = await call('POST', path, {
      updated: j.updated,
      files: ['app/.env', '.env.local'],
    })
    expect(res.status).toBe(200)
    expect(res.body.worktreeRemoved).toBe(true)
    expect(res.body.job.state).toBe('done')
    expect(res.body.job.envConfirm).toBeUndefined()
    expect(res.body.job.worktree).toBeUndefined()
    res = await call('POST', '/jobs/0000000000000000/finish/env', {})
    expect(res.status).toBe(404)
  })

  it('drops the ask', async () => {
    waiting()
    const res = await call('DELETE', `/jobs/${DARK}/finish/env`)
    expect(res.status).toBe(200)
    expect(res.body.job.envConfirm).toBeUndefined()
    expect(
      (await call('DELETE', '/jobs/0000000000000000/finish/env')).status,
    ).toBe(404)
  })
})
