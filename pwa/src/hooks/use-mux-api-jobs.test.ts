import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  answerAsk,
  createGrant,
  createJob,
  deleteJob,
  dismissAsk,
  fetchAsks,
  fetchJobs,
  jobCI,
  RequestError,
  revokeGrant,
  updateJob,
} from './use-mux-api'

interface Sent {
  url: string
  method: string
  body?: unknown
}

function mockFetch(body: unknown, status = 200) {
  const sent: Sent[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(JSON.stringify(body), { status })
    }),
  )
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const JOB = {
  id: 'a1',
  title: 'T',
  state: 'todo',
  updated: 'u1',
  live: {},
}

describe('job requests', () => {
  it('lists every job, finished ones too', async () => {
    const sent = mockFetch({
      jobs: [JOB],
      readOnly: true,
      serverNow: 'now',
      canGrant: true,
      ciAvailable: true,
      jobFields: ['priority', 'after', 'workspace'],
      finishedKeepSeconds: 2592000,
      jobsMax: 200,
    })
    expect(await fetchJobs()).toEqual({
      jobs: [JOB],
      readOnly: true,
      serverNow: 'now',
      canGrant: true,
      ciAvailable: true,
      jobFields: ['priority', 'after', 'workspace'],
      finishedKeepMs: 2592000000,
      jobsMax: 200,
    })
    expect(sent[0]).toEqual({ url: '/api/mux/jobs?all=1', method: 'GET' })
  })

  it('reads a list with missing fields as empty', async () => {
    mockFetch({ jobs: null })
    expect(await fetchJobs()).toEqual({
      jobs: [],
      readOnly: false,
      serverNow: '',
      canGrant: false,
      ciAvailable: false,
      finishedKeepMs: null,
      jobsMax: null,
      jobFields: [],
    })
  })

  it('keeps the job fields it knows, and the new ones of each job', async () => {
    const planned = {
      ...JOB,
      priority: 'high',
      after: ['b1'],
      waitsOn: ['b1'],
      waitsOnFailed: ['b1'],
      ready: false,
      workspace: 'w1',
    }
    mockFetch({
      jobs: [planned],
      jobFields: ['after', 'later', 3, 'workspace'],
    })
    const list = await fetchJobs()
    expect(list.jobFields).toEqual(['after', 'workspace'])
    expect(list.jobs[0]).toEqual(planned)
  })

  it('sends the priority, the jobs waited on and the workspace', async () => {
    let sent = mockFetch({ job: JOB }, 201)
    await createJob({
      title: 'T',
      priority: 'high',
      after: ['b1'],
      workspace: 'w1',
    })
    expect(sent[0].body).toEqual({
      title: 'T',
      priority: 'high',
      after: ['b1'],
      workspace: 'w1',
    })
    sent = mockFetch({ job: JOB })
    await updateJob('a1', {
      priority: 'normal',
      after: [],
      workspace: '',
      updated: 'u1',
    })
    expect(sent[0]).toEqual({
      url: '/api/mux/jobs/a1',
      method: 'PATCH',
      body: { priority: 'normal', after: [], workspace: '', updated: 'u1' },
    })
  })

  it('takes a keep time and a job limit only as counts above zero', async () => {
    for (const bad of ['30', 0, -1, Number.NaN, null, true]) {
      mockFetch({ jobs: [], finishedKeepSeconds: bad, jobsMax: bad })
      expect(await fetchJobs()).toMatchObject({
        finishedKeepMs: null,
        jobsMax: null,
      })
    }
    mockFetch({ jobs: [], finishedKeepSeconds: 0.5, jobsMax: 3 })
    expect(await fetchJobs()).toMatchObject({ finishedKeepMs: 500, jobsMax: 3 })
  })

  it('throws the refusal of a read', async () => {
    mockFetch({ code: 'jobs_unavailable', error: 'x' }, 503)
    await expect(fetchJobs()).rejects.toMatchObject({
      status: 503,
      code: 'jobs_unavailable',
    })
  })

  it('adds, changes and removes a job, naming the version read', async () => {
    let sent = mockFetch({ job: JOB }, 201)
    expect(await createJob({ title: 'T' })).toEqual(JOB)
    expect(sent[0]).toEqual({
      url: '/api/mux/jobs',
      method: 'POST',
      body: { title: 'T' },
    })
    sent = mockFetch({ job: JOB })
    expect(await updateJob('a/1', { state: 'review', updated: 'u1' })).toEqual(
      JOB,
    )
    expect(sent[0]).toEqual({
      url: '/api/mux/jobs/a%2F1',
      method: 'PATCH',
      body: { state: 'review', updated: 'u1' },
    })
    sent = mockFetch({ ok: true })
    await deleteJob('a1', 'u 1')
    expect(sent[0]).toEqual({
      url: '/api/mux/jobs/a1?updated=u+1',
      method: 'DELETE',
    })
  })

  it('carries the job as it is now with a conflict', async () => {
    mockFetch({ code: 'job_conflict', error: 'x', job: JOB }, 409)
    const err = await updateJob('a1', { updated: 'old' }).catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.job).toEqual(JOB)
    // Anything but an object is no job
    mockFetch({ code: 'job_conflict', error: 'x', job: 'x' }, 409)
    const bare = await updateJob('a1', { updated: 'old' }).catch((e) => e)
    expect(bare.job).toBeUndefined()
  })

  it('gives and ends a grant', async () => {
    let sent = mockFetch({ job: JOB, grant: 'g1' }, 201)
    expect(
      await createGrant('a1', {
        kind: 'bash',
        prefix: 'pnpm test',
        minutes: 30,
      }),
    ).toEqual(JOB)
    expect(sent[0]).toEqual({
      url: '/api/mux/jobs/a1/grants',
      method: 'POST',
      body: { kind: 'bash', prefix: 'pnpm test', minutes: 30 },
    })
    sent = mockFetch({ job: JOB })
    expect(await revokeGrant('a1', 'g/1')).toEqual(JOB)
    expect(sent[0]).toEqual({
      url: '/api/mux/jobs/a1/grants/g%2F1',
      method: 'DELETE',
    })
  })

  it('attaches pull requests, reads them again and sends their failures', async () => {
    let sent = mockFetch({ job: JOB })
    await updateJob('a', { addPrs: [12], removePrs: [3], updated: 'u1' })
    expect(sent[0]).toEqual({
      url: '/api/mux/jobs/a',
      method: 'PATCH',
      body: { addPrs: [12], removePrs: [3], updated: 'u1' },
    })
    sent = mockFetch({ job: JOB, queued: true })
    expect(await jobCI('a', 'send')).toEqual({ job: JOB, queued: true })
    expect(sent[0]).toEqual({
      url: '/api/mux/jobs/a/ci',
      method: 'POST',
      body: { action: 'send' },
    })
    mockFetch({ job: JOB })
    expect(await jobCI('a', 'refresh')).toEqual({ job: JOB, queued: false })
    mockFetch({ code: 'ci_nothing_failed', error: 'x' }, 409)
    await expect(jobCI('a', 'send')).rejects.toMatchObject({
      code: 'ci_nothing_failed',
    })
  })
})

const ASK = {
  id: 'Q1',
  state: 'open',
  text: 'Which way?',
  created: 'c',
  updated: 'u1',
}

describe('ask requests', () => {
  it('lists every ask, a missing list as none', async () => {
    const sent = mockFetch({ asks: [ASK], readOnly: true })
    expect(await fetchAsks()).toEqual({ asks: [ASK], readOnly: true })
    expect(sent[0]).toEqual({ url: '/api/mux/asks', method: 'GET' })
    mockFetch({ asks: null })
    expect(await fetchAsks()).toEqual({ asks: [], readOnly: false })
  })

  it('throws the refusal of a read', async () => {
    mockFetch({}, 404)
    await expect(fetchAsks()).rejects.toMatchObject({ status: 404, code: '' })
  })

  it('answers an ask with a choice or text, naming the version read', async () => {
    const sent = mockFetch({
      ask: { ...ASK, state: 'answered' },
      queued: true,
      recorded: true,
    })
    expect(await answerAsk('Q 1', { choice: 2, updated: 'u1' })).toEqual({
      ask: { ...ASK, state: 'answered' },
      queued: true,
      recorded: true,
    })
    expect(sent[0]).toEqual({
      url: '/api/mux/asks/Q%201/answer',
      method: 'POST',
      body: { choice: 2, updated: 'u1' },
    })
    mockFetch({ ask: ASK })
    expect(await answerAsk('Q1', { text: 'yes', updated: 'u1' })).toEqual({
      ask: ASK,
      queued: false,
      recorded: false,
    })
  })

  it('throws the refusal of an answer', async () => {
    mockFetch({ code: 'input_has_draft', error: 'x' }, 409)
    const err = await answerAsk('Q1', { text: 'yes', updated: 'u1' }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(RequestError)
    expect(err).toMatchObject({ status: 409, code: 'input_has_draft' })
  })

  it('dismisses an ask, naming the version read', async () => {
    const sent = mockFetch({ ask: { ...ASK, state: 'dismissed' } })
    expect(await dismissAsk('Q 1', 'u1')).toEqual({
      ask: { ...ASK, state: 'dismissed' },
    })
    expect(sent[0]).toEqual({
      url: '/api/mux/asks/Q%201/dismiss',
      method: 'POST',
      body: { updated: 'u1' },
    })
    mockFetch({ code: 'ask_closed', error: 'x' }, 409)
    const err = await dismissAsk('Q1', 'u1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err).toMatchObject({ status: 409, code: 'ask_closed' })
  })
})
