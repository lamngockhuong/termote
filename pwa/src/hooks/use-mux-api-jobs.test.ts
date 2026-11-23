import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGrant,
  createJob,
  deleteJob,
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
    })
    expect(await fetchJobs()).toEqual({
      jobs: [JOB],
      readOnly: true,
      serverNow: 'now',
      canGrant: true,
      ciAvailable: true,
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
    })
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
