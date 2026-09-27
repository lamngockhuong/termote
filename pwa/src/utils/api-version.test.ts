import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  API_RELOAD_KEY,
  checkApiVersion,
  SW_ACTIVATE_TIMEOUT_MS,
} from './api-version'

const mockFetchHealth = vi.fn()
const mockReload = vi.fn()

vi.mock('../hooks/use-mux-api', () => ({
  fetchHealth: () => mockFetchHealth(),
  MUX_API_VERSION: 1,
}))

describe('api-version', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    mockFetchHealth.mockResolvedValue({ apiVersion: 1 })
  })

  it('returns false when server version matches client', async () => {
    const result = await checkApiVersion(mockReload)
    expect(result).toBe(false)
    expect(mockReload).not.toHaveBeenCalled()
  })

  it('returns false when server version is undefined', async () => {
    mockFetchHealth.mockResolvedValue({ apiVersion: undefined })
    const result = await checkApiVersion(mockReload)
    expect(result).toBe(false)
    expect(mockReload).not.toHaveBeenCalled()
  })

  it('returns false when fetchHealth throws', async () => {
    mockFetchHealth.mockRejectedValue(new Error('fetch failed'))
    const result = await checkApiVersion(mockReload)
    expect(result).toBe(false)
    expect(mockReload).not.toHaveBeenCalled()
  })

  it('calls reload when version mismatch detected', async () => {
    mockFetchHealth.mockResolvedValue({ apiVersion: 2 })
    const result = await checkApiVersion(mockReload)
    expect(result).toBe(true)
    expect(mockReload).toHaveBeenCalled()
  })

  it('stores reload key in sessionStorage on version mismatch', async () => {
    mockFetchHealth.mockResolvedValue({ apiVersion: 2 })
    await checkApiVersion(mockReload)
    expect(sessionStorage.getItem(API_RELOAD_KEY)).toBe('2')
  })

  it('skips reload if already reloaded for this version', async () => {
    sessionStorage.setItem(API_RELOAD_KEY, '2')
    mockFetchHealth.mockResolvedValue({ apiVersion: 2 })
    const result = await checkApiVersion(mockReload)
    expect(result).toBe(false)
    expect(mockReload).not.toHaveBeenCalled()
  })

  it('attempts to update service worker on reload', async () => {
    const mockUpdate = vi.fn()
    const mockGetRegistration = vi.fn().mockResolvedValue({
      update: mockUpdate,
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { getRegistration: mockGetRegistration },
      writable: true,
    })

    mockFetchHealth.mockResolvedValue({ apiVersion: 2 })
    await checkApiVersion(mockReload)

    expect(mockGetRegistration).toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('handles service worker unavailable gracefully', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: undefined,
      writable: true,
    })

    mockFetchHealth.mockResolvedValue({ apiVersion: 2 })
    const result = await checkApiVersion(mockReload)

    expect(result).toBe(true)
    expect(mockReload).toHaveBeenCalled()
  })

  it('continues reload even if sessionStorage fails', async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem')
    getItemSpy.mockImplementation(() => {
      throw new Error('storage error')
    })

    mockFetchHealth.mockResolvedValue({ apiVersion: 2 })
    const result = await checkApiVersion(mockReload)

    expect(result).toBe(true)
    expect(mockReload).toHaveBeenCalled()

    getItemSpy.mockRestore()
  })

  it('uses default reload function when not provided', async () => {
    mockFetchHealth.mockResolvedValue({ apiVersion: 2 })

    // Call checkApiVersion without providing a reload function
    // It should use window.location.reload by default
    const result = await checkApiVersion()

    // Should return true indicating a reload was triggered
    expect(result).toBe(true)
  })

  describe('with a new service worker installing', () => {
    function stubWorker(reg: Record<string, unknown>) {
      const listeners = new Set<() => void>()
      const sw = {
        getRegistration: vi.fn().mockResolvedValue(reg),
        addEventListener: vi.fn((_: string, cb: () => void) =>
          listeners.add(cb),
        ),
        removeEventListener: vi.fn((_: string, cb: () => void) =>
          listeners.delete(cb),
        ),
      }
      Object.defineProperty(navigator, 'serviceWorker', {
        value: sw,
        writable: true,
      })
      return {
        sw,
        fire: () => {
          for (const cb of [...listeners]) cb()
        },
      }
    }

    beforeEach(() => {
      vi.useFakeTimers()
      mockFetchHealth.mockResolvedValue({ apiVersion: 2 })
    })
    afterEach(() => vi.useRealTimers())

    it('reloads once the new worker takes control', async () => {
      const { sw, fire } = stubWorker({ update: vi.fn(), installing: {} })
      const done = checkApiVersion(mockReload)
      await vi.waitFor(() => expect(sw.addEventListener).toHaveBeenCalled())
      expect(mockReload).not.toHaveBeenCalled()
      fire()
      expect(await done).toBe(true)
      expect(mockReload).toHaveBeenCalledTimes(1)
      expect(sw.removeEventListener).toHaveBeenCalled()
    })

    it('reloads anyway when a waiting worker never takes control', async () => {
      const { sw } = stubWorker({ update: vi.fn(), waiting: {} })
      const done = checkApiVersion(mockReload)
      await vi.waitFor(() => expect(sw.addEventListener).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(SW_ACTIVATE_TIMEOUT_MS)
      expect(await done).toBe(true)
      expect(mockReload).toHaveBeenCalledTimes(1)
    })

    it('does not wait when no new worker was found', async () => {
      const { sw } = stubWorker({ update: vi.fn() })
      expect(await checkApiVersion(mockReload)).toBe(true)
      expect(sw.addEventListener).not.toHaveBeenCalled()
    })
  })
})
