import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { remapPanes } from '../utils/pane-remap'
import {
  COMMANDS_TTL,
  clearAgentCommandsCache,
  useAgentCommands,
} from './use-agent-commands'

const mockFetch = vi.fn()
vi.mock('./use-mux-api', () => ({
  fetchAgentCommands: (...a: unknown[]) => mockFetch(...a),
}))

const deploy = {
  name: 'deploy',
  source: 'project',
  kind: 'command',
} as const

beforeEach(() => {
  clearAgentCommandsCache()
  mockFetch.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('useAgentCommands', () => {
  it('reads nothing until enabled, then the pane list once', async () => {
    mockFetch.mockResolvedValue([deploy])
    const { result, rerender } = renderHook(
      ({ on }) => useAgentCommands('%1', on),
      { initialProps: { on: false } },
    )
    expect(mockFetch).not.toHaveBeenCalled()
    rerender({ on: true })
    await waitFor(() => expect(result.current).toEqual([deploy]))
    rerender({ on: false })
    rerender({ on: true })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith('%1')
  })

  it('reads again after the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    mockFetch.mockResolvedValue([deploy])
    const a = renderHook(() => useAgentCommands('%1', true))
    await waitFor(() => expect(a.result.current).toEqual([deploy]))
    a.unmount()
    vi.setSystemTime(Date.now() + COMMANDS_TTL + 1)
    const b = renderHook(() => useAgentCommands('%1', true))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    b.unmount()
  })

  it('a failed read is an empty list and is not kept', async () => {
    mockFetch.mockRejectedValueOnce(new Error('404'))
    const { result, unmount } = renderHook(() => useAgentCommands('%1', true))
    await act(async () => {})
    expect(result.current).toEqual([])
    unmount()
    mockFetch.mockResolvedValue([deploy])
    const again = renderHook(() => useAgentCommands('%1', true))
    await waitFor(() => expect(again.result.current).toEqual([deploy]))
  })

  it('never shows another pane list; no pane reads nothing', async () => {
    let resolve: (v: unknown) => void = () => {}
    mockFetch.mockResolvedValueOnce([deploy])
    const { result, rerender } = renderHook(
      ({ pane }) => useAgentCommands(pane, true),
      { initialProps: { pane: '%1' } },
    )
    await waitFor(() => expect(result.current).toEqual([deploy]))
    mockFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    rerender({ pane: '%2' })
    expect(result.current).toEqual([])
    // A reply that lands after the pane changed again is dropped.
    rerender({ pane: '' })
    await act(async () => resolve([{ ...deploy, name: 'late' }]))
    expect(result.current).toEqual([])
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('a failed read does not drop a newer one for the pane', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let fail: (e: Error) => void = () => {}
    mockFetch.mockReturnValueOnce(new Promise((_, r) => (fail = r)))
    const a = renderHook(() => useAgentCommands('%1', true))
    vi.setSystemTime(Date.now() + COMMANDS_TTL + 1)
    mockFetch.mockResolvedValueOnce([deploy])
    const b = renderHook(() => useAgentCommands('%1', true))
    await waitFor(() => expect(b.result.current).toEqual([deploy]))
    await act(async () => fail(new Error('gone')))
    expect(a.result.current).toEqual([])
    const c = renderHook(() => useAgentCommands('%1', true))
    await waitFor(() => expect(c.result.current).toEqual([deploy]))
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

describe('useAgentCommands and shifted ids', () => {
  it('a pane id that names another pane now reads its own list', async () => {
    mockFetch.mockResolvedValue([deploy])
    const a = renderHook(() => useAgentCommands('%1', true))
    await waitFor(() => expect(a.result.current).toEqual([deploy]))
    a.unmount()
    remapPanes({ moved: new Map(), stale: new Set(['%1']) })
    const b = renderHook(() => useAgentCommands('%1', true))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    b.unmount()
  })
})
