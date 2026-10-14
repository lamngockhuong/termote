import type { ActivityEvent } from '../hooks/use-mux-api'

// The status strip of one agent: the last hour, cut into the statuses its
// events give. Before the first event the server kept for it nothing is
// known, and after an event saying the agent went (to '') there is nothing
// to draw: both stay empty instead of stretching a status over them.

export const TIMELINE_WINDOW = 60 * 60_000

export interface TimelineSegment {
  status: string
  // Server time (ms), clipped to the window
  start: number
  end: number
}

// The pane's segments in [now - window, now], oldest first. events are in
// seq order; only those with the pane's key count (its ids change when a
// tmux window moves or a Zellij session is renamed, its key does not).
export function timelineSegments(
  events: readonly ActivityEvent[],
  key: string,
  now: number,
  window = TIMELINE_WINDOW,
): TimelineSegment[] {
  const from = now - window
  const mine = events.filter((e) => e.key === key)
  const out: TimelineSegment[] = []
  for (let i = 0; i < mine.length; i++) {
    const e = mine[i]
    if (!e.to) continue
    const start = Date.parse(e.ts)
    const next = mine[i + 1]
    const end = next ? Date.parse(next.ts) : now
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const s = Math.max(start, from)
    const t = Math.min(end, now)
    if (t <= s) continue
    const last = out[out.length - 1]
    // The same status twice in a row (a change the client did not see
    // between them) is one segment.
    if (last && last.status === e.to && last.end === s) last.end = t
    else out.push({ status: e.to, start: s, end: t })
  }
  return out
}

// How long each status lasted in segments, longest first.
export function segmentTotals(
  segments: readonly TimelineSegment[],
): [string, number][] {
  const totals = new Map<string, number>()
  for (const s of segments) {
    totals.set(s.status, (totals.get(s.status) ?? 0) + s.end - s.start)
  }
  return [...totals].sort((a, b) => b[1] - a[1])
}
