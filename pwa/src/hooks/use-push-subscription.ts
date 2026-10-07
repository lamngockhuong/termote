import { useCallback, useEffect, useRef, useState } from 'react'
import { notifyWorkerReady } from '../utils/notify-permission'
import {
  pushSupported,
  removePushSubscription,
  repairPushSubscription,
  subscribeInGesture,
} from '../utils/push-subscription'
import { getPushKey } from './use-mux-api'

// A visible page tells the server about this device again this often (and
// when it is shown after at least as long), so a subscription the server
// dropped or a key it replaced is noticed.
export const REPAIR_EVERY_MS = 10 * 60_000

interface Options {
  // The server sends Web Push (caps.push)
  available: boolean
  // Notify when an agent needs me
  enabled: boolean
}

// This device's Web Push subscription. pushActive is true only while the
// server confirmed the last subscribe: the page then leaves notifications to
// the push. The key, the registration and the worker's version are read
// ahead, so a click can subscribe without waiting on anything (iOS allows it
// only in the gesture). Nothing subscribes while the active worker lacks the
// push handler: a push it cannot show would cost the permission on Safari.
export function usePushSubscription({ available, enabled }: Options) {
  const [pushActive, setPushActive] = useState(false)
  // What a click needs, read ahead: the registration, the server key, and
  // whether the active worker has the push handler.
  const aheadRef = useRef<{
    reg: ServiceWorkerRegistration
    key: string
    worker: boolean
  }>(undefined)
  const lastRepairRef = useRef(0)
  // A newer run makes an older one's answer stale.
  const runRef = useRef(0)
  // The subscribe a click started: a repair waits for it rather than
  // subscribing a second time outside the gesture.
  const pendingRef = useRef<Promise<unknown>>(Promise.resolve())
  // Clicks that turned it on, to tell whether one came during a removal.
  const enablesRef = useRef(0)
  const on = available && enabled && pushSupported()

  const readAhead = useCallback(async () => {
    const reg = await navigator.serviceWorker.ready
    const [key, worker] = await Promise.all([getPushKey(), notifyWorkerReady()])
    const ahead = { reg, key, worker }
    aheadRef.current = ahead
    return ahead
  }, [])

  const repair = useCallback(async () => {
    const run = ++runRef.current
    lastRepairRef.current = Date.now()
    let ok = false
    try {
      await pendingRef.current
      const { reg, key, worker } = await readAhead()
      ok = worker && (await repairPushSubscription(reg, key))
    } catch {
      // No registration or key: not active
    }
    if (run === runRef.current) setPushActive(ok)
  }, [readAhead])

  // Read ahead for the click while the setting is still off.
  useEffect(() => {
    if (available && pushSupported()) readAhead().catch(() => {})
  }, [available, readAhead])

  // On load, whenever push or the setting turns on, every REPAIR_EVERY_MS
  // while shown, and when shown again after as long. The key is read again
  // each time, so one the server replaced is noticed.
  useEffect(() => {
    if (!on) {
      runRef.current++
      setPushActive(false)
      return
    }
    repair()
    const due = () =>
      document.visibilityState === 'visible' &&
      Date.now() - lastRepairRef.current >= REPAIR_EVERY_MS
    const onVisible = () => {
      if (due()) repair()
    }
    const timer = setInterval(onVisible, REPAIR_EVERY_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [on, repair])

  // Called in the click that turned the setting on, right after the
  // permission: subscribe is its first await.
  const enable = useCallback(() => {
    const ahead = aheadRef.current
    if (!ahead?.worker) return Promise.resolve(false)
    const run = ++runRef.current
    enablesRef.current++
    lastRepairRef.current = Date.now()
    const done = subscribeInGesture(ahead.reg, ahead.key).then((ok) => {
      if (run === runRef.current) setPushActive(ok)
      return ok
    })
    pendingRef.current = done
    return done
  }, [])

  // Turned off, or logging out. A repair waits for the removal; a click
  // that turned it on again meanwhile may have had its subscription undone
  // by it, and a repair then puts it back.
  const disable = useCallback(async () => {
    runRef.current++
    const enables = enablesRef.current
    setPushActive(false)
    const removed = removePushSubscription(aheadRef.current?.reg)
    pendingRef.current = removed
    await removed
    if (enablesRef.current !== enables) repair()
  }, [repair])

  return { pushActive, enable, disable }
}
