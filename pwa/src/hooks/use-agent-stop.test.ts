import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STOP_HOLD_MS, useAgentStop } from './use-agent-stop'
import { AgentRequestError } from './use-mux-api'

const mockInterrupt = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  interruptAgent: (...a: unknown[]) => mockInterrupt(...a),
}))

type Props = { pane: string; status?: string; since?: string }
const hook = (initial: Props) =>
  renderHook((p: Props) => useAgentStop(p.pane, p.status, p.since), {
    initialProps: initial,
  })

beforeEach(() => {
  mockInterrupt.mockReset()
  mockInterrupt.mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

describe('useAgentStop', () => {
  it('stops the session named, stopping until the status changes', async () => {
    const { result, rerender } = hook({
      pane: '%1',
      status: 'working',
      since: 'a',
    })
    expect(result.current.stopping).toBe(false)
    let err: unknown = 'unset'
    await act(async () => {
      err = await result.current.stop('cur1')
    })
    expect(err).toBeNull()
    expect(mockInterrupt).toHaveBeenCalledWith('%1', 'cur1')
    // A 204 is not the agent stopped: still stopping.
    expect(result.current.stopping).toBe(true)
    rerender({ pane: '%1', status: 'idle', since: 'b' })
    expect(result.current.stopping).toBe(false)
  })

  it('a status that began again also ends it', async () => {
    const { result, rerender } = hook({
      pane: '%1',
      status: 'working',
      since: 'a',
    })
    await act(async () => {
      await result.current.stop('cur1')
    })
    rerender({ pane: '%1', status: 'working', since: 'b' })
    expect(result.current.stopping).toBe(false)
  })

  it('stops showing as stopping after a while with no change', async () => {
    vi.useFakeTimers()
    const { result } = hook({ pane: '%1', status: 'working', since: 'a' })
    await act(async () => {
      await result.current.stop('cur1')
    })
    expect(result.current.stopping).toBe(true)
    act(() => vi.advanceTimersByTime(STOP_HOLD_MS))
    expect(result.current.stopping).toBe(false)
  })

  it('a refusal ends it and is returned', async () => {
    const refused = new AgentRequestError(409, 'agent_not_working', 'no')
    mockInterrupt.mockRejectedValueOnce(refused)
    const { result } = hook({ pane: '%1', status: 'working', since: 'a' })
    let err: unknown
    await act(async () => {
      err = await result.current.stop('cur1')
    })
    expect(err).toBe(refused)
    expect(result.current.stopping).toBe(false)
  })

  it('another pane shown: never stopping, its answer dropped', async () => {
    let reject: (e: unknown) => void = () => {}
    mockInterrupt.mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r
      }),
    )
    const { result, rerender } = hook({
      pane: '%1',
      status: 'working',
      since: 'a',
    })
    let pending: Promise<unknown> = Promise.resolve()
    act(() => {
      pending = result.current.stop('cur1')
    })
    expect(result.current.stopping).toBe(true)
    rerender({ pane: '%2', status: 'working', since: 'a' })
    expect(result.current.stopping).toBe(false)
    let err: unknown = 'unset'
    await act(async () => {
      reject(new Error('gone'))
      err = await pending
    })
    expect(err).toBeNull()
    expect(result.current.stopping).toBe(false)
  })
})
