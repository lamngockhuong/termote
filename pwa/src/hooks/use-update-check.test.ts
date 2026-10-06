import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compareVersions,
  newestStable,
  useUpdateCheck,
} from './use-update-check'

const CACHE_KEY = 'termote-update-check'

function release(tag: string, extra: Record<string, unknown> = {}) {
  return { tag_name: tag, html_url: `https://example.com/${tag}`, ...extra }
}

function respond(data: unknown, ok = true, status = 200) {
  vi.mocked(fetch).mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(data),
  } as Response)
}

describe('compareVersions', () => {
  it('orders by major, minor and patch', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0)
  })

  it('puts a pre-release before its version', () => {
    expect(compareVersions('1.14.0-rc.1', '1.14.0')).toBe(-1)
    expect(compareVersions('1.14.0', '1.14.0-rc.1')).toBe(1)
    expect(compareVersions('1.14.0-rc.1', '1.13.0')).toBe(1)
    expect(compareVersions('1.14.0-rc.1', '1.14.0-rc.2')).toBe(0)
  })
})

describe('newestStable', () => {
  // The rule of server/release_tags.go: `termote update` installs the same.
  it('takes the highest stable 1.x, skipping 0.x, pre-releases and drafts', () => {
    const best = newestStable([
      release('v0.9.9'),
      release('v1.13.0'),
      release('v1.15.0-rc.1'),
      release('v1.14.0', { prerelease: true }),
      release('v1.16.0', { draft: true }),
      release('v1.12.3'),
      release('nightly'),
    ])
    expect(best?.tag_name).toBe('v1.13.0')
  })

  it('is null without a stable release', () => {
    expect(newestStable([release('v0.5.0'), release('v1.0.0-rc.1')])).toBe(null)
  })
})

describe('useUpdateCheck', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('reads the releases list and keeps the newest stable one', async () => {
    respond([release('v1.14.0'), release('v1.15.0-rc.1'), release('v1.13.0')])
    const { result } = renderHook(() => useUpdateCheck())
    await act(() => result.current.check())
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/releases?per_page=')
    expect(result.current.latest).toMatchObject({
      version: '1.14.0',
      url: 'https://example.com/v1.14.0',
    })
    expect(result.current.failed).toBe(false)
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).version).toBe('1.14.0')
  })

  it('uses a result younger than an hour without asking GitHub', async () => {
    const kept = { version: '1.14.0', url: 'u', checkedAt: Date.now() }
    localStorage.setItem(CACHE_KEY, JSON.stringify(kept))
    const { result } = renderHook(() => useUpdateCheck())
    // Shown at once, before any check
    expect(result.current.latest).toEqual(kept)
    await act(() => result.current.check())
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks again past an hour, or when forced', async () => {
    respond([release('v1.15.0')])
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ version: '1.14.0', url: 'u', checkedAt: 0 }),
    )
    const { result } = renderHook(() => useUpdateCheck())
    expect(result.current.latest).toBe(null)
    await act(() => result.current.check())
    expect(result.current.latest?.version).toBe('1.15.0')

    await act(() => result.current.check(true))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  // What an older app kept: { latestVersion, releaseUrl, checkedAt }
  it('ignores a result kept in the old shape', async () => {
    respond([release('v1.14.0')])
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        latestVersion: '1.13.0',
        releaseUrl: 'u',
        checkedAt: Date.now(),
      }),
    )
    const { result } = renderHook(() => useUpdateCheck())
    expect(result.current.latest).toBe(null)
    await act(() => result.current.check())
    expect(result.current.latest?.version).toBe('1.14.0')
  })

  it('ignores a kept result that is not JSON', () => {
    localStorage.setItem(CACHE_KEY, '{')
    const { result } = renderHook(() => useUpdateCheck())
    expect(result.current.latest).toBe(null)
  })

  it('fails on an error reply and keeps the last result', async () => {
    respond([release('v1.14.0')])
    const { result } = renderHook(() => useUpdateCheck())
    await act(() => result.current.check())
    respond({ message: 'rate limited' }, false, 403)
    await act(() => result.current.check(true))
    expect(result.current.failed).toBe(true)
    expect(result.current.latest?.version).toBe('1.14.0')
    expect(result.current.checking).toBe(false)
  })

  it('fails when the network does or no stable release exists', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useUpdateCheck())
    await act(() => result.current.check())
    expect(result.current.failed).toBe(true)

    respond([release('v0.9.0')])
    await act(() => result.current.check(true))
    expect(result.current.failed).toBe(true)
    expect(result.current.latest).toBe(null)
  })

  it('still reports the result when storage cannot keep it', async () => {
    respond([release('v1.14.0')])
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota')
      })
    const { result } = renderHook(() => useUpdateCheck())
    await act(() => result.current.check())
    expect(result.current.latest?.version).toBe('1.14.0')
    spy.mockRestore()
  })
})
