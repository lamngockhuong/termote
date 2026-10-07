import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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
    const worker = stubWorker({ version: 1 })
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
})
