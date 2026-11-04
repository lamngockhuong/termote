import type { Session } from '../types/session'
import { LOCALE_CACHE } from './notify-locale'

// The number on the installed app's icon (Badging API): how many agents wait
// on you, blocked or with a finished turn no one has seen. public/notify-sw.js
// counts the same way from a snapshot when no page is open.

// Where the badge setting is kept for public/notify-sw.js (Cache Storage,
// shared with the worker, as the locale is). Equal to BADGE_URL there.
export const BADGE_URL = '/__badge'

// Counts the panes whose agent is blocked or done, each once. A tab without
// its panes listed counts by its own status.
export function badgeCount(sessions: Session[]): number {
  let n = 0
  for (const s of sessions) {
    if (s.panes?.length) {
      for (const p of s.panes) if (waiting(p.agentStatus)) n++
    } else if (waiting(s.agentStatus)) {
      n++
    }
  }
  return n
}

function waiting(status: string | undefined): boolean {
  return status === 'blocked' || status === 'done'
}

// The browser can set the app's badge.
export function badgeSupported(): boolean {
  return typeof navigator !== 'undefined' && 'setAppBadge' in navigator
}

// Shows n on the app's icon, or clears it at 0. Without the API nothing
// happens; a refusal (no permission, not installed) is ignored.
export function applyBadge(n: number): void {
  if (!badgeSupported()) return
  const done = n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()
  done.catch(() => {})
}

export function clearBadge(): void {
  applyBadge(0)
}

// Keeps the setting for the worker. Nothing happens where Cache Storage is
// missing or refused: the worker then counts (its default is on).
export async function writeBadgePref(enabled: boolean): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const cache = await caches.open(LOCALE_CACHE)
    await cache.put(BADGE_URL, new Response(enabled ? '1' : '0'))
  } catch {
    // A private window may refuse storage
  }
}
