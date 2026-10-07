// Notification handlers, imported into the generated service worker
// (workbox.importScripts in vite.config.ts). Plain JS: it is copied as is.

// In a function scope, so no name meets the generated worker's own.
;(() => {
  // The page turns notifications on only once the active worker answers this,
  // since an older worker kept active (registerType 'prompt') lacks the click
  // handler. Equal to NOTIFY_WORKER_VERSION in src/utils/notify-permission.ts.
  const NOTIFY_VERSION = 1

  self.addEventListener('message', (event) => {
    if (event.data?.type !== 'termote-notify-ping') return
    event.ports[0]?.postMessage({ version: NOTIFY_VERSION })
  })

  // A pane's link (#/s/...), or '' for any other value.
  function paneHash(data) {
    const hash = data?.hash
    return typeof hash === 'string' && hash.startsWith('#/s/') ? hash : ''
  }

  // An open window of the app takes the link and is focused; otherwise the app
  // opens on it.
  async function openPane(hash) {
    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })
    const client = windows[0]
    if (client) {
      if (hash) client.postMessage({ type: 'termote-open', hash })
      await client.focus().catch(() => {})
      return
    }
    await self.clients.openWindow(`/${hash}`)
  }

  self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    event.waitUntil(openPane(paneHash(event.notification.data)))
  })
})()
