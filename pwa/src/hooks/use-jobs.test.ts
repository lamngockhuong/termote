import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ask, Job } from './use-mux-api'

const api = vi.hoisted(() => ({
  fetchJobs: vi.fn(),
  fetchAsks: vi.fn(),
  answerAsk: vi.fn(),
  dismissAsk: vi.fn(),
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
  dismissAsk: (id: string, u: string) => api.dismissAsk(id, u),
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

import { setCurrentMachineForTest } from '../utils/api-base'
import {
  addJob,
  answerQuestion,
  changeJob,
  dismissQuestion,
  grantJob,
  pinJobPRs,
  reloadJobs,
  removeJob,
  resetJobs,
  revokeJobGrant,
  runJobCI,
  useCurrentJob,
  useJobs,
  useOpenAsks,
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

  it('tells a machine without the ledger from every other failure', async () => {
    setCurrentMachineForTest('0123456789abcdef')
    try {
      api.fetchAsks.mockResolvedValue(asks([]))
      api.fetchJobs
        .mockRejectedValueOnce(new RequestError(404, '', 'not found'))
        .mockRejectedValueOnce(refusal('machine_route_forbidden', 404))
        .mockRejectedValueOnce(refusal('jobs_unavailable', 503))
        .mockResolvedValueOnce(list([job('a')]))
        .mockRejectedValueOnce(refusal('machine_offline', 502))
        .mockRejectedValueOnce(new RequestError(404, '', 'not found'))
        .mockResolvedValueOnce(list([job('b')]))
      const { result } = renderHook(() => useJobs())
      await act(() => reloadJobs())
      expect(result.current).toMatchObject({
        outdated: true,
        unavailable: false,
      })
      await act(() => reloadJobs())
      expect(result.current).toMatchObject({
        outdated: false,
        unavailable: true,
      })
      await act(() => reloadJobs())
      expect(result.current).toMatchObject({
        outdated: false,
        unavailable: true,
      })
      await act(() => reloadJobs())
      // Offline: an error, the jobs read before kept
      await act(() => reloadJobs())
      expect(result.current).toMatchObject({
        jobs: [job('a')],
        error: true,
        outdated: false,
        unavailable: false,
      })
      await act(() => reloadJobs())
      expect(result.current.outdated).toBe(true)
      await act(() => reloadJobs())
      expect(result.current).toMatchObject({
        jobs: [job('b')],
        outdated: false,
      })
    } finally {
      setCurrentMachineForTest('')
    }
  })

  it('reads a 404 without a code on this server as no ledger', async () => {
    api.fetchAsks.mockResolvedValue(asks([]))
    api.fetchJobs.mockRejectedValueOnce(new RequestError(404, '', 'not found'))
    const { result } = renderHook(() => useJobs())
    await act(() => reloadJobs())
    expect(result.current).toMatchObject({ outdated: false, unavailable: true })
  })

  it('tells a machine without the asks, until it has them', async () => {
    setCurrentMachineForTest('0123456789abcdef')
    try {
      api.fetchJobs.mockResolvedValue(list([job('a')]))
      api.fetchAsks
        .mockRejectedValueOnce(new RequestError(404, '', 'not found'))
        .mockRejectedValueOnce(refusal('jobs_unavailable', 503))
        .mockResolvedValueOnce(asks([ask('Q1')]))
      const { result } = renderHook(() => useJobs())
      await act(() => reloadJobs())
      expect(result.current).toMatchObject({ asksOutdated: true, asks: [] })
      await act(() => reloadJobs())
      expect(result.current.asksOutdated).toBe(false)
      await act(() => reloadJobs())
      expect(result.current).toMatchObject({
        asksOutdated: false,
        asks: [ask('Q1')],
      })
    } finally {
      setCurrentMachineForTest('')
    }
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

  it('lands only the latest read of the asks, keeping them on other refusals', async () => {
    api.fetchJobs.mockResolvedValue(list([]))
    let first = (_v: unknown) => {}
    let fail = (_e: unknown) => {}
    api.fetchAsks
      .mockReturnValueOnce(new Promise((ok) => (first = ok)))
      .mockReturnValueOnce(new Promise((_ok, no) => (fail = no)))
      .mockResolvedValueOnce(asks([ask('new')]))
      .mockRejectedValueOnce(refusal('busy', 500))
    const { result } = renderHook(() => useJobs())
    const a = reloadJobs()
    const b = reloadJobs()
    await act(() => reloadJobs())
    first(asks([ask('old')]))
    fail(new RequestError(404, '', 'not found'))
    await act(() => Promise.all([a, b]))
    expect(result.current.asks).toEqual([ask('new')])
    // A refusal that is not a missing ledger keeps the last asks read
    await act(() => reloadJobs())
    expect(result.current.asks).toEqual([ask('new')])
  })

  it('dismisses an ask as read, no longer open before the next read', async () => {
    api.fetchJobs.mockResolvedValue(list([]))
    api.fetchAsks.mockResolvedValue(asks([ask('Q1'), ask('Q2')]))
    const { result } = renderHook(() => useJobs())
    const open = renderHook(() => useOpenAsks())
    await act(() => reloadJobs())
    expect(open.result.current.open).toHaveLength(2)
    api.dismissAsk.mockResolvedValueOnce({
      ask: ask('Q1', {
        state: 'dismissed',
        answeredBy: 'pwa',
        updated: 'Q1-2',
      }),
    })
    await act(() => dismissQuestion(ask('Q1')))
    expect(api.dismissAsk).toHaveBeenCalledWith('Q1', 'Q1-1')
    expect(result.current.asks.map((a) => [a.id, a.state])).toEqual([
      ['Q1', 'dismissed'],
      ['Q2', 'open'],
    ])
    expect(result.current.asks[0].updated).toBe('Q1-2')
    expect(open.result.current.open).toHaveLength(1)
    // No ask in the answer, or another one: shown dismissed all the same
    const bare = ask('Q2', { updated: undefined })
    api.dismissAsk.mockResolvedValueOnce({ ask: ask('Q9') })
    await act(() => dismissQuestion(bare))
    expect(api.dismissAsk).toHaveBeenLastCalledWith('Q2', '')
    expect(result.current.asks[1]).toEqual({ ...bare, state: 'dismissed' })
    expect(open.result.current.open).toHaveLength(0)
  })

  it('reads the asks again after a dismissal refused as stale, then throws', async () => {
    api.fetchJobs.mockResolvedValue(list([]))
    api.fetchAsks.mockResolvedValue(asks([ask('Q1', { updated: 'Q1-9' })]))
    renderHook(() => useJobs())
    for (const code of ['ask_conflict', 'ask_closed', 'ask_not_found']) {
      api.dismissAsk.mockRejectedValueOnce(refusal(code))
      await act(async () => {
        await expect(dismissQuestion(ask('Q1'))).rejects.toMatchObject({
          code,
        })
      })
    }
    expect(api.fetchAsks).toHaveBeenCalledTimes(3)
    api.dismissAsk.mockRejectedValueOnce(refusal('ask_busy'))
    await expect(dismissQuestion(ask('Q1'))).rejects.toMatchObject({
      code: 'ask_busy',
    })
    expect(api.fetchAsks).toHaveBeenCalledTimes(3)
  })

  it('shows an ask answered whatever the server answered with', async () => {
    api.fetchJobs.mockResolvedValue(list([]))
    const bare = ask('Q1', { updated: undefined })
    api.fetchAsks.mockResolvedValue(asks([bare]))
    const { result } = renderHook(() => useJobs())
    await act(() => reloadJobs())
    // No ask in the answer: an ask with no version read sends an empty one
    api.answerAsk.mockResolvedValueOnce({ queued: false, recorded: true })
    await act(() => answerQuestion(bare, { choice: 1 }).then(() => {}))
    expect(api.answerAsk).toHaveBeenCalledWith('Q1', {
      choice: 1,
      updated: '',
    })
    expect(result.current.asks[0]).toEqual({ ...bare, state: 'answered' })
    // Another ask in the answer is not taken for this one
    api.answerAsk.mockResolvedValueOnce({
      ask: ask('Q9', { state: 'answered' }),
      queued: false,
      recorded: true,
    })
    await act(() => answerQuestion(bare, { choice: 2 }).then(() => {}))
    expect(result.current.asks).toEqual([{ ...bare, state: 'answered' }])
  })
})

describe('useOpenAsks', () => {
  let hidden = false
  beforeEach(() => {
    vi.useFakeTimers()
    resetJobs()
    for (const fn of Object.values(api)) fn.mockReset()
    hidden = false
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  })
  afterEach(() => {
    resetJobs()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const flush = () => act(() => vi.advanceTimersByTimeAsync(0))

  it('reads the asks on its own every period, the open ones only', async () => {
    api.fetchAsks.mockResolvedValue(
      asks([ask('Q1'), ask('Q2', { state: 'answered' })]),
    )
    const { result, unmount } = renderHook(() => useOpenAsks())
    await flush()
    expect(api.fetchAsks).toHaveBeenCalledTimes(1)
    expect(result.current).toEqual({ open: [ask('Q1')], readOnly: false })
    // Never the ledger, nor the overview
    expect(api.fetchJobs).not.toHaveBeenCalled()
    expect(api.follow).not.toHaveBeenCalled()

    api.fetchAsks.mockResolvedValue(asks([ask('Q3')], true))
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(api.fetchAsks).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual({ open: [ask('Q3')], readOnly: true })

    unmount()
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(api.fetchAsks).toHaveBeenCalledTimes(2)
  })

  it('keeps the same list until the asks change', async () => {
    api.fetchAsks.mockResolvedValue(asks([ask('Q1')]))
    const { result } = renderHook(() => useOpenAsks())
    await flush()
    const first = result.current
    // A write of a job changes the store, not the asks
    api.createJob.mockResolvedValue(job('a'))
    await act(() => addJob({ title: 'a' }).then(() => {}))
    expect(result.current).toBe(first)
  })

  it('skips a read the overview made in the period, and reads nothing hidden', async () => {
    api.fetchAsks.mockResolvedValue(asks([ask('Q1')]))
    api.fetchJobs.mockResolvedValue(list([]))
    renderHook(() => useOpenAsks())
    await flush()
    expect(api.fetchAsks).toHaveBeenCalledTimes(1)
    // The overview read them 2 s later: the poll at 5 s has nothing to do
    await act(() => vi.advanceTimersByTimeAsync(2000))
    await act(() => reloadJobs())
    expect(api.fetchAsks).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(api.fetchAsks).toHaveBeenCalledTimes(2)

    hidden = true
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(api.fetchAsks).toHaveBeenCalledTimes(2)
    // Shown again: read at once
    hidden = false
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(api.fetchAsks).toHaveBeenCalledTimes(3)
  })

  it('reads a minute apart from a server without asks, until it has them', async () => {
    api.fetchAsks.mockRejectedValue(new RequestError(404, '', 'not found'))
    const { result } = renderHook(() => useOpenAsks())
    await flush()
    expect(result.current.open).toEqual([])
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(api.fetchAsks).toHaveBeenCalledTimes(1)
    api.fetchAsks.mockResolvedValue(asks([ask('Q1')]))
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(api.fetchAsks).toHaveBeenCalledTimes(2)
    expect(result.current.open).toEqual([ask('Q1')])
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(api.fetchAsks).toHaveBeenCalledTimes(3)
  })

  it('polls once for every reader, and stops with the last, even mid-read', async () => {
    let answer: (v: unknown) => void = () => {}
    api.fetchAsks.mockImplementation(() => new Promise((r) => (answer = r)))
    const first = renderHook(() => useOpenAsks())
    const second = renderHook(() => useOpenAsks())
    expect(api.fetchAsks).toHaveBeenCalledTimes(1)
    // One reader left: the poll goes on
    first.unmount()
    // A hidden page told it was hidden reads nothing
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    hidden = false
    // The last one leaves while the read is under way: none follows it
    second.unmount()
    await act(async () => {
      answer(asks([ask('Q1')]))
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(api.fetchAsks).toHaveBeenCalledTimes(1)
  })

  it('leaves the overview to start its own follow', async () => {
    api.fetchAsks.mockResolvedValue(asks([]))
    renderHook(() => useOpenAsks())
    await flush()
    renderHook(() => useJobs())
    expect(api.follow).toHaveBeenCalledTimes(1)
  })
})
