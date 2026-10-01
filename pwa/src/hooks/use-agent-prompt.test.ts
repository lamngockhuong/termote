import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '../types/session'
import {
  FAST_POLL,
  promptPollInterval,
  resetAgentPromptStores,
  SLOW_POLL,
  useAgentPrompt,
} from './use-agent-prompt'
import type { AgentPrompt } from './use-mux-api'

const mockFetchPrompt = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchAgentPrompt: (...a: unknown[]) => mockFetchPrompt(...a),
}))

const dialog: AgentPrompt = {
  promptId: 'id1',
  kind: 'permission',
  title: 'Bash command',
  options: [{ index: 1, label: 'Yes' }],
}

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  vi.useFakeTimers()
  resetAgentPromptStores()
  mockFetchPrompt.mockReset()
  mockFetchPrompt.mockResolvedValue(null)
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('promptPollInterval', () => {
  it('is fast while the agent works or waits, slow otherwise', () => {
    expect(promptPollInterval('blocked')).toBe(FAST_POLL)
    expect(promptPollInterval('working')).toBe(FAST_POLL)
    expect(promptPollInterval('idle')).toBe(SLOW_POLL)
    expect(promptPollInterval('done')).toBe(SLOW_POLL)
    expect(promptPollInterval(undefined)).toBe(SLOW_POLL)
  })
})

describe('useAgentPrompt', () => {
  it('reads the dialog and polls at the pace of the status', async () => {
    mockFetchPrompt.mockResolvedValue(dialog)
    const { result, rerender } = renderHook(
      ({ status }: { status?: AgentStatus }) => useAgentPrompt('p1', status),
      { initialProps: { status: 'idle' as AgentStatus | undefined } },
    )
    expect(result.current.loaded).toBe(false)
    await tick()
    expect(result.current).toMatchObject({ loaded: true, prompt: dialog })
    expect(mockFetchPrompt).toHaveBeenCalledWith('p1')
    await tick(FAST_POLL)
    expect(mockFetchPrompt).toHaveBeenCalledTimes(1)
    await tick(SLOW_POLL - FAST_POLL)
    expect(mockFetchPrompt).toHaveBeenCalledTimes(2)
    // Working: the pending slow poll is brought forward
    rerender({ status: 'working' })
    await tick(FAST_POLL)
    expect(mockFetchPrompt).toHaveBeenCalledTimes(3)
    await tick(FAST_POLL)
    expect(mockFetchPrompt).toHaveBeenCalledTimes(4)
    // Back to idle: no change until the next poll uses the slow pace
    rerender({ status: 'idle' })
    await tick(FAST_POLL)
    expect(mockFetchPrompt).toHaveBeenCalledTimes(5)
    await tick(FAST_POLL)
    expect(mockFetchPrompt).toHaveBeenCalledTimes(5)
  })

  it('the same dialog again does not re-render', async () => {
    mockFetchPrompt.mockResolvedValue(dialog)
    let renders = 0
    renderHook(() => {
      renders++
      return useAgentPrompt('p1', 'blocked')
    })
    await tick()
    const after = renders
    mockFetchPrompt.mockResolvedValue({ ...dialog })
    await tick(FAST_POLL)
    await tick(FAST_POLL)
    expect(renders).toBe(after)
  })

  it('a failed read shows no card', async () => {
    mockFetchPrompt
      .mockResolvedValueOnce(dialog)
      .mockRejectedValue(new Error('x'))
    const { result } = renderHook(() => useAgentPrompt('p1', 'blocked'))
    await tick()
    expect(result.current.prompt).toEqual(dialog)
    await tick(FAST_POLL)
    expect(result.current.prompt).toBeNull()
  })

  it('every reader shares one poll; hidden pages and the last reader stop it', async () => {
    const a = renderHook(() => useAgentPrompt('p1', 'blocked'))
    const b = renderHook(() => useAgentPrompt('p1', 'blocked'))
    await tick()
    expect(mockFetchPrompt).toHaveBeenCalledTimes(1)
    visibility = 'hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await tick(FAST_POLL * 5)
    expect(mockFetchPrompt).toHaveBeenCalledTimes(1)
    visibility = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await tick()
    expect(mockFetchPrompt).toHaveBeenCalledTimes(2)
    a.unmount()
    b.unmount()
    await tick(SLOW_POLL * 2)
    expect(mockFetchPrompt).toHaveBeenCalledTimes(2)
  })

  it('refresh polls now, or right after a poll in flight', async () => {
    let resolve!: (p: AgentPrompt | null) => void
    const { result } = renderHook(() => useAgentPrompt('p1', 'idle'))
    await tick()
    act(() => result.current.refresh())
    await tick()
    expect(mockFetchPrompt).toHaveBeenCalledTimes(2)
    mockFetchPrompt.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    act(() => result.current.refresh())
    await tick()
    expect(mockFetchPrompt).toHaveBeenCalledTimes(3)
    // Mid-poll: a visibility change waits, a refresh is queued
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      result.current.refresh()
    })
    await act(async () => resolve(null))
    await tick(0)
    expect(mockFetchPrompt).toHaveBeenCalledTimes(4)
  })

  it('a status change during a poll waits for it', async () => {
    let resolve!: (p: AgentPrompt | null) => void
    const { rerender } = renderHook(
      ({ status }: { status?: AgentStatus }) => useAgentPrompt('p1', status),
      { initialProps: { status: 'idle' as AgentStatus | undefined } },
    )
    await tick()
    mockFetchPrompt.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    await tick(SLOW_POLL)
    rerender({ status: 'blocked' })
    await act(async () => resolve(null))
    await tick(FAST_POLL)
    expect(mockFetchPrompt).toHaveBeenCalledTimes(3)
  })

  it('show replaces the card until the next poll', async () => {
    const { result } = renderHook(() => useAgentPrompt('p1', 'idle'))
    await tick()
    act(() => result.current.show(dialog))
    expect(result.current.prompt).toEqual(dialog)
  })

  it('no pane: nothing is read', async () => {
    const { result } = renderHook(() => useAgentPrompt(undefined, 'blocked'))
    act(() => {
      result.current.refresh()
      result.current.show(dialog)
    })
    await tick(SLOW_POLL)
    expect(mockFetchPrompt).not.toHaveBeenCalled()
    expect(result.current.prompt).toBeNull()
  })

  it('the last reader leaving forgets the dialog', async () => {
    mockFetchPrompt.mockResolvedValue(dialog)
    const a = renderHook(() => useAgentPrompt('p1', 'blocked'))
    await tick()
    expect(a.result.current.prompt).toEqual(dialog)
    a.unmount()
    mockFetchPrompt.mockResolvedValue(null)
    const b = renderHook(() => useAgentPrompt('p1', 'blocked'))
    expect(b.result.current).toMatchObject({ prompt: null, loaded: false })
  })

  it('a reader that comes back during a poll does not start a second one', async () => {
    let resolve!: (p: AgentPrompt | null) => void
    mockFetchPrompt.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const a = renderHook(() => useAgentPrompt('p1', 'idle'))
    await tick()
    a.unmount()
    renderHook(() => useAgentPrompt('p1', 'idle'))
    await tick()
    expect(mockFetchPrompt).toHaveBeenCalledTimes(1)
    await act(async () => resolve(null))
    await tick(0)
    expect(mockFetchPrompt).toHaveBeenCalledTimes(2)
  })
})
