import { useEffect, useRef } from 'react'
import type { AgentStatus, Session, SessionGroup } from '../types/session'
import {
  agentTransitions,
  notificationContent,
  shouldNotify,
} from '../utils/agent-notify'
import { parseDeepLink } from '../utils/deep-link'
import { notificationSupport } from '../utils/notify-permission'

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

  // A click on a notification while this page is open opens its pane here.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const sw = navigator.serviceWorker
    const onMessage = (e: MessageEvent) => {
      const hash = e.data?.type === 'termote-open' ? e.data.hash : undefined
      if (typeof hash === 'string' && parseDeepLink(hash)) {
        window.location.hash = hash
      }
    }
    sw.addEventListener('message', onMessage)
    return () => sw.removeEventListener('message', onMessage)
  }, [])
}
