import { useEffect, useRef } from 'react'
import type { AgentStatus, Session, SessionGroup } from '../types/session'
import {
  agentTransitions,
  notificationContent,
  shouldNotify,
} from '../utils/agent-notify'
import { parseDeepLink } from '../utils/deep-link'
import { notificationSupport } from '../utils/notify-permission'
import { onPaneRemap, remapEntries } from '../utils/pane-remap'

interface Options {
  sessions: Session[]
  groups: SessionGroup[]
  // Pane on screen; it never notifies while the page is visible and focused
  activePaneId?: string
  enabled: boolean
  // The server confirmed this device's Web Push subscription: it notifies
  // instead, and the page stays quiet so nothing shows twice.
  pushActive: boolean
}

// Raises a notification when an agent becomes blocked or ends a turn, from
// each new snapshot this page polls. Shown through the service worker, whose
// click handler (public/notify-sw.js) sends the pane's link back here.
export function useAgentNotifications(opts: Options) {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const prevRef = useRef(new Map<string, AgentStatus>())

  // A status follows its pane when a tmux window move shifts the ids, so
  // one agent's last status is never paired with another's (the server's
  // push watcher keys by pane too).
  useEffect(
    () => onPaneRemap((shift) => remapEntries(prevRef.current, shift)),
    [],
  )

  useEffect(() => {
    const { next, events } = agentTransitions(prevRef.current, opts.sessions)
    prevRef.current = next
    if (events.length === 0) return
    const o = optsRef.current
    const ctx = {
      enabled: o.enabled,
      permission: notificationSupport(),
      pushActive: o.pushActive,
      visible: document.visibilityState === 'visible',
      focused: document.hasFocus(),
      activePaneId: o.activePaneId,
    }
    const shown = events.filter((e) => shouldNotify(e, ctx))
    if (shown.length === 0) return
    navigator.serviceWorker.ready
      .then((reg) => {
        for (const e of shown) {
          const { title, options } = notificationContent(
            e,
            o.sessions,
            o.groups,
          )
          reg.showNotification(title, options).catch(() => {})
        }
      })
      .catch(() => {})
  }, [opts.sessions])

  // A click on a notification while this page is open opens its pane here:
  // by the worker's message, or, where that never arrives (iOS resuming a
  // home screen app), by the link the worker kept, taken once the page shows.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const sw = navigator.serviceWorker
    // Only a click since the page was last hidden counts: one kept while
    // the page was on screen was for another window, or its message came.
    let since = Date.now() - PENDING_LINK_MAX_AGE_MS
    let timers: ReturnType<typeof setTimeout>[] = []
    const stop = () => {
      for (const t of timers) clearTimeout(t)
      timers = []
    }
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== 'termote-open') return
      stop()
      openLink(e.data.hash)
      // Delivered: the kept copy must not reopen it later
      void takePendingLink(0)
    }
    // The worker may keep the link only after the page shows (it is woken
    // by the same tap), so the page looks a few times.
    const onVisible = () => {
      stop()
      if (document.visibilityState !== 'visible') {
        since = Date.now()
        return
      }
      const from = since
      timers = PENDING_LINK_READS_MS.map((ms) =>
        setTimeout(() => {
          void takePendingLink(from).then((hash) => {
            if (!hash) return
            stop()
            openLink(hash)
          })
        }, ms),
      )
    }
    sw.addEventListener('message', onMessage)
    document.addEventListener('visibilitychange', onVisible)
    onVisible()
    return () => {
      stop()
      sw.removeEventListener('message', onMessage)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
}

// Where public/notify-sw.js keeps the link of the last click (Cache Storage,
// which the worker and the page share).
const PENDING_LINK_CACHE = 'termote-notify'
const PENDING_LINK_URL = '/__termote/pending-link'
// A kept link older than this is dropped: the user has moved on since.
export const PENDING_LINK_MAX_AGE_MS = 60_000
// When the page looks for a kept link after it shows (ms)
export const PENDING_LINK_READS_MS = [0, 300, 1000, 2500]

function openLink(hash: unknown) {
  if (typeof hash === 'string' && parseDeepLink(hash)) {
    window.location.hash = hash
  }
}

// The link the worker kept, once: it is removed as it is read. Null when
// there is none, it was kept before since (ms) or is stale, or Cache
// Storage is unavailable.
async function takePendingLink(since: number): Promise<string | null> {
  if (typeof caches === 'undefined') return null
  try {
    const res = await caches.match(PENDING_LINK_URL, {
      cacheName: PENDING_LINK_CACHE,
    })
    if (!res) return null
    await caches
      .open(PENDING_LINK_CACHE)
      .then((c) => c.delete(PENDING_LINK_URL))
    const { hash, at } = await res.json()
    const age = Date.now() - at
    if (
      typeof hash !== 'string' ||
      !(at >= since && age >= 0 && age <= PENDING_LINK_MAX_AGE_MS)
    ) {
      return null
    }
    return hash
  } catch {
    return null
  }
}
