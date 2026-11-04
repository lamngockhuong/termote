import { useEffect, useRef } from 'react'
import type { Session } from '../types/session'
import { applyBadge, badgeCount, writeBadgePref } from '../utils/app-badge'

interface Options {
  // A new array per poll: the badge is set again after each one
  sessions: Session[]
  enabled: boolean
}

// Sets the installed app's badge to the number of agents waiting on you,
// after every poll (the service worker may have set another number since)
// and when the page shows again; cleared while the setting is off.
export function useAppBadge({ sessions, enabled }: Options) {
  const count = enabled ? badgeCount(sessions) : 0
  const countRef = useRef(count)
  countRef.current = count

  // sessions is new after each poll even when the count is the same
  useEffect(() => {
    applyBadge(enabled ? badgeCount(sessions) : 0)
  }, [sessions, enabled])

  useEffect(() => {
    void writeBadgePref(enabled)
  }, [enabled])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') applyBadge(countRef.current)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
}
