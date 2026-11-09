import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsProposal, SettingsProposalRef } from './use-mux-api'
import {
  markProposalSeen,
  PROPOSAL_RETRY_MS,
  PROPOSAL_SEEN_KEY,
  proposalExpired,
  useSettingsProposal,
} from './use-settings-proposal'

const api = vi.hoisted(() => ({
  fetchSettingsProposal: vi.fn<() => Promise<SettingsProposal | null>>(),
}))
vi.mock('./use-mux-api', () => api)

const NOW = Date.parse('2026-11-09T12:00:00Z')
const later = (ms: number) => new Date(NOW + ms).toISOString()

function proposal(id: string, ms = 60_000): SettingsProposal {
  return { id, expiresAt: later(ms), values: { editorVim: true } }
}

function render(
  ref: SettingsProposalRef | undefined,
  enabled = true,
  offset = 0,
) {
  return renderHook(
    (p: { ref?: SettingsProposalRef; enabled: boolean; offset: number }) =>
      useSettingsProposal(p.ref, p.enabled, p.offset),
    { initialProps: { ref, enabled, offset } },
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW })
  api.fetchSettingsProposal.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSettingsProposal', () => {
  it('reads the proposal the snapshot names, once', async () => {
    const p = proposal('a')
    api.fetchSettingsProposal.mockResolvedValue(p)
    const { result, rerender } = render(p)
    await waitFor(() => expect(result.current.proposal).toEqual(p))
    expect(result.current.latestId).toBe('a')
    rerender({ ref: { ...p }, enabled: true, offset: 0 })
    expect(api.fetchSettingsProposal).toHaveBeenCalledTimes(1)
  })

  it('reads nothing while disabled, on a machine, or without a proposal', () => {
    render(proposal('a'), false)
    render(undefined)
    expect(api.fetchSettingsProposal).not.toHaveBeenCalled()
  })

  it('hides one applied or dismissed here, in every tab', async () => {
    const p = proposal('a')
    api.fetchSettingsProposal.mockResolvedValue(p)
    const { result } = render(p)
    await waitFor(() => expect(result.current.proposal).not.toBeNull())
    act(() => result.current.markSeen('a'))
    expect(result.current.proposal).toBeNull()
    expect(JSON.parse(localStorage.getItem(PROPOSAL_SEEN_KEY) ?? '[]')).toEqual(
      ['a'],
    )
    // Another tab dismissed the next one
    const q = proposal('b')
    api.fetchSettingsProposal.mockResolvedValue(q)
    const other = render(q)
    await waitFor(() => expect(other.result.current.proposal).toEqual(q))
    localStorage.setItem(PROPOSAL_SEEN_KEY, JSON.stringify(['a', 'b']))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
    })
    expect(other.result.current.proposal).toEqual(q)
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: PROPOSAL_SEEN_KEY }),
      )
    })
    expect(other.result.current.proposal).toBeNull()
  })

  it('hides it when its time is up, on the server clock', async () => {
    const p = proposal('a', 10_000)
    api.fetchSettingsProposal.mockResolvedValue(p)
    const { result, rerender } = render(p)
    await waitFor(() => expect(result.current.proposal).not.toBeNull())
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(result.current.proposal).toBeNull()
    // A server clock 20 s ahead: expired already
    const q = proposal('b', 10_000)
    api.fetchSettingsProposal.mockResolvedValue(q)
    rerender({ ref: q, enabled: true, offset: 20_000 })
    expect(result.current.proposal).toBeNull()
  })

  it('waits for the snapshot when the server holds a newer one, or none', async () => {
    api.fetchSettingsProposal.mockResolvedValue(proposal('newer'))
    const { result } = render(proposal('a'))
    await waitFor(() => expect(api.fetchSettingsProposal).toHaveBeenCalled())
    expect(result.current.proposal).toBeNull()
    // It reads once more (the answer named another), then stops
    await waitFor(() =>
      expect(api.fetchSettingsProposal).toHaveBeenCalledTimes(2),
    )
    api.fetchSettingsProposal.mockClear()
    api.fetchSettingsProposal.mockResolvedValue(null)
    const none = render(proposal('c'))
    await waitFor(() =>
      expect(api.fetchSettingsProposal).toHaveBeenCalledTimes(1),
    )
    expect(none.result.current.proposal).toBeNull()
  })

  it('reads again a while after a failed read', async () => {
    const p = proposal('a')
    api.fetchSettingsProposal.mockRejectedValueOnce(new Error('offline'))
    api.fetchSettingsProposal.mockResolvedValue(p)
    const { result } = render(p)
    await waitFor(() =>
      expect(api.fetchSettingsProposal).toHaveBeenCalledTimes(1),
    )
    expect(result.current.proposal).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(PROPOSAL_RETRY_MS)
    })
    await waitFor(() => expect(result.current.proposal).toEqual(p))
    expect(api.fetchSettingsProposal).toHaveBeenCalledTimes(2)
  })

  it('stops retrying once it no longer wants the proposal', async () => {
    api.fetchSettingsProposal.mockRejectedValue(new Error('offline'))
    const { unmount } = render(proposal('a'))
    await waitFor(() =>
      expect(api.fetchSettingsProposal).toHaveBeenCalledTimes(1),
    )
    unmount()
    act(() => {
      vi.advanceTimersByTime(PROPOSAL_RETRY_MS * 2)
    })
    expect(api.fetchSettingsProposal).toHaveBeenCalledTimes(1)
  })

  it('drops a failed read that arrives after it stopped wanting it', async () => {
    let reject: (e: Error) => void = () => {}
    api.fetchSettingsProposal.mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r
      }),
    )
    const { rerender } = render(proposal('a'))
    rerender({ ref: undefined, enabled: true, offset: 0 })
    await act(async () => reject(new Error('offline')))
    act(() => {
      vi.advanceTimersByTime(PROPOSAL_RETRY_MS)
    })
    expect(api.fetchSettingsProposal).toHaveBeenCalledTimes(1)
  })

  it('drops an answer that arrives after it stopped wanting it', async () => {
    let resolve: (p: SettingsProposal) => void = () => {}
    api.fetchSettingsProposal.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const { result, rerender } = render(proposal('a'))
    rerender({ ref: undefined, enabled: true, offset: 0 })
    await act(async () => resolve(proposal('a')))
    expect(result.current.proposal).toBeNull()
  })
})

describe('markProposalSeen', () => {
  it('keeps the last ten, each once', () => {
    for (let i = 0; i < 12; i++) markProposalSeen(`p${i}`)
    markProposalSeen('p11')
    const seen = JSON.parse(localStorage.getItem(PROPOSAL_SEEN_KEY) ?? '[]')
    expect(seen).toHaveLength(10)
    expect(seen[0]).toBe('p2')
    expect(seen.at(-1)).toBe('p11')
  })

  it('reads anything odd as nothing seen, and works with storage blocked', () => {
    localStorage.setItem(PROPOSAL_SEEN_KEY, '{')
    markProposalSeen('a')
    expect(localStorage.getItem(PROPOSAL_SEEN_KEY)).toBe('["a"]')
    localStorage.setItem(PROPOSAL_SEEN_KEY, '{"a":1}')
    markProposalSeen('b')
    expect(localStorage.getItem(PROPOSAL_SEEN_KEY)).toBe('["b"]')
    localStorage.setItem(PROPOSAL_SEEN_KEY, '[1,"c"]')
    markProposalSeen('d')
    expect(localStorage.getItem(PROPOSAL_SEEN_KEY)).toBe('["c","d"]')
    const get = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('blocked')
      })
    const set = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked')
      })
    try {
      expect(() => markProposalSeen('e')).not.toThrow()
    } finally {
      get.mockRestore()
      set.mockRestore()
    }
  })
})

describe('proposalExpired', () => {
  it('compares on the server clock; an unreadable time is expired', () => {
    expect(proposalExpired(later(1000), 0, NOW)).toBe(false)
    expect(proposalExpired(later(1000), 1000, NOW)).toBe(true)
    expect(proposalExpired('soon', 0, NOW)).toBe(true)
  })
})
