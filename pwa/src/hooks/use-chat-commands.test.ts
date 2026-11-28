import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_BUILTIN_COMMANDS } from '../utils/slash-commands'
import { clearAgentCommandsCache } from './use-agent-commands'
import { useChatCommands } from './use-chat-commands'

const mockFetch = vi.fn()
vi.mock('./use-mux-api', () => ({
  fetchAgentCommands: (...a: unknown[]) => mockFetch(...a),
}))

beforeEach(() => {
  clearAgentCommandsCache()
  mockFetch.mockReset()
})

describe('useChatCommands', () => {
  it("adds the pane's skills after the agent's trigger to its built-ins", async () => {
    mockFetch.mockResolvedValue([
      { name: 'review-pr', source: 'user', kind: 'skill' },
    ])
    const { result } = renderHook(() => useChatCommands('%1', 'codex'))
    await waitFor(() =>
      expect(result.current.at(-1)).toMatchObject({
        name: 'review-pr',
        trigger: '$',
      }),
    )
    expect(mockFetch).toHaveBeenCalledWith('%1')
    expect(result.current[0]).toMatchObject({ name: 'exit', source: 'builtin' })
  })

  it('reads no pane list without a pane or for an agent without input', () => {
    const history = renderHook(() => useChatCommands(undefined, 'claude'))
    expect(history.result.current).toEqual(CLAUDE_BUILTIN_COMMANDS)
    const shell = renderHook(() => useChatCommands('%1', 'bash'))
    expect(shell.result.current).toEqual([])
    const none = renderHook(() => useChatCommands('%1', undefined))
    expect(none.result.current).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('keeps the same list across renders while nothing changes', () => {
    const { result, rerender } = renderHook(() =>
      useChatCommands(undefined, 'claude'),
    )
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
