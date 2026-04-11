import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUpdateCheck } from './use-update-check'

const CACHE_KEY = 'termote-update-check'

function makeFetchResponse(data: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(data),
  } as Response)
}

describe('useUpdateCheck', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('starts with checking=false', () => {
    const { result } = renderHook(() => useUpdateCheck())
    expect(result.current.checking).toBe(false)
  })

  it('fetches from network when cache is empty (no force needed)', async () => {
    // Empty localStorage → getCachedResult returns null → fetches fresh
    vi.mocked(fetch).mockReturnValue(makeFetchResponse({ tag_name: 'v1.0.0', html_url: 'https://github.com' }))
    const { result } = renderHook(() => useUpdateCheck())
    await act(async () => { await result.current.checkForUpdate() })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('sets checking true while fetching, false after', async () => {
    vi.mocked(fetch).mockReturnValue(makeFetchResponse({ tag_name: 'v999.0.0', html_url: 'https://example.com' }))
    const { result } = renderHook(() => useUpdateCheck())
    let promise: Promise<unknown>
    act(() => {
      promise = result.current.checkForUpdate(true)
    })
    // checking becomes true during fetch
    expect(result.current.checking).toBe(true)
    await act(async () => { await promise })
    expect(result.current.checking).toBe(false)
  })

  it('returns hasUpdate=true when latest version is newer', async () => {
    vi.mocked(fetch).mockReturnValue(makeFetchResponse({ tag_name: 'v999.0.0', html_url: 'https://github.com/release' }))
    const { result } = renderHook(() => useUpdateCheck())
    let updateResult: Awaited<ReturnType<typeof result.current.checkForUpdate>>
    await act(async () => {
      updateResult = await result.current.checkForUpdate(true)
    })
    expect(updateResult!.hasUpdate).toBe(true)
    expect(updateResult!.latestVersion).toBe('999.0.0')
    expect(updateResult!.releaseUrl).toBe('https://github.com/release')
  })

  it('returns hasUpdate=false when versions are equal', async () => {
    vi.mocked(fetch).mockReturnValue(makeFetchResponse({ tag_name: 'v0.0.0', html_url: 'https://github.com/release' }))
    const { result } = renderHook(() => useUpdateCheck())
    let updateResult: Awaited<ReturnType<typeof result.current.checkForUpdate>>
    await act(async () => {
      updateResult = await result.current.checkForUpdate(true)
    })
    expect(updateResult!.hasUpdate).toBe(false)
  })

  it('returns hasUpdate=false when on newer version than latest', async () => {
    vi.mocked(fetch).mockReturnValue(makeFetchResponse({ tag_name: 'v0.0.0', html_url: 'https://github.com/release' }))
    const { result } = renderHook(() => useUpdateCheck())
    let updateResult: Awaited<ReturnType<typeof result.current.checkForUpdate>>
    await act(async () => {
      updateResult = await result.current.checkForUpdate(true)
    })
    expect(updateResult!.hasUpdate).toBe(false)
  })

  it('caches result and uses cache on second call', async () => {
    vi.mocked(fetch).mockReturnValue(makeFetchResponse({ tag_name: 'v999.0.0', html_url: 'https://github.com/release' }))
    const { result } = renderHook(() => useUpdateCheck())
    await act(async () => { await result.current.checkForUpdate(true) })
    // Second call — no force, should use cache
    await act(async () => { await result.current.checkForUpdate() })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('bypasses cache when force=true', async () => {
    vi.mocked(fetch).mockReturnValue(makeFetchResponse({ tag_name: 'v999.0.0', html_url: 'https://github.com/release' }))
    const { result } = renderHook(() => useUpdateCheck())
    await act(async () => { await result.current.checkForUpdate(true) })
    await act(async () => { await result.current.checkForUpdate(true) })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('returns cached result when cache is fresh', async () => {
    const cached = {
      hasUpdate: true,
      latestVersion: '5.0.0',
      releaseUrl: 'https://cached.url',
      checkedAt: Date.now(),
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cached))
    const { result } = renderHook(() => useUpdateCheck())
    let updateResult: Awaited<ReturnType<typeof result.current.checkForUpdate>>
    await act(async () => {
      updateResult = await result.current.checkForUpdate()
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(updateResult!.hasUpdate).toBe(true)
    expect(updateResult!.latestVersion).toBe('5.0.0')
  })

  it('ignores expired cache and fetches fresh', async () => {
    const expired = {
      hasUpdate: false,
      latestVersion: '1.0.0',
      releaseUrl: 'https://old.url',
      checkedAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(expired))
    vi.mocked(fetch).mockReturnValue(makeFetchResponse({ tag_name: 'v999.0.0', html_url: 'https://new.url' }))
    const { result } = renderHook(() => useUpdateCheck())
    await act(async () => { await result.current.checkForUpdate() })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('handles corrupt cache gracefully', async () => {
    localStorage.setItem(CACHE_KEY, 'not-json')
    vi.mocked(fetch).mockReturnValue(makeFetchResponse({ tag_name: 'v999.0.0', html_url: 'https://github.com' }))
    const { result } = renderHook(() => useUpdateCheck())
    let updateResult: Awaited<ReturnType<typeof result.current.checkForUpdate>>
    await act(async () => {
      updateResult = await result.current.checkForUpdate()
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(updateResult!.hasUpdate).toBe(true)
  })

  it('returns null result on fetch error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'))
    const { result } = renderHook(() => useUpdateCheck())
    let updateResult: Awaited<ReturnType<typeof result.current.checkForUpdate>>
    await act(async () => {
      updateResult = await result.current.checkForUpdate(true)
    })
    expect(updateResult!.hasUpdate).toBe(false)
    expect(updateResult!.latestVersion).toBeNull()
    expect(updateResult!.releaseUrl).toBeNull()
  })

  it('returns null result on non-ok response', async () => {
    vi.mocked(fetch).mockReturnValue(makeFetchResponse({}, false, 403))
    const { result } = renderHook(() => useUpdateCheck())
    let updateResult: Awaited<ReturnType<typeof result.current.checkForUpdate>>
    await act(async () => {
      updateResult = await result.current.checkForUpdate(true)
    })
    expect(updateResult!.hasUpdate).toBe(false)
    expect(updateResult!.latestVersion).toBeNull()
  })

  it('checking returns to false even after error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('fail'))
    const { result } = renderHook(() => useUpdateCheck())
    await act(async () => { await result.current.checkForUpdate(true) })
    expect(result.current.checking).toBe(false)
  })

  it('strips leading v from latestVersion', async () => {
    vi.mocked(fetch).mockReturnValue(makeFetchResponse({ tag_name: 'v2.3.4', html_url: 'https://github.com' }))
    const { result } = renderHook(() => useUpdateCheck())
    let updateResult: Awaited<ReturnType<typeof result.current.checkForUpdate>>
    await act(async () => {
      updateResult = await result.current.checkForUpdate(true)
    })
    expect(updateResult!.latestVersion).toBe('2.3.4')
  })
})
