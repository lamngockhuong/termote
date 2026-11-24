import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ask, Job } from './use-mux-api'

const api = vi.hoisted(() => ({
  fetchJobs: vi.fn(),
  fetchAsks: vi.fn(),
  answerAsk: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  deleteJob: vi.fn(),
  createGrant: vi.fn(),
  revokeGrant: vi.fn(),
  jobCI: vi.fn(),
  follow: vi.fn(),
  stop: vi.fn(),
}))
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchJobs: () => api.fetchJobs(),
  fetchAsks: () => api.fetchAsks(),
  answerAsk: (id: string, a: unknown) => api.answerAsk(id, a),
  createJob: (j: unknown) => api.createJob(j),
  updateJob: (id: string, c: unknown) => api.updateJob(id, c),
  deleteJob: (id: string, u: string) => api.deleteJob(id, u),
  createGrant: (id: string, g: unknown) => api.createGrant(id, g),
  revokeGrant: (id: string, g: string) => api.revokeGrant(id, g),
  jobCI: (id: string, a: string) => api.jobCI(id, a),
}))
vi.mock('./use-agent-overview', () => ({
  followOverview: (read: () => Promise<void>) => {
    api.follow(read)
    return api.stop
  },
}))

import {
  addJob,
  answerQuestion,
  changeJob,
  grantJob,
  pinJobPRs,
  reloadJobs,
  removeJob,
  resetJobs,
  revokeJobGrant,
  runJobCI,
  useCurrentJob,
  useJobs,
} from './use-jobs'
import { RequestError } from './use-mux-api'

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  title: id,
  state: 'todo',
  updated: `${id}-1`,
  live: {},
  ...over,
})

const list = (jobs: Job[], over = {}) => ({
  jobs,
  readOnly: false,
  canGrant: true,
  serverNow: new Date(Date.now() + 5000).toISOString(),
  ...over,
})

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id,
  state: 'open',
  text: `question ${id}`,
  created: '2026-11-24T00:00:00Z',
  updated: `${id}-1`,
  ...over,
})

const asks = (list: Ask[], readOnly = false) => ({ asks: list, readOnly })

const refusal = (code: string, status = 409) =>
  new RequestError(status, code, code)

describe('useJobs', () => {
  beforeEach(() => {
    resetJobs()
    for (const fn of Object.values(api)) fn.mockReset()
  })
  afterEach(() => resetJobs())

  it('follows the overview while read, and reads with it', async () => {
    api.fetchJobs.mockResolvedValue(list([job('a')]))
    const a = renderHook(() => useJobs())
    const b = renderHook(() => useJobs())
    expect(api.follow).toHaveBeenCalledTimes(1)
    expect(a.result.current.loaded).toBe(false)
    const read = api.follow.mock.calls[0][0] as () => Promise<void>
    expect(read).toBe(reloadJobs)
    await act(() => read())
    expect(b.result.current).toMatchObject({
      jobs: [job('a')],
      loaded: true,
      canGrant: true,
      readOnly: false,
      error: false,
    })
    expect(b.result.current.clockOffset).toBeGreaterThan(4000)
    a.unmount()
    expect(api.stop).not.toHaveBeenCalled()
    b.unmount()
    expect(api.stop).toHaveBeenCalledTimes(1)
  })

  it('takes no offset from a server time it cannot read', async () => {
    api.fetchJobs.mockResolvedValue(list([], { serverNow: '' }))
    const { result } = renderHook(() => useJobs())
    await act(() => reloadJobs())
    expect(result.current.clockOffset).toBe(0)
  })

  it('keeps the last read through a failure, and hides on no ledger', async () => {
    api.fetchJobs
      .mockResolvedValueOnce(list([job('a')]))
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(refusal('jobs_unavailable', 503))
      .mockRejectedValueOnce(new RequestError(404, '', 'not found'))
    const { result } = renderHook(() => useJobs())
    await act(() => reloadJobs())
    await act(() => reloadJobs())
    expect(result.current).toMatchObject({
      jobs: [job('a')],
      error: true,
      unavailable: false,
    })
    await act(() => reloadJobs())
    expect(result.current.unavailable).toBe(true)
    await act(() => reloadJobs())
    expect(result.current.unavailable).toBe(true)
  })

  it('lands only the latest read', async () => {
    let first = (_v: unknown) => {}
    let fail = (_e: unknown) => {}
    api.fetchJobs
      .mockReturnValueOnce(new Promise((ok) => (first = ok)))
      .mockReturnValueOnce(new Promise((_ok, no) => (fail = no)))
      .mockResolvedValueOnce(list([job('new')]))
    const { result } = renderHook(() => useJobs())
    const a = reloadJobs()
    const b = reloadJobs()
    await act(() => reloadJobs())
    first(list([job('old')]))
    fail(new Error('late'))
    await act(() => Promise.all([a, b]))
    expect(result.current.jobs).toEqual([job('new')])
    expect(result.current.error).toBe(false)
  })

  it('shows what a write answered before the next read', async () => {
    api.fetchJobs.mockResolvedValue(list([job('a'), job('b')]))
    const { result } = renderHook(() => useJobs())
    await act(() => reloadJobs())

    api.createJob.mockResolvedValue(job('c'))
    await act(() => addJob({ title: 'c' }).then(() => {}))
    expect(api.createJob).toHaveBeenCalledWith({ title: 'c' })
    expect(result.current.jobs.map((j) => j.id)).toEqual(['a', 'b', 'c'])

    const changed = job('b', { state: 'review', updated: 'b-2' })
    api.updateJob.mockResolvedValue(changed)
    await act(() => changeJob(job('b'), { state: 'review' }).then(() => {}))
    expect(api.updateJob).toHaveBeenCalledWith('b', {
      state: 'review',
      updated: 'b-1',
    })
    expect(result.current.jobs[1]).toEqual(changed)

    api.createGrant.mockResolvedValue(job('a', { updated: 'a-2' }))
    await act(() => grantJob(job('a'), { kind: 'edit' }).then(() => {}))
    expect(api.createGrant).toHaveBeenCalledWith('a', { kind: 'edit' })
    api.revokeGrant.mockResolvedValue(job('a', { updated: 'a-3' }))
    await act(() => revokeJobGrant(job('a'), 'g1').then(() => {}))
    expect(api.revokeGrant).toHaveBeenCalledWith('a', 'g1')
    expect(result.current.jobs[0].updated).toBe('a-3')

    api.deleteJob.mockResolvedValue(undefined)
    await act(() => removeJob(changed))
    expect(api.deleteJob).toHaveBeenCalledWith('b', 'b-2')
    expect(result.current.jobs.map((j) => j.id)).toEqual(['a', 'c'])
  })

  it("attaches pull requests and runs a job's CI action, showing the answer", async () => {
    api.fetchJobs.mockResolvedValue(list([job('a')]))
    const { result } = renderHook(() => useJobs())
    await act(() => reloadJobs())

    api.updateJob.mockResolvedValue(job('a', { updated: 'a-2' }))
    await act(() => pinJobPRs(job('a'), [12], [3]).then(() => {}))
    expect(api.updateJob).toHaveBeenCalledWith('a', {
      addPrs: [12],
      removePrs: [3],
      updated: 'a-1',
    })
    expect(result.current.jobs[0].updated).toBe('a-2')

    const read = job('a', {
      updated: 'a-2',
      ciSummary: { worst: 'fail', count: 1, numbers: [12] },
    })
    api.jobCI.mockResolvedValue({ job: read, queued: true })
    let answer: { queued: boolean } | undefined
    await act(async () => {
      answer = await runJobCI(job('a'), 'send')
    })
    expect(api.jobCI).toHaveBeenCalledWith('a', 'send')
    expect(answer?.queued).toBe(true)
    expect(result.current.jobs[0].ciSummary?.worst).toBe('fail')

    // A refusal is thrown to the caller, the job read again first
    api.jobCI.mockRejectedValue(refusal('job_not_found', 404))
    await expect(runJobCI(job('a'), 'refresh')).rejects.toMatchObject({
      code: 'job_not_found',
    })
  })

  it('reads again after a job changed or went elsewhere, then throws', async () => {
    api.fetchJobs.mockResolvedValue(list([job('a', { updated: 'a-9' })]))
    const { result } = renderHook(() => useJobs())
    for (const code of ['job_conflict', 'job_not_found', 'grant_not_found']) {
      api.updateJob.mockRejectedValueOnce(refusal(code))
      await act(async () => {
        await expect(changeJob(job('a'), { title: 'x' })).rejects.toMatchObject(
          { code },
        )
      })
    }
    expect(api.fetchJobs).toHaveBeenCalledTimes(3)
    expect(result.current.jobs[0].updated).toBe('a-9')
    // Any other refusal reads nothing
    api.createJob.mockRejectedValueOnce(refusal('job_invalid', 400))
    await expect(addJob({ title: '' })).rejects.toMatchObject({
      code: 'job_invalid',
    })
    api.deleteJob.mockRejectedValueOnce(new Error('offline'))
    await expect(removeJob(job('a'))).rejects.toThrow('offline')
    expect(api.fetchJobs).toHaveBeenCalledTimes(3)
  })

  it('finds a job as the last read has it, else as given', async () => {
    api.fetchJobs.mockResolvedValue(list([job('a', { title: 'now' })]))
    const held = renderHook(() => useCurrentJob(job('a')))
    const gone = renderHook(() => useCurrentJob(job('z')))
    await act(() => reloadJobs())
    expect(held.result.current.title).toBe('now')
    expect(gone.result.current.title).toBe('z')
  })

  it('reads the asks with the jobs, a failure of theirs leaving the jobs be', async () => {
    api.fetchJobs.mockResolvedValue(list([job('a')]))
    api.fetchAsks
      .mockResolvedValueOnce(asks([ask('Q1')]))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(
        asks([{ id: 'Q1', state: 'open', created: '' }], true),
      )
      .mockRejectedValueOnce(refusal('jobs_unavailable', 503))
    const { result } = renderHook(() => useJobs())
    await act(() => reloadJobs())
    expect(result.current).toMatchObject({
      asks: [ask('Q1')],
      asksReadOnly: false,
      jobs: [job('a')],
    })
    // A failed read keeps the last asks, and never marks the jobs failed
    await act(() => reloadJobs())
    expect(result.current).toMatchObject({
      asks: [ask('Q1')],
      jobs: [job('a')],
      error: false,
    })
    await act(() => reloadJobs())
    expect(result.current.asksReadOnly).toBe(true)
    await act(() => reloadJobs())
    expect(result.current).toMatchObject({ asks: [], asksReadOnly: false })
  })

  it('has no asks on a server without them (404)', async () => {
    api.fetchJobs.mockResolvedValue(list([job('a')]))
    api.fetchAsks
      .mockResolvedValueOnce(asks([ask('Q1')]))
      .mockRejectedValueOnce(new RequestError(404, '', 'not found'))
    const { result } = renderHook(() => useJobs())
    await act(() => reloadJobs())
    await act(() => reloadJobs())
    expect(result.current).toMatchObject({
      asks: [],
      jobs: [job('a')],
      error: false,
      unavailable: false,
    })
  })

  it('answers an ask as read, showing it answered before the next read', async () => {
    api.fetchJobs.mockResolvedValue(list([]))
    api.fetchAsks.mockResolvedValue(asks([ask('Q1'), ask('Q2')]))
    const { result } = renderHook(() => useJobs())
    await act(() => reloadJobs())

    api.answerAsk.mockResolvedValueOnce({
      ask: ask('Q1', { state: 'answered', choice: 2, updated: 'Q1-2' }),
      queued: true,
      recorded: true,
    })
    let r: { queued: boolean } | undefined
    await act(async () => {
      r = await answerQuestion(ask('Q1'), { choice: 2 })
    })
    expect(api.answerAsk).toHaveBeenCalledWith('Q1', {
      choice: 2,
      updated: 'Q1-1',
    })
    expect(r?.queued).toBe(true)
    expect(result.current.asks.map((a) => [a.id, a.state])).toEqual([
      ['Q1', 'answered'],
      ['Q2', 'open'],
    ])

    // Sent but not recorded: the server still holds it open, it is not
    // offered again until a read says so
    api.answerAsk.mockResolvedValueOnce({
      ask: ask('Q2'),
      queued: false,
      recorded: false,
    })
    await act(() => answerQuestion(ask('Q2'), { text: 'yes' }).then(() => {}))
    expect(api.answerAsk).toHaveBeenLastCalledWith('Q2', {
      text: 'yes',
      updated: 'Q2-1',
    })
    expect(result.current.asks[1].state).toBe('answered')
  })

  it('reads the asks again after one changed or closed elsewhere, then throws', async () => {
    api.fetchJobs.mockResolvedValue(list([]))
    api.fetchAsks.mockResolvedValue(asks([ask('Q1', { updated: 'Q1-9' })]))
    const { result } = renderHook(() => useJobs())
    for (const code of ['ask_conflict', 'ask_closed', 'ask_not_found']) {
      api.answerAsk.mockRejectedValueOnce(refusal(code))
      await act(async () => {
        await expect(
          answerQuestion(ask('Q1'), { choice: 1 }),
        ).rejects.toMatchObject({ code })
      })
    }
    expect(api.fetchAsks).toHaveBeenCalledTimes(3)
    expect(api.fetchJobs).not.toHaveBeenCalled()
    expect(result.current.asks[0].updated).toBe('Q1-9')
    // Any other refusal reads nothing
    api.answerAsk.mockRejectedValueOnce(refusal('input_has_draft'))
    await expect(
      answerQuestion(ask('Q1'), { text: 'x' }),
    ).rejects.toMatchObject({ code: 'input_has_draft' })
    expect(api.fetchAsks).toHaveBeenCalledTimes(3)
  })
})
