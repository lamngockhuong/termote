import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPAIR_EVERY_MS, usePushSubscription } from './use-push-subscription'

const sub = vi.hoisted(() => ({
  pushSupported: vi.fn(() => true),
  repairPushSubscription: vi.fn(),
  subscribeInGesture: vi.fn(),
  removePushSubscription: vi.fn(),
}))
vi.mock('../utils/push-subscription', () => sub)
const worker = vi.hoisted(() => ({ notifyWorkerReady: vi.fn() }))
vi.mock('../utils/notify-permission', () => worker)
const api = vi.hoisted(() => ({ getPushKey: vi.fn() }))
vi.mock('./use-mux-api', () => api)

const reg = { scope: '/' } as unknown as ServiceWorkerRegistration

// A promise and the function that settles it
function deferred<T>() {
  let resolve = (_: T) => {}
  let reject = (_: Error) => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('usePushSubscription', () => {
  beforeEach(() => {
    sub.pushSupported.mockReturnValue(true)
    sub.repairPushSubscription.mockReset().mockResolvedValue(true)
    sub.subscribeInGesture.mockReset().mockResolvedValue(true)
    sub.removePushSubscription.mockReset().mockResolvedValue(undefined)
    worker.notifyWorkerReady.mockReset().mockResolvedValue(true)
    api.getPushKey.mockReset().mockResolvedValue('KEY')
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(reg) },
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })

  function setup(available: boolean, enabled: boolean) {
    return renderHook((p) => usePushSubscription(p), {
      initialProps: { available, enabled },
    })
  }

  it('repairs on load and reports the confirmed subscription', async () => {
    const { result } = setup(true, true)
    await waitFor(() => expect(result.current.pushActive).toBe(true))
    expect(sub.repairPushSubscription).toHaveBeenCalledWith(reg, 'KEY')
  })

  it('never subscribes through a worker without the push handler', async () => {
    worker.notifyWorkerReady.mockResolvedValue(false)
    const { result } = setup(true, true)
    await act(async () => {})
    expect(sub.repairPushSubscription).not.toHaveBeenCalled()
    expect(result.current.pushActive).toBe(false)
    await expect(result.current.enable()).resolves.toBe(false)
    expect(sub.subscribeInGesture).not.toHaveBeenCalled()
  })

  it('is not active when the server refuses or the key cannot be read', async () => {
    sub.repairPushSubscription.mockResolvedValue(false)
    const { result } = setup(true, true)
    await waitFor(() => expect(sub.repairPushSubscription).toHaveBeenCalled())
    expect(result.current.pushActive).toBe(false)

    api.getPushKey.mockRejectedValue(new Error('503'))
    const other = setup(true, true)
    await act(async () => {})
    expect(other.result.current.pushActive).toBe(false)
  })

  it('does nothing without push or with the setting off', async () => {
    setup(false, true)
    setup(true, false)
    sub.pushSupported.mockReturnValue(false)
    setup(true, true)
    await act(async () => {})
    expect(sub.repairPushSubscription).not.toHaveBeenCalled()
  })

  // The settings row calls enable() and turns the setting on in the same
  // click: the repair that follows waits for the click's subscribe.
  it('keeps the click subscribe as the only one', async () => {
    const gesture = deferred<boolean>()
    sub.subscribeInGesture.mockReturnValue(gesture.promise)
    const { result, rerender } = setup(true, false)
    await act(async () => {})
    let enabled: Promise<boolean> = Promise.resolve(false)
    act(() => {
      enabled = result.current.enable()
      rerender({ available: true, enabled: true })
    })
    await act(async () => {})
    expect(sub.subscribeInGesture).toHaveBeenCalledWith(reg, 'KEY')
    expect(sub.repairPushSubscription).not.toHaveBeenCalled()
    await act(async () => gesture.resolve(true))
    await expect(enabled).resolves.toBe(true)
    await waitFor(() => expect(sub.repairPushSubscription).toHaveBeenCalled())
    expect(result.current.pushActive).toBe(true)
  })

  it('cannot subscribe before the key is read', async () => {
    api.getPushKey.mockReturnValue(new Promise(() => {}))
    const { result } = setup(true, false)
    await expect(result.current.enable()).resolves.toBe(false)
    expect(sub.subscribeInGesture).not.toHaveBeenCalled()
  })

  it('ignores a failed read ahead', async () => {
    api.getPushKey.mockRejectedValue(new Error('offline'))
    const { result } = setup(true, false)
    await act(async () => {})
    await expect(result.current.enable()).resolves.toBe(false)
  })

  it('ignores a stale answer', async () => {
    const repair = deferred<boolean>()
    sub.repairPushSubscription.mockReturnValue(repair.promise)
    const { result, rerender } = setup(true, true)
    await waitFor(() => expect(sub.repairPushSubscription).toHaveBeenCalled())
    rerender({ available: true, enabled: false })
    await act(async () => repair.resolve(true))
    expect(result.current.pushActive).toBe(false)

    // The click's answer too, once something newer ran.
    const gesture = deferred<boolean>()
    sub.subscribeInGesture.mockReturnValue(gesture.promise)
    let pending: Promise<boolean> = Promise.resolve(false)
    act(() => {
      pending = result.current.enable()
    })
    act(() => {
      result.current.disable()
    })
    await act(async () => {
      gesture.resolve(true)
      await pending
    })
    expect(result.current.pushActive).toBe(false)

    // And a failed read that a newer run overtook.
    const key = deferred<string>()
    api.getPushKey.mockReturnValue(key.promise)
    rerender({ available: true, enabled: true })
    rerender({ available: true, enabled: false })
    await act(async () => key.reject(new Error('x')))
    expect(result.current.pushActive).toBe(false)
  })

  it('drops a failed repair that a newer run overtook', async () => {
    const key = deferred<string>()
    api.getPushKey.mockReturnValue(key.promise)
    const { result, rerender } = setup(true, true)
    await act(async () => {})
    rerender({ available: true, enabled: false })
    await act(async () => key.reject(new Error('x')))
    expect(result.current.pushActive).toBe(false)
  })

  it('turns off and removes the subscription, nothing more', async () => {
    const { result } = setup(true, true)
    await waitFor(() => expect(result.current.pushActive).toBe(true))
    await act(async () => {
      await result.current.disable()
    })
    expect(result.current.pushActive).toBe(false)
    expect(sub.removePushSubscription).toHaveBeenCalledWith(reg)
    // Logging out keeps the setting on: still no repair after the removal.
    expect(sub.repairPushSubscription).toHaveBeenCalledTimes(1)
  })

  it('logs out cleanly on a server without push', async () => {
    const { result } = setup(false, true)
    await act(async () => {
      await result.current.disable()
    })
    expect(sub.removePushSubscription).toHaveBeenCalledWith(undefined)
  })

  it('puts back a subscription turned on during the removal', async () => {
    const removal = deferred<undefined>()
    sub.removePushSubscription.mockReturnValue(removal.promise)
    const { result } = setup(true, true)
    await waitFor(() => expect(result.current.pushActive).toBe(true))
    let off: Promise<void> = Promise.resolve()
    act(() => {
      off = result.current.disable()
    })
    await act(async () => {
      await result.current.enable()
    })
    await act(async () => {
      removal.resolve(undefined)
      await off
    })
    await waitFor(() =>
      expect(sub.repairPushSubscription).toHaveBeenCalledTimes(2),
    )
    await waitFor(() => expect(result.current.pushActive).toBe(true))
  })

  it('repairs every 10 minutes while shown, and when shown again', async () => {
    // waitFor polls with setInterval, faked here: settle the promises instead.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const settle = () =>
      act(async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve()
      })
    const repairs = () => sub.repairPushSubscription.mock.calls.length
    setup(true, true)
    await settle()
    expect(repairs()).toBe(1)
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    const show = async (state: DocumentVisibilityState) => {
      visibility.mockReturnValue(state)
      document.dispatchEvent(new Event('visibilitychange'))
      await settle()
    }
    await show('visible')
    expect(repairs()).toBe(1)
    // Hidden at the tick: nothing
    visibility.mockReturnValue('hidden')
    vi.advanceTimersByTime(REPAIR_EVERY_MS)
    await settle()
    expect(repairs()).toBe(1)
    await show('hidden')
    expect(repairs()).toBe(1)
    await show('visible')
    expect(repairs()).toBe(2)
    // Shown at the next tick
    vi.advanceTimersByTime(REPAIR_EVERY_MS)
    await settle()
    expect(repairs()).toBe(3)
  })
})
