import { subscribePush, unsubscribePush } from '../hooks/use-mux-api'
import { readNotifyPermission } from './notify-permission'

// This device's Web Push subscription. The server is told of it on every
// repair (an idempotent upsert), so a subscription it dropped or never got
// comes back; only a confirmed POST counts as active.

const REMOVE_TIMEOUT_MS = 3000

export function pushSupported(): boolean {
  return typeof PushManager !== 'undefined' && 'serviceWorker' in navigator
}

// The server key (base64url) as the bytes subscribe takes.
export function pushKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

// A subscription made with another server key (the server made a new one: a
// recreated container) never receives a push again. A browser that does not
// report the key is taken at its word.
function sameKey(sub: PushSubscription, key: string): boolean {
  const had = sub.options?.applicationServerKey
  if (!had) return true
  const want = pushKeyBytes(key)
  const got = new Uint8Array(had)
  return got.length === want.length && got.every((b, i) => b === want[i])
}

function subscribeOptions(key: string): PushSubscriptionOptionsInit {
  return { userVisibleOnly: true, applicationServerKey: pushKeyBytes(key) }
}

async function confirm(sub: PushSubscription): Promise<boolean> {
  try {
    await subscribePush(sub.toJSON())
    return true
  } catch {
    return false
  }
}

// From a click, right after the permission was granted: subscribe is the
// first await, as iOS allows it only within the user gesture. Resolves to
// whether the server confirmed the subscription.
export async function subscribeInGesture(
  reg: ServiceWorkerRegistration,
  key: string,
): Promise<boolean> {
  let sub: PushSubscription
  try {
    sub = await reg.pushManager.subscribe(subscribeOptions(key))
  } catch {
    // A subscription under an older key is in the way: replace it.
    const old = await reg.pushManager.getSubscription().catch(() => null)
    if (!old || !(await old.unsubscribe().catch(() => false))) return false
    try {
      sub = await reg.pushManager.subscribe(subscribeOptions(key))
    } catch {
      return false
    }
  }
  return confirm(sub)
}

// Without a gesture: keeps the subscription in step with the server key and
// tells the server again. A new subscription is made only once the
// permission is granted already.
export async function repairPushSubscription(
  reg: ServiceWorkerRegistration,
  key: string,
): Promise<boolean> {
  let sub = await reg.pushManager.getSubscription().catch(() => null)
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe().catch(() => false)
    sub = null
  }
  if (!sub) {
    if ((await readNotifyPermission()) !== 'granted') return false
    try {
      sub = await reg.pushManager.subscribe(subscribeOptions(key))
    } catch {
      return false
    }
  }
  return confirm(sub)
}

// Turned off, or logging out: the server forgets the device first (at most
// 3 s), then the browser drops the subscription. Never throws.
export async function removePushSubscription(
  reg: ServiceWorkerRegistration | undefined,
): Promise<void> {
  const sub = await reg?.pushManager.getSubscription().catch(() => null)
  if (!sub) return
  await unsubscribePush(
    sub.endpoint,
    AbortSignal.timeout(REMOVE_TIMEOUT_MS),
  ).catch(() => {})
  await sub.unsubscribe().catch(() => false)
}
