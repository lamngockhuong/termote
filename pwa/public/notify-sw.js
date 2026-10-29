// Notification handlers, imported into the generated service worker
// (workbox.importScripts in vite.config.ts). Plain JS: it is copied as is.

// In a function scope, so no name meets the generated worker's own.
;(() => {
  // The page turns notifications on only once the active worker answers this,
  // since an older worker kept active (registerType 'prompt') lacks the click
  // handler, and one from before 2 lacks the push handler. Equal to
  // NOTIFY_WORKER_VERSION in src/utils/notify-permission.ts.
  const NOTIFY_VERSION = 2

  self.addEventListener('message', (event) => {
    if (event.data?.type !== 'termote-notify-ping') return
    event.ports[0]?.postMessage({ version: NOTIFY_VERSION })
  })

  // A pane's link (#/s/...), or '' for any other value.
  function paneHash(data) {
    const hash = data?.hash
    return typeof hash === 'string' && hash.startsWith('#/s/') ? hash : ''
  }

  // iOS resumes a home screen app without delivering the message below (and
  // refuses its focus()), so the link is also kept here: the page takes it
  // when it shows again. Equal to PENDING_LINK_CACHE and PENDING_LINK_URL in
  // src/hooks/use-agent-notifications.ts.
  const PENDING_LINK_CACHE = 'termote-notify'
  const PENDING_LINK_URL = '/__termote/pending-link'

  async function keepLink(hash) {
    try {
      const cache = await caches.open(PENDING_LINK_CACHE)
      await cache.put(
        PENDING_LINK_URL,
        new Response(JSON.stringify({ hash, at: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    } catch {
      // The message still carries it where it is delivered.
    }
  }

  // An open window of the app takes the link and is focused; otherwise the app
  // opens on it.
  // focus() and openWindow() are allowed only shortly after the click, so
  // neither waits on the link being kept; the message does, so that the
  // page that takes it also drops the kept copy.
  async function openPane(hash) {
    const kept = hash ? keepLink(hash) : Promise.resolve()
    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })
    const client = windows[0]
    if (client) {
      const focused = client.focus().catch(() => {})
      await kept
      if (hash) client.postMessage({ type: 'termote-open', hash })
      await focused
      return
    }
    await Promise.all([self.clients.openWindow(`/${hash}`), kept])
  }

  self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    event.waitUntil(openPane(paneHash(event.notification.data)))
  })

  // Web Push from the server: ids only. The text is made here, with the
  // names read from the snapshot, cleaned as cleanName in
  // src/utils/agent-notify.ts does (the tests hold both to one vector).
  const TITLES = { blocked: 'Agent needs you', done: 'Agent finished' }
  const ICON = '/pwa-192x192.png'
  // Monochrome mark Android shows in the status bar
  const BADGE = '/badge-96x96.png'
  const NAME_MAX = 64
  const UNSAFE_CHARS =
    /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu
  const SNAPSHOT_TIMEOUT_MS = 3000

  function cleanName(name) {
    if (typeof name !== 'string') return ''
    return Array.from(name.replace(UNSAFE_CHARS, '').trim())
      .slice(0, NAME_MAX)
      .join('')
  }

  // {groupId, tabId, paneId, kind}, or null for anything else.
  function readEvent(data) {
    let ev
    try {
      ev = data?.json()
    } catch {
      return null
    }
    const ids = [ev?.groupId, ev?.tabId, ev?.paneId]
    if (!ids.every((id) => typeof id === 'string' && id !== '')) return null
    if (!Object.hasOwn(TITLES, ev.kind)) return null
    return ev
  }

  // Group, tab and agent names of the event's pane, or null when the
  // snapshot cannot be read (signed out, offline, slow).
  async function readNames(ev) {
    try {
      // peek: no page is open, so nothing may be created for this read.
      const res = await fetch('/api/mux/snapshot?peek=1', {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const snap = await res.json()
      const group = snap.groups?.find((g) => g.id === ev.groupId)
      const tab = group?.tabs?.find((t) => t.id === ev.tabId)
      const pane = tab?.panes?.find((p) => p.id === ev.paneId)
      return { group: group?.name, tab: tab?.name, agent: pane?.agent?.name }
    } catch {
      return null
    }
  }

  // The same link as formatDeepLink in src/utils/deep-link.ts.
  function deepLink(ev) {
    const path = [ev.groupId, ev.tabId, ev.paneId]
      .map(encodeURIComponent)
      .join('/')
    return `#/s/${path}`
  }

  // Every push shows a notification: Safari revokes the permission of a
  // site whose push shows none, and Chrome shows one of its own.
  async function showPush(data) {
    const ev = readEvent(data)
    if (!ev) {
      await self.registration.showNotification('Termote', {
        body: 'An agent may need you',
        icon: ICON,
        badge: BADGE,
      })
      return
    }
    const names = await readNames(ev)
    const options = {
      tag: ev.paneId,
      renotify: true,
      icon: ICON,
      badge: BADGE,
      data: { hash: deepLink(ev) },
    }
    if (names) {
      const agent = cleanName(names.agent) || 'Agent'
      const place = [cleanName(names.group), cleanName(names.tab)]
        .filter(Boolean)
        .join(' / ')
      options.body = place ? `${agent} · ${place}` : agent
    }
    await self.registration.showNotification(TITLES[ev.kind], options)
  }

  self.addEventListener('push', (event) => {
    event.waitUntil(showPush(event.data))
  })

  function keyBytes(key) {
    const b64 = key.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  }

  function subscribeRequest(method, body) {
    return fetch('/api/mux/push/subscribe', {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  // The browser replaced or dropped the subscription: make a new one and
  // tell the server. A failure is left to the page's own repair.
  async function resubscribe(old) {
    try {
      if (old?.endpoint) {
        await subscribeRequest('DELETE', { endpoint: old.endpoint }).catch(
          () => {},
        )
      }
      const res = await fetch('/api/mux/push/key', {
        credentials: 'same-origin',
      })
      if (!res.ok) return
      const { publicKey } = await res.json()
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      })
      const { endpoint, keys } = sub.toJSON()
      await subscribeRequest('POST', { endpoint, keys })
    } catch {
      // The page subscribes again when it is next opened.
    }
  }

  self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil(resubscribe(event.oldSubscription))
  })
})()
