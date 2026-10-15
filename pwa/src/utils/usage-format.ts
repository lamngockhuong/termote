// How an agent's usage reads: its context share and its account's rate
// limit windows, as the overview, the cards and the header chip show them.

export type UsageLevel = 'normal' | 'warning' | 'danger'

// Under 70% nothing to say; from 90% the agent is about to run out.
export function usageLevel(percent: number): UsageLevel {
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warning'
  return 'normal'
}

// "72%", or "~72%" when the window it is a share of is assumed.
export function percentLabel(percent: number, exact = true): string {
  return `${exact ? '' : '~'}${Math.round(percent)}%`
}

// A rate limit window's length: 300 → "5h", 10080 → "7d", 90 → "90m".
export function windowLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

// When a window resets, in this device's time, as precisely as it is near:
// "resets 14:30" today, "resets Mon 09:00" within a week, "resets 28/10"
// further. Undefined when the time cannot be read.
export function resetLabel(
  iso: string | undefined,
  now: number,
): string | undefined {
  const t = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(t)) return undefined
  if (t <= now) return 'resets now'
  const at = new Date(t)
  const today = new Date(now)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (at.toDateString() === today.toDateString()) return `resets ${time}`
  if (t - now < 6 * 86_400_000) {
    return `resets ${WEEKDAYS[at.getDay()]} ${time}`
  }
  return `resets ${pad(at.getDate())}/${pad(at.getMonth() + 1)}`
}

// A window is still running at now: no reset time, or one still ahead. A
// window past its reset says nothing about the new one.
export function windowRunning(resetsAt: string | undefined, now: number) {
  const t = resetsAt ? Date.parse(resetsAt) : Number.NaN
  return !Number.isFinite(t) || t > now
}

// Limits recorded more than this long ago are shown dimmed: the agent has
// not run since, and the account may have been used elsewhere.
export const USAGE_STALE_MS = 30 * 60_000
