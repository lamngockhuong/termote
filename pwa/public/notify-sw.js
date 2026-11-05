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
  const KINDS = ['blocked', 'done']
  // The words, in each language the app speaks: equal to dialogs.notify.* in
  // src/i18n/messages (notify-sw.test.ts holds them to one table).
  const TEXT = {
    en: {
      blocked: 'Agent needs you',
      done: 'Agent finished',
      agent: 'Agent',
      fallback: 'An agent may need you',
    },
    vi: {
      blocked: 'Agent cần bạn',
      done: 'Agent đã xong',
      agent: 'Agent',
      fallback: 'Có thể một agent đang cần bạn',
    },
  }
  // Where the page keeps the app's language, so a push read with no page
  // open speaks it too. Equal to LOCALE_CACHE and LOCALE_URL in
  // src/utils/notify-locale.ts.
  const LOCALE_CACHE = 'termote-prefs'
  const LOCALE_URL = '/__locale'
  const ICON = '/pwa-192x192.png'
  // Monochrome mark Android shows in the status bar
  const BADGE = '/badge-96x96.png'
  const NAME_MAX = 64
  const UNSAFE_CHARS =
    /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu
  const SNAPSHOT_TIMEOUT_MS = 3000

  // The words in the app's language; English when none was kept or it
  // cannot be read.
  async function readText() {
    try {
      const res = await caches.match(LOCALE_URL, { cacheName: LOCALE_CACHE })
      const locale = res ? await res.text() : ''
      return Object.hasOwn(TEXT, locale) ? TEXT[locale] : TEXT.en
    } catch {
      return TEXT.en
    }
  }

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
    if (!KINDS.includes(ev.kind)) return null
    return ev
  }

  // Every pane, read with this device's credentials: { snap } when read,
  // { denied: true } when signed out or revoked (401, 403), {} when offline,
  // slow or failed.
  async function readSnapshot() {
    try {
      // peek: no page is open, so nothing may be created for this read.
      const res = await fetch('/api/mux/snapshot?peek=1', {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      })
      if (res.status === 401 || res.status === 403) return { denied: true }
      if (!res.ok) return {}
      return { snap: await res.json() }
    } catch {
      return {}
    }
  }

  // Group, tab, pane and agent names of the event's pane, or null without a
  // snapshot.
  function namesOf(snap, ev) {
    if (!snap) return null
    const group = snap.groups?.find((g) => g.id === ev.groupId)
    const tab = group?.tabs?.find((t) => t.id === ev.tabId)
    const pane = tab?.panes?.find((p) => p.id === ev.paneId)
    return {
      group: group?.name,
      tab: tab?.name,
      pane: pane?.name,
      agent: pane?.agent?.name,
    }
  }

  // Where the page keeps the badge setting ('0' off). Equal to BADGE_URL in
  // src/utils/app-badge.ts, in LOCALE_CACHE.
  const BADGE_URL = '/__badge'

  // The panes whose agent is blocked or has a finished turn no one saw, each
  // once: badgeCount in src/utils/app-badge.ts counts the page's the same way.
  function badgeCount(snap) {
    let n = 0
    for (const g of snap.groups ?? []) {
      for (const t of g.tabs ?? []) {
        for (const p of t.panes ?? []) {
          const status = p.agent?.status
          if (status === 'blocked' || status === 'done') n++
        }
      }
    }
    return n
  }

  // On unless the page turned it off; on when it cannot be read.
  async function badgeEnabled() {
    try {
      const res = await caches.match(BADGE_URL, { cacheName: LOCALE_CACHE })
      return !res || (await res.text()) !== '0'
    } catch {
      return true
    }
  }

  // Sets the app's badge from the snapshot read for the push. Signed out:
  // cleared. Offline: the last count stays. A page on screen sets its own,
  // from a newer read. The push itself carries ids only, never a count.
  async function updateBadge(read) {
    const nav = self.navigator
    if (!nav || !('setAppBadge' in nav)) return
    try {
      if (read.denied) {
        await nav.clearAppBadge()
        return
      }
      if (!read.snap) return
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      if (windows.some((w) => w.visibilityState === 'visible')) return
      const n = (await badgeEnabled()) ? badgeCount(read.snap) : 0
      await (n > 0 ? nav.setAppBadge(n) : nav.clearAppBadge())
    } catch {
      // Not installed, or refused: the notification still shows
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
    const text = await readText()
    if (!ev) {
      await self.registration.showNotification('Termote', {
        body: text.fallback,
        icon: ICON,
        badge: BADGE,
      })
      return
    }
    const read = await readSnapshot()
    await updateBadge(read)
    const names = namesOf(read.snap, ev)
    const options = {
      tag: ev.paneId,
      renotify: true,
      icon: ICON,
      badge: BADGE,
      data: { hash: deepLink(ev) },
    }
    if (names) {
      // The name the user gave the pane tells two agents' panes apart
      const agent =
        cleanName(names.pane) || cleanName(names.agent) || text.agent
      const place = [cleanName(names.group), cleanName(names.tab)]
        .filter(Boolean)
        .join(' / ')
      options.body = place ? `${agent} · ${place}` : agent
    }
    await self.registration.showNotification(text[ev.kind], options)
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
