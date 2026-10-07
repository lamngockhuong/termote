import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pushKeyBytes,
  pushSupported,
  removePushSubscription,
  repairPushSubscription,
  subscribeInGesture,
} from './push-subscription'

const api = vi.hoisted(() => ({
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
}))
vi.mock('../hooks/use-mux-api', () => api)

// base64url of bytes 1..65, and of another key
const KEY = btoa(
  String.fromCharCode(...Array.from({ length: 65 }, (_, i) => i + 1)),
)
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')
const OTHER = 'AQID'

function fakeSub(key: Uint8Array | null, endpoint = 'https://e/1') {
  return {
    endpoint,
    options: { applicationServerKey: key?.buffer ?? null },
    toJSON: () => ({ endpoint, keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  }
}

function fakeReg(existing: ReturnType<typeof fakeSub> | null = null) {
  const made = fakeSub(pushKeyBytes(KEY), 'https://e/new')
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(existing),
    subscribe: vi.fn().mockResolvedValue(made),
  }
  return {
    reg: { pushManager } as unknown as ServiceWorkerRegistration,
    pushManager,
    made,
  }
}

describe('push subscription', () => {
  beforeEach(() => {
    api.subscribePush.mockReset().mockResolvedValue(undefined)
    api.unsubscribePush.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('Notification', { permission: 'granted' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })

  it('is supported with PushManager and a service worker', () => {
    vi.stubGlobal('PushManager', undefined)
    expect(pushSupported()).toBe(false)
    vi.stubGlobal('PushManager', class {})
    expect(pushSupported()).toBe(false)
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {},
    })
    expect(pushSupported()).toBe(true)
  })

  it('decodes the server key', () => {
    expect(Array.from(pushKeyBytes('AQID'))).toEqual([1, 2, 3])
    expect(Array.from(pushKeyBytes('-_8'))).toEqual([251, 255])
    expect(pushKeyBytes(KEY)).toHaveLength(65)
  })

  describe('subscribeInGesture', () => {
    it('subscribes first, then tells the server', async () => {
      const { reg, pushManager, made } = fakeReg()
      expect(await subscribeInGesture(reg, KEY)).toBe(true)
      expect(pushManager.getSubscription).not.toHaveBeenCalled()
      expect(pushManager.subscribe).toHaveBeenCalledWith({
        userVisibleOnly: true,
        applicationServerKey: pushKeyBytes(KEY),
      })
      expect(api.subscribePush).toHaveBeenCalledWith(made.toJSON())
    })

    it('replaces a subscription under an older key', async () => {
      const old = fakeSub(pushKeyBytes(OTHER))
      const { reg, pushManager } = fakeReg(old)
      pushManager.subscribe.mockRejectedValueOnce(
        new Error('InvalidStateError'),
      )
      expect(await subscribeInGesture(reg, KEY)).toBe(true)
      expect(old.unsubscribe).toHaveBeenCalled()
      expect(pushManager.subscribe).toHaveBeenCalledTimes(2)
    })

    it('fails when nothing can be subscribed', async () => {
      const { reg, pushManager } = fakeReg(null)
      pushManager.subscribe.mockRejectedValue(new Error('denied'))
      expect(await subscribeInGesture(reg, KEY)).toBe(false)

      const old = fakeSub(null)
      old.unsubscribe.mockResolvedValue(false)
      const second = fakeReg(old)
      second.pushManager.subscribe.mockRejectedValue(new Error('x'))
      expect(await subscribeInGesture(second.reg, KEY)).toBe(false)

      const third = fakeReg(fakeSub(null))
      third.pushManager.subscribe.mockRejectedValue(new Error('x'))
      expect(await subscribeInGesture(third.reg, KEY)).toBe(false)
      expect(api.subscribePush).not.toHaveBeenCalled()
    })

    it('gives up when the old subscription cannot be read or removed', async () => {
      const { reg, pushManager } = fakeReg(null)
      pushManager.subscribe.mockRejectedValue(new Error('x'))
      pushManager.getSubscription.mockRejectedValue(new Error('x'))
      expect(await subscribeInGesture(reg, KEY)).toBe(false)
      const old = fakeSub(null)
      old.unsubscribe.mockRejectedValue(new Error('x'))
      const second = fakeReg(old)
      second.pushManager.subscribe.mockRejectedValue(new Error('x'))
      expect(await subscribeInGesture(second.reg, KEY)).toBe(false)
    })

    it('is not active when the server refuses', async () => {
      api.subscribePush.mockRejectedValue(new Error('503'))
      expect(await subscribeInGesture(fakeReg().reg, KEY)).toBe(false)
    })
  })

  describe('repairPushSubscription', () => {
    it('posts the existing subscription again', async () => {
      const sub = fakeSub(pushKeyBytes(KEY))
      const { reg, pushManager } = fakeReg(sub)
      expect(await repairPushSubscription(reg, KEY)).toBe(true)
      expect(pushManager.subscribe).not.toHaveBeenCalled()
      expect(api.subscribePush).toHaveBeenCalledWith(sub.toJSON())
      // A browser that does not report the key keeps its subscription.
      expect(
        await repairPushSubscription(fakeReg(fakeSub(null)).reg, KEY),
      ).toBe(true)
    })

    it('subscribes again under a new server key', async () => {
      const old = fakeSub(pushKeyBytes(OTHER))
      const { reg, pushManager, made } = fakeReg(old)
      expect(await repairPushSubscription(reg, KEY)).toBe(true)
      expect(old.unsubscribe).toHaveBeenCalled()
      expect(pushManager.subscribe).toHaveBeenCalled()
      expect(api.subscribePush).toHaveBeenCalledWith(made.toJSON())
      // Same length, other bytes
      const shifted = pushKeyBytes(KEY).map((b) => b + 1)
      expect(
        await repairPushSubscription(fakeReg(fakeSub(shifted)).reg, KEY),
      ).toBe(true)
    })

    it('subscribes again even when the old one will not unsubscribe', async () => {
      const old = fakeSub(pushKeyBytes(OTHER))
      old.unsubscribe.mockRejectedValue(new Error('x'))
      expect(await repairPushSubscription(fakeReg(old).reg, KEY)).toBe(true)
    })

    it('makes none without the permission', async () => {
      vi.stubGlobal('Notification', { permission: 'default' })
      const { reg, pushManager } = fakeReg(null)
      expect(await repairPushSubscription(reg, KEY)).toBe(false)
      expect(pushManager.subscribe).not.toHaveBeenCalled()
    })

    it('fails on a refused subscribe or a server error', async () => {
      const { reg, pushManager } = fakeReg(null)
      pushManager.getSubscription.mockRejectedValue(new Error('x'))
      pushManager.subscribe.mockRejectedValue(new Error('x'))
      expect(await repairPushSubscription(reg, KEY)).toBe(false)
      api.subscribePush.mockRejectedValue(new Error('400'))
      expect(
        await repairPushSubscription(
          fakeReg(fakeSub(pushKeyBytes(KEY))).reg,
          KEY,
        ),
      ).toBe(false)
    })
  })

  describe('removePushSubscription', () => {
    it('tells the server first, then unsubscribes', async () => {
      const order: string[] = []
      const sub = fakeSub(null, 'https://e/x')
      sub.unsubscribe.mockImplementation(async () => {
        order.push('browser')
        return true
      })
      api.unsubscribePush.mockImplementation(async () => {
        order.push('server')
      })
      await removePushSubscription(fakeReg(sub).reg)
      expect(order).toEqual(['server', 'browser'])
      expect(api.unsubscribePush).toHaveBeenCalledWith(
        'https://e/x',
        expect.any(AbortSignal),
      )
    })

    it('never throws', async () => {
      await removePushSubscription(undefined)
      const { reg, pushManager } = fakeReg(null)
      pushManager.getSubscription.mockRejectedValue(new Error('x'))
      await removePushSubscription(reg)
      const sub = fakeSub(null)
      sub.unsubscribe.mockRejectedValue(new Error('x'))
      api.unsubscribePush.mockRejectedValue(new Error('timeout'))
      await removePushSubscription(fakeReg(sub).reg)
      expect(sub.unsubscribe).toHaveBeenCalled()
      await removePushSubscription(fakeReg(null).reg)
    })
  })
})
