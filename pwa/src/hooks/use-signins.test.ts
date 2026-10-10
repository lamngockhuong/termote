import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SignedInBrowser, SignedInBrowsers } from './use-mux-api'
import { useSignins } from './use-signins'

const mocks = vi.hoisted(() => ({
  fetchSignins: vi.fn(),
  revokeSignin: vi.fn(),
  revokeOtherSignins: vi.fn(),
}))

vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchSignins: (...a: unknown[]) => mocks.fetchSignins(...a),
  revokeSignin: (...a: unknown[]) => mocks.revokeSignin(...a),
  revokeOtherSignins: (...a: unknown[]) => mocks.revokeOtherSignins(...a),
}))

const { RequestError } = await import('./use-mux-api')

const browser = (id: string, current = false): SignedInBrowser => ({
  id,
  createdAt: '2026-10-01T00:00:00Z',
  lastUsedAt: '2026-10-02T00:00:00Z',
  expiresAt: '2026-10-03T00:00:00Z',
  via: 'form',
  ip: '192.0.2.9',
  userAgent: `Browser ${id}`,
  current,
})

const answer = (
  sessions: SignedInBrowser[],
  canRevoke = true,
): SignedInBrowsers => ({ sessions, canRevoke })

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useSignins', () => {
  it('reads nothing while disabled', () => {
    const { result } = renderHook(() => useSignins(false))
    expect(mocks.fetchSignins).not.toHaveBeenCalled()
    expect(result.current.sessions).toBeNull()
    expect(result.current.canRevoke).toBe(false)
  })

  it('reads the list and whether this client signs browsers out', async () => {
    mocks.fetchSignins.mockResolvedValue(answer([browser('a', true)], true))
    const { result } = renderHook(() => useSignins(true))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.canRevoke).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('says why a read failed, and clears it on the next one that works', async () => {
    mocks.fetchSignins.mockRejectedValueOnce(new RequestError(500, '', 'x'))
    const { result } = renderHook(() => useSignins(true))
    await waitFor(() =>
      expect(result.current.error).toBe(
        'Could not read the signed-in browsers',
      ),
    )
    mocks.fetchSignins.mockResolvedValueOnce(answer([], false))
    await act(() => result.current.refresh())
    expect(result.current.error).toBeNull()
    expect(result.current.sessions).toEqual([])
  })

  it('lets only the latest read land, a late answer or failure included', async () => {
    let finishSlow!: (a: SignedInBrowsers) => void
    let failSlow!: (err: unknown) => void
    mocks.fetchSignins
      .mockImplementationOnce(
        () => new Promise<SignedInBrowsers>((r) => (finishSlow = r)),
      )
      .mockImplementationOnce(
        () => new Promise<SignedInBrowsers>((_, rej) => (failSlow = rej)),
      )
      .mockResolvedValueOnce(answer([browser('new')]))
    const { result } = renderHook(() => useSignins(true))
    await act(() => {
      void result.current.refresh()
      return result.current.refresh()
    })
    await act(async () => finishSlow(answer([browser('old')])))
    await act(async () => failSlow(new Error('late')))
    expect(result.current.sessions!.map((s) => s.id)).toEqual(['new'])
    expect(result.current.error).toBeNull()
  })

  it('removes a signed-out browser at once and reads the list again', async () => {
    mocks.fetchSignins.mockResolvedValueOnce(
      answer([browser('a', true), browser('b')]),
    )
    mocks.revokeSignin.mockResolvedValue(undefined)
    const { result } = renderHook(() => useSignins(true))
    await waitFor(() => expect(result.current.sessions).toHaveLength(2))
    // The read after the sign-out has not answered yet
    mocks.fetchSignins.mockReturnValue(new Promise(() => {}))
    await act(() => result.current.revoke('b'))
    expect(mocks.revokeSignin).toHaveBeenCalledWith('b')
    expect(mocks.fetchSignins).toHaveBeenCalledTimes(2)
    expect(result.current.sessions!.map((s) => s.id)).toEqual(['a'])
  })

  it('a browser signed out meanwhile is gone all the same', async () => {
    mocks.fetchSignins.mockResolvedValueOnce(answer([browser('a')]))
    mocks.revokeSignin.mockRejectedValue(
      new RequestError(404, 'unknown_session', 'x'),
    )
    const { result } = renderHook(() => useSignins(true))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    mocks.fetchSignins.mockResolvedValueOnce(answer([]))
    await act(() => result.current.revoke('a'))
    expect(result.current.sessions).toEqual([])
  })

  it('a sign-out refused for another reason throws and keeps the list', async () => {
    mocks.fetchSignins.mockResolvedValueOnce(answer([browser('a')]))
    const refused = new RequestError(403, 'full_needs_password', 'x')
    mocks.revokeSignin.mockRejectedValue(refused)
    const { result } = renderHook(() => useSignins(true))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    await expect(result.current.revoke('a')).rejects.toBe(refused)
    expect(result.current.sessions!.map((s) => s.id)).toEqual(['a'])
  })

  it('signing the others out keeps only this browser, and says how many went', async () => {
    mocks.fetchSignins.mockResolvedValueOnce(
      answer([browser('a'), browser('me', true), browser('c')]),
    )
    mocks.revokeOtherSignins.mockResolvedValue(2)
    const { result } = renderHook(() => useSignins(true))
    await waitFor(() => expect(result.current.sessions).toHaveLength(3))
    mocks.fetchSignins.mockReturnValue(new Promise(() => {}))
    let n = 0
    await act(async () => {
      n = await result.current.revokeOthers()
    })
    expect(n).toBe(2)
    expect(result.current.sessions!.map((s) => s.id)).toEqual(['me'])
  })

  it('a sign-out before the first read leaves the list unread', async () => {
    mocks.fetchSignins.mockReturnValue(new Promise(() => {}))
    mocks.revokeOtherSignins.mockResolvedValue(0)
    const { result } = renderHook(() => useSignins(false))
    await act(() => result.current.revoke('a'))
    await act(async () => {
      await result.current.revokeOthers()
    })
    expect(result.current.sessions).toBeNull()
  })
})
