// Notification permission, and whether the active service worker has the
// notification handlers (public/notify-sw.js) a click needs.

export type NotifySupport = NotificationPermission | 'unsupported'

// Answered by notify-sw.js; a worker from before it never answers, and one
// before 2 has no push handler.
export const NOTIFY_WORKER_VERSION = 2
const PING_TIMEOUT_MS = 500

export function notificationSupport(): NotifySupport {
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
    return 'unsupported'
  }
  return Notification.permission
}

// iPhone and iPad notify only from the app added to the Home Screen (iOS
// 16.4+); in Safari, Notification does not exist at all.
export function needsHomeScreenApp(
  nav: Navigator & { standalone?: boolean } = navigator,
): boolean {
  const ios =
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)
  const standalone =
    nav.standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true
  return ios && !standalone
}

// Called first thing in a click: Safari asks only from a user gesture.
export function requestNotify(): Promise<NotificationPermission> {
  return Notification.requestPermission()
}

// The active worker answers the ping. With registerType 'prompt' a worker
// from an older build can stay active until the page reloads.
export async function notifyWorkerReady(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  const reg = await navigator.serviceWorker.getRegistration().catch(() => {})
  const worker = reg?.active
  if (!worker) return false
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => {
      channel.port1.close()
      resolve(false)
    }, PING_TIMEOUT_MS)
    channel.port1.onmessage = (e: MessageEvent) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(e.data?.version === NOTIFY_WORKER_VERSION)
    }
    worker.postMessage({ type: 'termote-notify-ping' }, [channel.port2])
  })
}
