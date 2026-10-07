import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  needsHomeScreenApp,
  notificationSupport,
  notifyWorkerReady,
  requestNotify,
} from './notify-permission'

// A service worker that answers the ping with `reply`, or never answers.
function stubWorker(reply?: unknown) {
  const active = {
    postMessage: vi.fn((_msg: unknown, ports: MessagePort[]) => {
      if (reply !== undefined) ports[0].postMessage(reply)
    }),
  }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn().mockResolvedValue({ active }) },
  })
  return active
}

describe('notify permission', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })

  it('is unsupported without Notification or a service worker', () => {
    vi.stubGlobal('Notification', undefined)
    expect(notificationSupport()).toBe('unsupported')
    vi.stubGlobal('Notification', { permission: 'granted' })
    expect(notificationSupport()).toBe('unsupported')
  })

  it('reports the permission', () => {
    stubWorker()
    vi.stubGlobal('Notification', { permission: 'denied' })
    expect(notificationSupport()).toBe('denied')
  })

  it('asks for the permission', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    vi.stubGlobal('Notification', { requestPermission })
    await expect(requestNotify()).resolves.toBe('granted')
  })

  it('is ready when the active worker answers the ping', async () => {
    const worker = stubWorker({ version: 2 })
    await expect(notifyWorkerReady()).resolves.toBe(true)
    expect(worker.postMessage).toHaveBeenCalledWith(
      { type: 'termote-notify-ping' },
      [expect.anything()],
    )
  })

  it('is not ready for another version', async () => {
    stubWorker({ version: 0 })
    await expect(notifyWorkerReady()).resolves.toBe(false)
    stubWorker(null)
    await expect(notifyWorkerReady()).resolves.toBe(false)
  })

  it('is not ready when the worker never answers', async () => {
    vi.useFakeTimers()
    stubWorker()
    const ready = notifyWorkerReady()
    await vi.advanceTimersByTimeAsync(500)
    await expect(ready).resolves.toBe(false)
  })

  it('is not ready without a worker', async () => {
    await expect(notifyWorkerReady()).resolves.toBe(false)
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockRejectedValue(new Error('x')) },
    })
    await expect(notifyWorkerReady()).resolves.toBe(false)
  })

  it('asks iOS browsers for the Home Screen app', () => {
    const nav = (userAgent: string, extra = {}) =>
      ({ userAgent, maxTouchPoints: 5, ...extra }) as unknown as Navigator
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    expect(needsHomeScreenApp(nav(iphone))).toBe(true)
    expect(needsHomeScreenApp(nav(ipad))).toBe(true)
    expect(needsHomeScreenApp(nav(ipad, { maxTouchPoints: 0 }))).toBe(false)
    expect(needsHomeScreenApp(nav(iphone, { standalone: true }))).toBe(false)
    expect(needsHomeScreenApp(nav('Mozilla/5.0 (X11; Linux x86_64)'))).toBe(
      false,
    )
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    )
    expect(needsHomeScreenApp(nav(iphone))).toBe(false)
    vi.stubGlobal('matchMedia', undefined)
    expect(needsHomeScreenApp(nav(iphone))).toBe(true)
    expect(needsHomeScreenApp()).toBe(false)
  })
})
