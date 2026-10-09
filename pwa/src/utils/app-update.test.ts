import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  API_RELOAD_KEY,
  checkOnShow,
  checkServerVersion,
  markStale,
  onChunkLoadError,
  RELOAD_SETTLE_MS,
  reloadToNewVersion,
  resetAppUpdate,
  SHOW_CHECK_GAP_MS,
  SW_ACTIVATE_TIMEOUT_MS,
  useAppUpdate,
  VERSION_RELOAD_KEY,
} from './app-update'

const mockFetchHealth = vi.fn()
const mockReload = vi.fn()

vi.mock('../hooks/use-mux-api', () => ({
  fetchHealth: () => mockFetchHealth(),
  MUX_API_VERSION: 1,
}))

// A fixed page version, so the comparisons do not change with each release
vi.mock('./app-info', () => ({ APP_INFO: { version: '1.13.0' } }))

function setServiceWorker(value: unknown) {
  Object.defineProperty(navigator, 'serviceWorker', {
    value,
    writable: true,
    configurable: true,
  })
}

// A stand-in EventTarget whose listeners the test fires.
function target<T extends object>(props: T) {
  const listeners = new Set<() => void>()
  return {
    ...props,
    addEventListener: vi.fn((_: string, cb: () => void) => listeners.add(cb)),
    removeEventListener: vi.fn((_: string, cb: () => void) =>
      listeners.delete(cb),
    ),
    fire: () => {
      for (const cb of [...listeners]) cb()
    },
  }
}

describe('app-update', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    resetAppUpdate()
    setServiceWorker(undefined)
    mockFetchHealth.mockResolvedValue({
      apiVersion: 1,
      version: '1.13.0',
      install: 'release',
    })
  })

  describe('checkServerVersion', () => {
    it('records the server and stays current on the same version', async () => {
      const { result } = renderHook(() => useAppUpdate())
      await act(async () => {
        expect(await checkServerVersion(mockReload)).toBe(false)
      })
      expect(result.current).toEqual({
        server: { version: '1.13.0', install: 'release' },
        stale: false,
        reloading: false,
      })
      expect(mockReload).not.toHaveBeenCalled()
    })

    // A release that keeps /api/mux: no reload on its own, an unsaved edit
    // would be lost; the banner offers it.
    it('marks the page stale when the server runs another release', async () => {
      mockFetchHealth.mockResolvedValue({ apiVersion: 1, version: '1.14.0' })
      const { result } = renderHook(() => useAppUpdate())
      await act(async () => {
        expect(await checkServerVersion(mockReload)).toBe(false)
      })
      expect(result.current).toEqual({
        server: { version: '1.14.0', install: 'unknown' },
        stale: true,
        reloading: false,
      })
      expect(mockReload).not.toHaveBeenCalled()
    })

    // A build made by hand keeps its page version after the reload.
    it('does not offer the reload again for a version it reloaded for', async () => {
      sessionStorage.setItem(VERSION_RELOAD_KEY, '1.14.0')
      mockFetchHealth.mockResolvedValue({ apiVersion: 1, version: '1.14.0' })
      const { result } = renderHook(() => useAppUpdate())
      await act(() => checkServerVersion(mockReload))
      expect(result.current.stale).toBe(false)
    })

    it('leaves the state alone for a server that reports no version', async () => {
      mockFetchHealth.mockResolvedValue({ apiVersion: 1 })
      const { result } = renderHook(() => useAppUpdate())
      await act(() => checkServerVersion(mockReload))
      expect(result.current).toEqual({
        server: null,
        stale: false,
        reloading: false,
      })
    })

    it('does nothing when the health read fails', async () => {
      mockFetchHealth.mockRejectedValue(new Error('fetch failed'))
      expect(await checkServerVersion(mockReload)).toBe(false)
      expect(mockReload).not.toHaveBeenCalled()
    })

    it('reloads at once for another /api/mux version, once per version', async () => {
      mockFetchHealth.mockResolvedValue({ apiVersion: 2, version: '2.0.0' })
      expect(await checkServerVersion(mockReload)).toBe(true)
      expect(mockReload).toHaveBeenCalledTimes(1)
      expect(sessionStorage.getItem(API_RELOAD_KEY)).toBe('2')

      expect(await checkServerVersion(mockReload)).toBe(false)
      expect(mockReload).toHaveBeenCalledTimes(1)
    })

    it('reloads even when storage is unavailable', async () => {
      const spy = vi
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation(() => {
          throw new Error('storage error')
        })
      const set = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new Error('storage error')
        })
      mockFetchHealth.mockResolvedValue({ apiVersion: 2 })
      expect(await checkServerVersion(mockReload)).toBe(true)
      expect(mockReload).toHaveBeenCalled()
      spy.mockRestore()
      set.mockRestore()
    })
  })

  it('markStale shows the banner for a waiting service worker', () => {
    const { result } = renderHook(() => useAppUpdate())
    act(() => markStale())
    expect(result.current.stale).toBe(true)
  })

  // An update that rolled back: the server runs this page's version again.
  it('clears a version banner when the server comes back to this version', async () => {
    mockFetchHealth.mockResolvedValue({ apiVersion: 1, version: '1.14.0' })
    const { result } = renderHook(() => useAppUpdate())
    await act(() => checkServerVersion(mockReload))
    expect(result.current.stale).toBe(true)
    mockFetchHealth.mockResolvedValue({ apiVersion: 1, version: '1.13.0' })
    await act(() => checkServerVersion(mockReload))
    expect(result.current.stale).toBe(false)
  })

  it('keeps the banner of a waiting worker whatever the server says', async () => {
    const { result } = renderHook(() => useAppUpdate())
    act(() => markStale())
    await act(() => checkServerVersion(mockReload))
    expect(result.current.stale).toBe(true)
  })

  describe('checkOnShow', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('reads the health at most once in the gap', async () => {
      checkOnShow()
      checkOnShow()
      expect(mockFetchHealth).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(SHOW_CHECK_GAP_MS)
      checkOnShow()
      expect(mockFetchHealth).toHaveBeenCalledTimes(2)
    })

    it('waits the gap after a check made for another reason', async () => {
      await checkServerVersion(mockReload)
      checkOnShow()
      expect(mockFetchHealth).toHaveBeenCalledTimes(1)
    })
  })

  describe('reloadToNewVersion', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('reloads at once without a service worker', async () => {
      await reloadToNewVersion(mockReload)
      expect(mockReload).toHaveBeenCalledTimes(1)
    })

    it('reports reloading while it waits, and ignores a second click', async () => {
      const worker = target({ state: 'installed', postMessage: vi.fn() })
      const sw = target({
        getRegistration: vi.fn().mockResolvedValue({
          update: vi.fn().mockResolvedValue(undefined),
          waiting: worker,
        }),
      })
      setServiceWorker(sw)
      const { result } = renderHook(() => useAppUpdate())
      let done: Promise<void> = Promise.resolve()
      act(() => {
        done = reloadToNewVersion(mockReload)
      })
      expect(result.current.reloading).toBe(true)
      await reloadToNewVersion(mockReload)
      expect(sw.getRegistration).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled())
      await act(async () => {
        sw.fire()
        await done
      })
      expect(mockReload).toHaveBeenCalledTimes(1)
      // The navigation may still be on its way
      expect(result.current.reloading).toBe(true)
      // Still on the page: a "Leave page?" was answered no
      act(() => vi.advanceTimersByTime(RELOAD_SETTLE_MS))
      expect(result.current.reloading).toBe(false)
    })

    it('still lets a waiting worker take over when update() fails', async () => {
      const worker = target({ state: 'installed', postMessage: vi.fn() })
      const sw = target({
        getRegistration: vi.fn().mockResolvedValue({
          update: vi.fn().mockRejectedValue(new Error('offline')),
          waiting: worker,
        }),
      })
      setServiceWorker(sw)
      const done = reloadToNewVersion(mockReload)
      await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled())
      sw.fire()
      await done
      expect(mockReload).toHaveBeenCalledTimes(1)
    })

    it('does not wait on a worker that failed to install', async () => {
      const worker = target({ state: 'installing', postMessage: vi.fn() })
      const sw = target({
        getRegistration: vi.fn().mockResolvedValue({
          update: vi.fn().mockResolvedValue(undefined),
          installing: worker,
        }),
      })
      setServiceWorker(sw)
      const done = reloadToNewVersion(mockReload)
      await vi.waitFor(() => expect(worker.addEventListener).toHaveBeenCalled())
      worker.state = 'redundant'
      worker.fire()
      await done
      expect(worker.postMessage).not.toHaveBeenCalled()
      expect(mockReload).toHaveBeenCalledTimes(1)
    })

    it('remembers the server version it reloads for', async () => {
      mockFetchHealth.mockResolvedValue({ apiVersion: 1, version: '1.14.0' })
      await checkServerVersion(mockReload)
      await reloadToNewVersion(mockReload)
      expect(sessionStorage.getItem(VERSION_RELOAD_KEY)).toBe('1.14.0')
    })

    it('reloads at once when no new worker was found', async () => {
      const sw = target({
        getRegistration: vi
          .fn()
          .mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) }),
      })
      setServiceWorker(sw)
      await reloadToNewVersion(mockReload)
      expect(sw.addEventListener).not.toHaveBeenCalled()
      expect(mockReload).toHaveBeenCalledTimes(1)
    })

    // The worker waits in prompt mode: it must be told to skip waiting, or
    // the reload gets the old page from the old worker.
    it('lets a waiting worker take over, then reloads', async () => {
      const worker = target({ state: 'installed', postMessage: vi.fn() })
      const sw = target({
        getRegistration: vi.fn().mockResolvedValue({
          update: vi.fn().mockResolvedValue(undefined),
          waiting: worker,
        }),
      })
      setServiceWorker(sw)
      const done = reloadToNewVersion(mockReload)
      await vi.waitFor(() =>
        expect(worker.postMessage).toHaveBeenCalledWith({
          type: 'SKIP_WAITING',
        }),
      )
      expect(mockReload).not.toHaveBeenCalled()
      sw.fire()
      await done
      expect(mockReload).toHaveBeenCalledTimes(1)
      expect(sw.removeEventListener).toHaveBeenCalled()
    })

    it('waits for an installing worker to finish before skipping waiting', async () => {
      const worker = target({ state: 'installing', postMessage: vi.fn() })
      const sw = target({
        getRegistration: vi.fn().mockResolvedValue({
          update: vi.fn().mockResolvedValue(undefined),
          installing: worker,
        }),
      })
      setServiceWorker(sw)
      const done = reloadToNewVersion(mockReload)
      await vi.waitFor(() => expect(worker.addEventListener).toHaveBeenCalled())
      // Still installing: a state change that is not the end is ignored
      worker.fire()
      expect(worker.postMessage).not.toHaveBeenCalled()
      worker.state = 'installed'
      worker.fire()
      await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled())
      sw.fire()
      await done
      expect(mockReload).toHaveBeenCalledTimes(1)
    })

    // iOS: the worker told to skip waiting may never take control, and the
    // old one would serve the old page again.
    it('drops the service worker when the new one never takes control', async () => {
      const worker = target({ state: 'installing', postMessage: vi.fn() })
      const unregister = vi.fn().mockResolvedValue(true)
      const sw = target({
        getRegistration: vi.fn().mockResolvedValue({
          update: vi.fn().mockResolvedValue(undefined),
          installing: worker,
          unregister,
        }),
      })
      setServiceWorker(sw)
      const keys = vi
        .fn()
        .mockResolvedValue(['workbox-precache-v2-http://h/', 'shiki'])
      const del = vi.fn().mockResolvedValue(true)
      vi.stubGlobal('caches', { keys, delete: del })
      const done = reloadToNewVersion(mockReload)
      await vi.advanceTimersByTimeAsync(SW_ACTIVATE_TIMEOUT_MS * 2)
      await done
      vi.unstubAllGlobals()
      expect(worker.postMessage).toHaveBeenCalled()
      expect(unregister).toHaveBeenCalledTimes(1)
      // The highlighter's cache holds hashed files only: kept
      expect(del).toHaveBeenCalledTimes(1)
      expect(del).toHaveBeenCalledWith('workbox-precache-v2-http://h/')
      expect(mockReload).toHaveBeenCalledTimes(1)
    })

    it('still reloads when the worker cannot be dropped', async () => {
      const worker = target({ state: 'installed', postMessage: vi.fn() })
      const sw = target({
        getRegistration: vi.fn().mockResolvedValue({
          update: vi.fn().mockResolvedValue(undefined),
          waiting: worker,
          unregister: vi.fn().mockRejectedValue(new Error('denied')),
        }),
      })
      setServiceWorker(sw)
      // No Cache API (jsdom has none)
      const done = reloadToNewVersion(mockReload)
      await vi.advanceTimersByTimeAsync(SW_ACTIVATE_TIMEOUT_MS)
      await done
      expect(mockReload).toHaveBeenCalledTimes(1)
    })

    it('reloads into the new version when a chunk of this page is gone', async () => {
      const location = vi
        .spyOn(window, 'location', 'get')
        .mockReturnValue({ reload: mockReload } as unknown as Location)
      const { result } = renderHook(() => useAppUpdate())
      act(() => onChunkLoadError())
      expect(result.current.stale).toBe(true)
      await vi.waitFor(() => expect(mockReload).toHaveBeenCalledTimes(1))
      location.mockRestore()
    })

    it('reloads when the service worker throws', async () => {
      setServiceWorker({
        getRegistration: vi.fn().mockRejectedValue(new Error('denied')),
      })
      await reloadToNewVersion(mockReload)
      expect(mockReload).toHaveBeenCalledTimes(1)
    })
  })
})
