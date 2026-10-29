import { useMemo } from 'react'
import type { ActivityEvent } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { AgentStatus } from '../types/session'
import {
  segmentTotals,
  TIMELINE_WINDOW,
  timelineSegments,
} from '../utils/timeline-segments'
import { AgentStatusBadge } from './agent-status-badge'

// Fill of each status. Blocked is also striped and idle hollow, so the
// strip reads without colour; the legend names each with its icon's word.
const SEGMENT_STYLE: Record<string, string> = {
  blocked:
    'bg-danger bg-[repeating-linear-gradient(135deg,transparent_0_3px,rgb(0_0_0/0.25)_3px_6px)]',
  working: 'bg-warning',
  done: 'bg-success',
  idle: 'border border-fg-subtle bg-transparent',
}

const STATUS_WORDS: Record<string, MessageKey> = {
  blocked: 'shell.timeline.blocked',
  working: 'shell.timeline.working',
  done: 'shell.timeline.done',
  idle: 'shell.timeline.idle',
}

interface Props {
  events: readonly ActivityEvent[]
  // The pane's key (paneKeys), which its events carry
  paneKey: string
  // Server time (ms)
  now: number
}

// The agent's statuses over the last hour, from the events the server kept
// for its key. Times before the first one are left blank: unknown.
export function StatusTimeline({ events, paneKey, now }: Props) {
  const segments = useMemo(
    () => timelineSegments(events, paneKey, now),
    [events, paneKey, now],
  )
  const { t } = useT()
  // A status the server added later shows as it is
  const word = (status: string) =>
    status in STATUS_WORDS ? t(STATUS_WORDS[status]) : status
  const minutes = (ms: number) => {
    const min = Math.round(ms / 60_000)
    return min < 1
      ? t('shell.timeline.underMinute')
      : t('shell.timeline.minutes', { n: min })
  }
  const from = now - TIMELINE_WINDOW
  const totals = segmentTotals(segments)
  const label = totals.length
    ? t('shell.timeline.label', {
        totals: totals.map(([s, ms]) => `${word(s)} ${minutes(ms)}`).join(', '),
      })
    : t('shell.timeline.none')
  return (
    <div className="flex flex-col gap-1">
      <div
        role="img"
        aria-label={label}
        title={label}
        className="relative h-3 w-full overflow-hidden rounded-control bg-surface-raised"
      >
        {segments.map((s) => (
          <span
            key={s.start}
            data-status={s.status}
            className={`absolute inset-y-0 ${SEGMENT_STYLE[s.status] ?? 'bg-fg-subtle/40'}`}
            style={{
              left: `${((s.start - from) / TIMELINE_WINDOW) * 100}%`,
              width: `${((s.end - s.start) / TIMELINE_WINDOW) * 100}%`,
            }}
          />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-subtle"
      >
        <span>{t('shell.timeline.window')}</span>
        {totals.length === 0 ? (
          <span>{t('shell.timeline.noData')}</span>
        ) : (
          totals.map(([status, ms]) => (
            <span key={status} className="flex items-center gap-1">
              {status in STATUS_WORDS && (
                <AgentStatusBadge status={status as AgentStatus} size={11} />
              )}
              {word(status)} {minutes(ms)}
            </span>
          ))
        )}
      </div>
    </div>
  )
}
