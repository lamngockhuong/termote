import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type PaneTasks,
  RequestError,
  type TaskRun,
  type TaskRunStart,
} from './use-mux-api'
import { TASK_POLL_MS, type TaskItem, taskItems, useTasks } from './use-tasks'

const api = vi.hoisted(() => ({
  fetchTasks: vi.fn(),
  runTask: vi.fn(),
  fetchTaskRun: vi.fn(),
}))
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  ...api,
}))

const paneTasks = (over: Partial<PaneTasks> = {}): PaneTasks => ({
  root: '/repo',
  packageManager: 'pnpm',
  scripts: [{ name: 'test', command: 'vitest' }],
  makefile: 'Makefile',
  makeTargets: [{ name: 'compile' }],
  userTasks: [{ id: 'abc', name: 'Lint', command: 'pnpm lint', updated: 'u' }],
  runs: {},
  skipped: 0,
  tooLarge: [],
  ...over,
})

const run = (runId: string, over: Partial<TaskRun> = {}): TaskRun => ({
  runId,
  tabId: `t-${runId}`,
  paneId: 'p1',
  nonce: `n-${runId}`,
  state: 'running',
  ...over,
})

const start = (runId: string): TaskRunStart => ({
  runId,
  tabId: `t-${runId}`,
  paneId: 'p1',
  nonce: `n-${runId}`,
  reused: false,
})

const item = (over: Partial<TaskItem> = {}): TaskItem => ({
  key: 'script:test',
  kind: 'script',
  name: 'test',
  command: 'vitest',
  label: 'pnpm run test',
  ...over,
})

const conflict = (root?: string) =>
  new RequestError(409, 'root_changed', 'moved', { root })

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.fetchTasks.mockResolvedValue(paneTasks())
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  vi.useRealTimers()
  // Back to the jsdom getter on the prototype
  Reflect.deleteProperty(document, 'visibilityState')
})

describe('taskItems', () => {
  it('groups scripts, make targets and user tasks with what the view shows', () => {
    const t = paneTasks({
      scripts: [
        { name: 'pack', command: 'tsc', hooks: ['prepack'], truncated: true },
        { name: 'test', command: 'vitest' },
      ],
      makeTargets: [{ name: 'all' }],
    })
    expect(taskItems(t)).toEqual({
      scripts: [
        {
          key: 'script:pack',
          kind: 'script',
          name: 'pack',
          command: 'tsc',
          label: 'pnpm run pack',
          hooks: ['prepack'],
          truncated: true,
        },
        {
          key: 'script:test',
          kind: 'script',
          name: 'test',
          command: 'vitest',
          label: 'pnpm run test',
          hooks: undefined,
          truncated: undefined,
        },
      ],
      make: [
        {
          key: 'make:all',
          kind: 'make',
          name: 'all',
          command: 'make all',
          label: 'make all',
        },
      ],
      user: [
        {
          key: 'user:abc',
          kind: 'user',
          name: 'Lint',
          id: 'abc',
          command: 'pnpm lint',
          label: 'Lint',
        },
      ],
    })
  })

  it('gives empty groups for an empty listing', () => {
    expect(
      taskItems(
        paneTasks({ scripts: [], makeTargets: [], userTasks: [], runs: {} }),
      ),
    ).toEqual({ scripts: [], make: [], user: [] })
  })
})

describe('useTasks', () => {
  it('reads the pane tasks on mount', async () => {
    const read = deferred<PaneTasks>()
    api.fetchTasks.mockReturnValueOnce(read.promise)
    const { result } = renderHook(() => useTasks('p1'))
    expect(result.current).toMatchObject({ data: null, loading: true })
    expect(api.fetchTasks).toHaveBeenCalledWith('p1', undefined)
    const ended = run('r1', { state: 'exited', code: 0 })
    await act(async () => {
      read.resolve(paneTasks({ runs: { 'make:compile': ended } }))
      await read.promise
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.data?.root).toBe('/repo')
    expect(result.current.runs).toEqual({ 'make:compile': ended })
  })

  it('reads nothing without a pane, and Run refuses', async () => {
    const { result } = renderHook(() => useTasks(undefined))
    await act(async () => {})
    expect(api.fetchTasks).not.toHaveBeenCalled()
    expect(result.current).toMatchObject({ data: null, loading: false })
    await expect(result.current.run(item())).rejects.toThrow('no tasks read')
    await act(() => result.current.reload())
    expect(api.fetchTasks).not.toHaveBeenCalled()
  })

  it('a reload sends the root it saw', async () => {
    const { result } = renderHook(() => useTasks('p1'))
    await act(async () => {})
    await act(() => result.current.reload())
    expect(api.fetchTasks).toHaveBeenNthCalledWith(2, 'p1', '/repo')
  })

  it('a root the server says changed is read again without it', async () => {
    const { result } = renderHook(() => useTasks('p1'))
    await act(async () => {})
    api.fetchTasks
      .mockRejectedValueOnce(conflict('/other'))
      .mockResolvedValueOnce(paneTasks({ root: '/other' }))
    await act(() => result.current.reload())
    expect(api.fetchTasks).toHaveBeenCalledTimes(3)
    expect(api.fetchTasks.mock.calls[1]).toEqual(['p1', '/repo'])
    expect(api.fetchTasks.mock.calls[2]).toEqual(['p1'])
    expect(result.current.data?.root).toBe('/other')
    expect(result.current.error).toBeNull()
    // The new root is the one sent next
    await act(() => result.current.reload())
    expect(api.fetchTasks.mock.calls[3]).toEqual(['p1', '/other'])
  })

  it('keeps the error of a failed read, and a later read clears it', async () => {
    const boom = new RequestError(500, 'internal', 'x')
    api.fetchTasks.mockRejectedValueOnce(boom)
    const { result } = renderHook(() => useTasks('p1'))
    await act(async () => {})
    expect(result.current).toMatchObject({
      data: null,
      error: boom,
      loading: false,
    })
    await act(() => result.current.reload())
    expect(result.current.error).toBeNull()
    expect(result.current.data?.root).toBe('/repo')
  })

  it('a conflict that fails again on the second read is an error', async () => {
    const second = new RequestError(503, 'unavailable', 'down')
    api.fetchTasks
      .mockRejectedValueOnce(conflict('/x'))
      .mockRejectedValueOnce(second)
    const { result } = renderHook(() => useTasks('p1'))
    await act(async () => {})
    expect(result.current.error).toBe(second)
    expect(api.fetchTasks).toHaveBeenCalledTimes(2)
  })

  it('a refusal other than a 409 is not retried', async () => {
    api.fetchTasks.mockRejectedValueOnce(
      new RequestError(404, 'root_changed', 'x'),
    )
    const { result } = renderHook(() => useTasks('p1'))
    await act(async () => {})
    expect(api.fetchTasks).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeInstanceOf(RequestError)
  })

  it('another pane drops what the last one showed', async () => {
    const slow = deferred<PaneTasks>()
    api.fetchTasks
      .mockResolvedValueOnce(
        paneTasks({ runs: { 'script:test': run('r1', { state: 'exited' }) } }),
      )
      .mockReturnValueOnce(slow.promise)
    const { result, rerender } = renderHook(({ id }) => useTasks(id), {
      initialProps: { id: 'p1' },
    })
    await act(async () => {})
    expect(result.current.data).not.toBeNull()
    expect(Object.keys(result.current.runs)).toEqual(['script:test'])

    rerender({ id: 'p2' })
    // p1's root is not sent for p2
    expect(api.fetchTasks).toHaveBeenLastCalledWith('p2', undefined)
    expect(result.current).toMatchObject({
      data: null,
      error: null,
      runs: {},
      loading: true,
    })
    await act(async () => {
      slow.resolve(paneTasks({ root: '/p2' }))
      await slow.promise
    })
    expect(result.current.data?.root).toBe('/p2')
  })

  it('a read of the pane left behind never lands, nor does its failure', async () => {
    const old = deferred<PaneTasks>()
    const oldFail = deferred<PaneTasks>()
    api.fetchTasks
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(paneTasks({ root: '/p2' }))
    const { result, rerender } = renderHook(({ id }) => useTasks(id), {
      initialProps: { id: 'p1' },
    })
    rerender({ id: 'p2' })
    await act(async () => {})
    expect(result.current.data?.root).toBe('/p2')
    await act(async () => {
      old.resolve(paneTasks({ root: '/p1' }))
      await old.promise
    })
    expect(result.current.data?.root).toBe('/p2')

    api.fetchTasks.mockReturnValueOnce(oldFail.promise)
    act(() => {
      void result.current.reload()
    })
    rerender({ id: 'p3' })
    await act(async () => {
      oldFail.reject(new Error('late'))
      await oldFail.promise.catch(() => {})
    })
    expect(result.current.error).toBeNull()
  })

  describe('run', () => {
    it('names a script or a make target, and sends the root', async () => {
      api.runTask.mockResolvedValue(start('r1'))
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      let got: TaskRunStart | undefined
      await act(async () => {
        got = await result.current.run(item())
      })
      expect(got).toEqual(start('r1'))
      expect(api.runTask).toHaveBeenCalledWith('p1', {
        kind: 'script',
        name: 'test',
        root: '/repo',
        newTab: false,
      })
      expect(result.current.runs['script:test']).toEqual({
        ...start('r1'),
        state: 'running',
      })
      api.runTask.mockResolvedValue(start('r2'))
      await act(async () => {
        await result.current.run(
          item({ key: 'make:compile', kind: 'make', name: 'compile' }),
          true,
        )
      })
      expect(api.runTask).toHaveBeenLastCalledWith('p1', {
        kind: 'make',
        name: 'compile',
        root: '/repo',
        newTab: true,
      })
      expect(Object.keys(result.current.runs).sort()).toEqual([
        'make:compile',
        'script:test',
      ])
    })

    it('names a user task by its id, never by name', async () => {
      api.runTask.mockResolvedValue(start('r1'))
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(async () => {
        await result.current.run(
          item({ key: 'user:abc', kind: 'user', name: 'Lint', id: 'abc' }),
        )
      })
      expect(api.runTask).toHaveBeenCalledWith('p1', {
        kind: 'user',
        id: 'abc',
        root: '/repo',
        newTab: false,
      })
    })

    it('a 409 with the new root reads the tasks again, and still throws', async () => {
      const err = conflict('/new')
      api.runTask.mockRejectedValue(err)
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      api.fetchTasks.mockResolvedValueOnce(paneTasks({ root: '/new' }))
      await act(async () => {
        await expect(result.current.run(item())).rejects.toBe(err)
      })
      expect(api.fetchTasks).toHaveBeenCalledTimes(2)
      expect(result.current.data?.root).toBe('/new')
      expect(result.current.runs).toEqual({})
    })

    it('other refusals throw without reading again', async () => {
      const running = new RequestError(409, 'task_running', 'busy', {
        runId: 'r9',
        tabId: 't9',
      })
      api.runTask.mockRejectedValueOnce(running)
      api.runTask.mockRejectedValueOnce(
        new RequestError(500, 'x', 'y', { root: '/z' }),
      )
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(async () => {
        await expect(result.current.run(item())).rejects.toBe(running)
        await expect(result.current.run(item())).rejects.toMatchObject({
          status: 500,
        })
      })
      expect(api.fetchTasks).toHaveBeenCalledTimes(1)
    })

    it('a failure that is not a RequestError throws as it is', async () => {
      const boom = new TypeError('network')
      api.runTask.mockRejectedValue(boom)
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(async () => {
        await expect(result.current.run(item())).rejects.toBe(boom)
      })
      expect(api.fetchTasks).toHaveBeenCalledTimes(1)
    })
  })

  describe('runs listed by the server', () => {
    it('keeps a run this page saw end, takes the server for another run', async () => {
      vi.useFakeTimers()
      api.fetchTasks.mockResolvedValue(
        paneTasks({ runs: { 'script:test': run('r1') } }),
      )
      api.fetchTaskRun.mockResolvedValue({ state: 'exited', code: 3 })
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS)
      })
      expect(result.current.runs['script:test']).toMatchObject({
        runId: 'r1',
        state: 'exited',
        code: 3,
      })
      // The server still lists r1 as running: what this page saw stays
      await act(() => result.current.reload())
      expect(result.current.runs['script:test']).toMatchObject({
        state: 'exited',
        code: 3,
      })
      // A newer run replaces it
      api.fetchTasks.mockResolvedValue(
        paneTasks({ runs: { 'script:test': run('r2') } }),
      )
      await act(() => result.current.reload())
      expect(result.current.runs['script:test']).toEqual(run('r2'))
    })

    it('takes the server state of a run this page saw running', async () => {
      api.fetchTasks
        .mockResolvedValueOnce(
          paneTasks({ runs: { 'script:test': run('r1') } }),
        )
        .mockResolvedValueOnce(
          paneTasks({
            runs: { 'script:test': run('r1', { state: 'gone' }) },
          }),
        )
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(() => result.current.reload())
      expect(result.current.runs['script:test'].state).toBe('gone')
    })

    it('keeps a run the server forgot as unknown, drops the other local ones', async () => {
      vi.useFakeTimers()
      api.fetchTasks.mockResolvedValueOnce(
        paneTasks({
          runs: {
            'script:test': run('r1'),
            'make:compile': run('r2', { state: 'exited', code: 0 }),
          },
        }),
      )
      api.fetchTaskRun.mockRejectedValue(
        new RequestError(404, 'run_not_found', 'gone'),
      )
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS)
      })
      expect(result.current.runs['script:test'].state).toBe('unknown')
      expect(api.fetchTaskRun).toHaveBeenCalledTimes(1)
      expect(api.fetchTaskRun).toHaveBeenCalledWith('r1')
      api.fetchTasks.mockResolvedValue(paneTasks({ runs: {} }))
      await act(() => result.current.reload())
      expect(Object.keys(result.current.runs)).toEqual(['script:test'])
      expect(result.current.runs['script:test'].state).toBe('unknown')
      // unknown is not running: nothing is polled any more
      api.fetchTaskRun.mockClear()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS * 3)
      })
      expect(api.fetchTaskRun).not.toHaveBeenCalled()
    })
  })

  describe('polling', () => {
    it('does not poll while no run is running', async () => {
      vi.useFakeTimers()
      api.fetchTasks.mockResolvedValue(
        paneTasks({ runs: { 'script:test': run('r1', { state: 'exited' }) } }),
      )
      renderHook(() => useTasks('p1'))
      await act(async () => {})
      expect(vi.getTimerCount()).toBe(0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS * 3)
      })
      expect(api.fetchTaskRun).not.toHaveBeenCalled()
    })

    it('polls every TASK_POLL_MS while a run runs, and stops when it ends', async () => {
      vi.useFakeTimers()
      api.runTask.mockResolvedValue(start('r1'))
      api.fetchTaskRun
        .mockResolvedValueOnce({ state: 'running' })
        .mockResolvedValueOnce({ state: 'exited', code: 1 })
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(async () => {
        await result.current.run(item())
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS - 1)
      })
      expect(api.fetchTaskRun).not.toHaveBeenCalled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(api.fetchTaskRun).toHaveBeenCalledTimes(1)
      expect(api.fetchTaskRun).toHaveBeenCalledWith('r1')
      expect(result.current.runs['script:test'].state).toBe('running')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS)
      })
      expect(api.fetchTaskRun).toHaveBeenCalledTimes(2)
      expect(result.current.runs['script:test']).toMatchObject({
        state: 'exited',
        code: 1,
      })
      expect(vi.getTimerCount()).toBe(0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS * 3)
      })
      expect(api.fetchTaskRun).toHaveBeenCalledTimes(2)
    })

    it('waits for a slow poll before the next one', async () => {
      vi.useFakeTimers()
      api.runTask.mockResolvedValue(start('r1'))
      const slow = deferred<{ state: 'exited'; code: number }>()
      api.fetchTaskRun.mockReturnValueOnce(slow.promise)
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(async () => {
        await result.current.run(item())
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS * 3)
      })
      expect(api.fetchTaskRun).toHaveBeenCalledTimes(1)
      await act(async () => {
        slow.resolve({ state: 'exited', code: 2 })
        await slow.promise
      })
      expect(result.current.runs['script:test']).toMatchObject({ code: 2 })
    })

    it('keeps a run it started that a list read before it does not know', async () => {
      const read = deferred<PaneTasks>()
      api.runTask.mockResolvedValue(start('r1'))
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      api.fetchTasks.mockReturnValueOnce(read.promise)
      let reload!: Promise<void>
      act(() => {
        reload = result.current.reload()
      })
      await act(async () => {
        await result.current.run(item())
      })
      await act(async () => {
        read.resolve(paneTasks())
        await reload
      })
      expect(result.current.runs['script:test']).toMatchObject({
        runId: 'r1',
        state: 'running',
      })
    })

    it('a run answered after the pane changed lands nowhere', async () => {
      const answer = deferred<TaskRunStart>()
      api.runTask.mockReturnValueOnce(answer.promise)
      const { result, rerender } = renderHook(({ id }) => useTasks(id), {
        initialProps: { id: 'p1' },
      })
      await act(async () => {})
      let running!: Promise<TaskRunStart>
      act(() => {
        running = result.current.run(item())
      })
      rerender({ id: 'p2' })
      await act(async () => {
        answer.resolve(start('r1'))
        await running
      })
      expect(result.current.runs).toEqual({})
    })

    it('polls only the runs that run, one request each', async () => {
      vi.useFakeTimers()
      api.fetchTasks.mockResolvedValue(
        paneTasks({
          runs: {
            'script:test': run('r1'),
            'make:compile': run('r2', { state: 'exited' }),
            'user:abc': run('r3'),
          },
        }),
      )
      api.fetchTaskRun.mockResolvedValue({ state: 'running' })
      renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS)
      })
      expect(api.fetchTaskRun.mock.calls.map((c) => c[0])).toEqual(['r1', 'r3'])
    })

    it('skips a tick while the page is hidden', async () => {
      vi.useFakeTimers()
      api.fetchTasks.mockResolvedValue(
        paneTasks({ runs: { 'script:test': run('r1') } }),
      )
      api.fetchTaskRun.mockResolvedValue({ state: 'exited', code: 0 })
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      visibility = 'hidden'
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS * 2)
      })
      expect(api.fetchTaskRun).not.toHaveBeenCalled()
      expect(result.current.runs['script:test'].state).toBe('running')
      visibility = 'visible'
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS)
      })
      expect(api.fetchTaskRun).toHaveBeenCalledTimes(1)
      expect(result.current.runs['script:test'].state).toBe('exited')
    })

    it('ignores a failed poll and goes on with the other runs and the next tick', async () => {
      vi.useFakeTimers()
      api.fetchTasks.mockResolvedValue(
        paneTasks({
          runs: { 'script:test': run('r1'), 'user:abc': run('r3') },
        }),
      )
      api.fetchTaskRun.mockImplementation(async (id: string) => {
        if (id === 'r1') throw new RequestError(500, 'internal', 'x')
        return { state: 'exited', code: 0 }
      })
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS)
      })
      expect(result.current.runs['script:test'].state).toBe('running')
      expect(result.current.runs['user:abc'].state).toBe('exited')
      // A failure that is not a RequestError is ignored too
      api.fetchTaskRun.mockRejectedValue(new TypeError('offline'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS)
      })
      expect(result.current.runs['script:test'].state).toBe('running')
      api.fetchTaskRun.mockResolvedValue({ state: 'ended' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS)
      })
      expect(result.current.runs['script:test']).toMatchObject({
        state: 'ended',
        code: undefined,
      })
    })

    it('an answer for a run that another run replaced is ignored', async () => {
      vi.useFakeTimers()
      const slow = deferred<{ state: 'exited'; code: number }>()
      api.fetchTasks.mockResolvedValue(
        paneTasks({ runs: { 'script:test': run('r1') } }),
      )
      api.fetchTaskRun.mockReturnValueOnce(slow.promise)
      api.fetchTaskRun.mockResolvedValue({ state: 'running' })
      api.runTask.mockResolvedValue(start('r2'))
      const { result } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS)
      })
      expect(api.fetchTaskRun).toHaveBeenCalledWith('r1')
      await act(async () => {
        await result.current.run(item())
      })
      await act(async () => {
        slow.resolve({ state: 'exited', code: 9 })
        await slow.promise
      })
      expect(result.current.runs['script:test']).toEqual({
        ...start('r2'),
        state: 'running',
      })
    })

    it('stops at unmount: no timer, and an answer in flight lands nowhere', async () => {
      vi.useFakeTimers()
      const slow = deferred<{ state: 'exited' }>()
      api.fetchTasks.mockResolvedValue(
        paneTasks({ runs: { 'script:test': run('r1') } }),
      )
      api.fetchTaskRun.mockReturnValueOnce(slow.promise)
      const { result, unmount } = renderHook(() => useTasks('p1'))
      await act(async () => {})
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS)
      })
      expect(api.fetchTaskRun).toHaveBeenCalledTimes(1)
      const before = result.current.runs
      unmount()
      expect(vi.getTimerCount()).toBe(0)
      await act(async () => {
        slow.resolve({ state: 'exited' })
        await slow.promise
        await vi.advanceTimersByTimeAsync(TASK_POLL_MS * 3)
      })
      expect(api.fetchTaskRun).toHaveBeenCalledTimes(1)
      expect(result.current.runs).toBe(before)
      expect(result.current.runs['script:test'].state).toBe('running')
    })
  })
})
