import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFilesPersist, signedOut } from '../utils/files-persist'
import type { UserTask } from './use-mux-api'
import {
  refreshUserTasks,
  resetUserTasks,
  setUserTasksServer,
  useUserTasks,
} from './use-user-tasks'

const api = vi.hoisted(() => ({
  fetchUserTasks: vi.fn(),
  createUserTask: vi.fn(),
  updateUserTask: vi.fn(),
  deleteUserTask: vi.fn(),
}))
vi.mock('./use-mux-api', () => api)

const task = (id: string, name: string, updated = 'u'): UserTask => ({
  id,
  name,
  command: `run ${name}`,
  updated,
})

// A read the test answers when it chooses
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useUserTasks', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    resetUserTasks()
    setUserTasksServer('i1', true)
  })
  afterEach(() => resetFilesPersist())

  it('reads them once for every caller at the same time', async () => {
    const read = deferred<unknown>()
    api.fetchUserTasks.mockReturnValue(read.promise)
    const { result } = renderHook(() => useUserTasks())
    expect(result.current).toMatchObject({ loaded: false, tasks: [] })
    act(() => {
      void result.current.refresh()
    })
    expect(api.fetchUserTasks).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(true)
    await act(async () => {
      read.resolve({ tasks: [task('1', 'a')], readOnly: true })
      await read.promise
    })
    expect(result.current).toMatchObject({
      loaded: true,
      loading: false,
      error: false,
      readOnly: true,
      tasks: [task('1', 'a')],
    })
  })

  it('gives the same refresh at every render, so an effect reads once', () => {
    api.fetchUserTasks.mockReturnValue(new Promise(() => {}))
    const { result, rerender } = renderHook(() => useUserTasks())
    const first = result.current.refresh
    rerender()
    expect(result.current.refresh).toBe(first)
  })

  it('a failed read says so and keeps what it had', async () => {
    api.fetchUserTasks.mockResolvedValueOnce({
      tasks: [task('1', 'a')],
      readOnly: false,
    })
    const { result } = renderHook(() => useUserTasks())
    await act(() => result.current.refresh())
    api.fetchUserTasks.mockRejectedValueOnce(new Error('x'))
    await act(() => result.current.refresh())
    expect(result.current).toMatchObject({
      error: true,
      loading: false,
      loaded: true,
      tasks: [task('1', 'a')],
    })
  })

  it('never shows another server, nor reads when turned off', async () => {
    const read = deferred<unknown>()
    api.fetchUserTasks.mockReturnValueOnce(read.promise)
    const { result } = renderHook(() => useUserTasks())
    act(() => {
      void result.current.refresh()
    })
    // The same server again changes nothing
    act(() => setUserTasksServer('i1', true))
    expect(result.current.loading).toBe(true)
    act(() => setUserTasksServer('i2', true))
    expect(result.current).toMatchObject({ loading: false, loaded: false })
    await act(async () => {
      read.resolve({ tasks: [task('1', 'old server')], readOnly: false })
      await read.promise
    })
    expect(result.current).toMatchObject({ loaded: false, tasks: [] })
    // A read that fails late lands nowhere either
    const late = deferred<unknown>()
    api.fetchUserTasks.mockReturnValueOnce(late.promise)
    act(() => {
      void result.current.refresh()
    })
    act(() => setUserTasksServer('i3', true))
    await act(async () => {
      late.reject(new Error('x'))
      await late.promise.catch(() => {})
    })
    expect(result.current.error).toBe(false)
    // Tasks turned off: nothing is read
    act(() => setUserTasksServer('i3', false))
    await act(() => result.current.refresh())
    expect(api.fetchUserTasks).toHaveBeenCalledTimes(2)
    expect(result.current.loading).toBe(false)
  })

  it('only the latest of two reads lands', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    api.fetchUserTasks
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useUserTasks())
    act(() => {
      void result.current.refresh()
      void refreshUserTasks()
    })
    await act(async () => {
      second.resolve({ tasks: [task('2', 'new')], readOnly: false })
      await second.promise
    })
    await act(async () => {
      first.resolve({ tasks: [task('1', 'stale')], readOnly: false })
      await first.promise
    })
    expect(result.current.tasks).toEqual([task('2', 'new')])
  })

  it('a write returns its answer, then reads them again', async () => {
    api.fetchUserTasks.mockResolvedValue({
      tasks: [task('3', 'a')],
      readOnly: false,
    })
    const { result } = renderHook(() => useUserTasks())

    api.createUserTask.mockResolvedValue(task('3', 'a'))
    await act(async () => {
      expect(
        await result.current.create({ name: 'a', command: 'run a' }),
      ).toEqual(task('3', 'a'))
    })
    expect(api.createUserTask).toHaveBeenCalledWith({
      name: 'a',
      command: 'run a',
    })
    expect(api.fetchUserTasks).toHaveBeenCalledTimes(1)
    expect(result.current.tasks).toEqual([task('3', 'a')])

    api.updateUserTask.mockResolvedValue(task('3', 'B', 'u2'))
    await act(() =>
      result.current.update('3', { name: 'B', command: 'c', updated: 'u' }),
    )
    expect(api.updateUserTask).toHaveBeenCalledWith('3', {
      name: 'B',
      command: 'c',
      updated: 'u',
    })
    expect(api.fetchUserTasks).toHaveBeenCalledTimes(2)

    api.deleteUserTask.mockResolvedValue(undefined)
    await act(() => result.current.remove(task('3', 'a', 'u9')))
    expect(api.deleteUserTask).toHaveBeenCalledWith('3', 'u9')
    expect(api.fetchUserTasks).toHaveBeenCalledTimes(3)
  })

  it('a write that ends after a sign-out or another server reads nothing', async () => {
    api.fetchUserTasks.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useUserTasks())
    for (const [i, write] of [
      () => result.current.create({ name: 'a', command: 'c' }),
      () =>
        result.current.update('1', { name: 'a', command: 'c', updated: 'u' }),
      () => result.current.remove(task('1', 'a')),
    ].entries()) {
      const answer = deferred<unknown>()
      api.createUserTask.mockReturnValueOnce(answer.promise)
      api.updateUserTask.mockReturnValueOnce(answer.promise)
      api.deleteUserTask.mockReturnValueOnce(answer.promise)
      let done!: Promise<unknown>
      act(() => {
        done = write()
      })
      act(() => setUserTasksServer(`other${i}`, true))
      await act(async () => {
        answer.resolve(task('1', 'a'))
        await done
      })
    }
    expect(api.fetchUserTasks).not.toHaveBeenCalled()
  })

  it('a write that is refused throws and reads nothing', async () => {
    const { result } = renderHook(() => useUserTasks())
    api.createUserTask.mockRejectedValue(new Error('name_taken'))
    await expect(
      act(() => result.current.create({ name: 'a', command: 'c' })),
    ).rejects.toThrow('name_taken')
    expect(result.current.tasks).toEqual([])
    expect(api.fetchUserTasks).not.toHaveBeenCalled()
  })

  it('a sign-out forgets them', async () => {
    api.fetchUserTasks.mockResolvedValue({
      tasks: [task('1', 'a')],
      readOnly: false,
    })
    const { result } = renderHook(() => useUserTasks())
    await act(() => result.current.refresh())
    act(() => signedOut())
    expect(result.current).toMatchObject({ loaded: false, tasks: [] })
    // Not read again until a snapshot names the server
    await act(() => result.current.refresh())
    expect(api.fetchUserTasks).toHaveBeenCalledTimes(1)
  })
})
