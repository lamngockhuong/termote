import type { HostBattery, HostPoint } from '../hooks/use-mux-api'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import type { UsageLevel } from './usage-format'

// How the host's numbers read in the Host chip and sheet.

// CPU, memory, swap and disk: from 80% the machine is busy, from 95% it is
// about to run out.
export function hostLevel(percent: number): UsageLevel {
  if (percent >= 95) return 'danger'
  if (percent >= 80) return 'warning'
  return 'normal'
}

// A battery is a worry only while it drains: 20% or less, then 10% or less.
export function batteryLevel(b: HostBattery): UsageLevel {
  if (b.plugged || b.charging) return 'normal'
  if (b.percent <= 10) return 'danger'
  if (b.percent <= 20) return 'warning'
  return 'normal'
}

const GB = 1024 ** 3
const MB = 1024 ** 2

// Bytes as the OS tools show memory (base 1024): "16 GB", "9.8 GB",
// "512 MB"; one decimal below 100 GB, none from there.
export function formatBytes(bytes: number): string {
  if (bytes < GB) return `${Math.round(bytes / MB)} MB`
  const v = bytes / GB
  const s = v >= 100 ? v.toFixed(0) : v.toFixed(1)
  return `${s.replace(/\.0$/, '')} GB`
}

// "1 h 05 min", "45 min", "2 h"
export function formatMinutes(
  minutes: number,
  t: Translate<MessageKey>,
): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return t('shell.host.min', { m: String(m) })
  if (m === 0) return t('shell.host.h', { h: String(h) })
  return t('shell.host.hMin', { h: String(h), m: String(m).padStart(2, '0') })
}

// "61%"; "~61%" for an approximate figure
export function hostPercent(percent: number, approx = false): string {
  return `${approx ? '~' : ''}${Math.round(percent)}%`
}

// One series of the history laid out by time: slot i is
// sampledAt - (slots - 1 - i) * step, null where no sample fell (a server
// just started, a machine asleep); older points are dropped.
export function historySlots(
  history: readonly HostPoint[],
  pick: (p: HostPoint) => number | null,
  sampledAt: string,
  slots = 180,
  stepMs = 5000,
): (number | null)[] {
  const out: (number | null)[] = Array(slots).fill(null)
  const end = Date.parse(sampledAt)
  if (!Number.isFinite(end)) return out
  for (const p of history) {
    const at = Date.parse(p.t)
    if (!Number.isFinite(at)) continue
    const i = slots - 1 - Math.round((end - at) / stepMs)
    if (i >= 0 && i < slots) out[i] = pick(p)
  }
  return out
}

// The highest value of a series, nulls skipped; undefined when empty
export function peak(values: readonly (number | null)[]): number | undefined {
  let max: number | undefined
  for (const v of values)
    if (v !== null && (max === undefined || v > max)) max = v
  return max
}
