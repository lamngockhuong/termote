import { ArrowRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { agentLabel } from '../chat-agents'
import type { ActivityEvent } from '../hooks/use-mux-api'
import type {
  AgentStatus,
  Session,
  SessionGroup,
  SessionPane,
} from '../types/session'
import { sessionPaneKey } from '../utils/pane-remap'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { AgentStatusBadge } from './agent-status-badge'
import { FOCUS_RING } from './ui/button'
import { SegmentedControl } from './ui/segmented-control'

type Filter = 'all' | AgentStatus

const FILTERS: { value: Filter; content: string }[] = [
  { value: 'all', content: 'All' },
  { value: 'blocked', content: 'Needs you' },
  { value: 'working', content: 'Working' },
  { value: 'done', content: 'Done' },
  { value: 'idle', content: 'Idle' },
]

const STATUS_WORDS: Record<string, string> = {
  blocked: 'needs you',
  working: 'working',
  done: 'done',
  idle: 'idle',
}

function Status({ status }: { status: string }) {
  if (!status) return <span className="text-fg-subtle">gone</span>
  return (
    <span className="flex items-center gap-1">
      {status in STATUS_WORDS && (
        <AgentStatusBadge status={status as AgentStatus} size={12} />
      )}
      {STATUS_WORDS[status] ?? status}
    </span>
  )
}

// The time of a server timestamp on this device's clock, "14:03:27".
export function eventTime(ts: string, clockOffset: number): string {
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return ''
  return new Date(t - clockOffset).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

interface Props {
  events: readonly ActivityEvent[]
  sessions: Session[]
  groups: SessionGroup[]
  // Server time minus this device's (ms)
  clockOffset: number
  loaded: boolean
  error: boolean
  onOpen: (session: Session, pane: SessionPane) => void
}

// The agents' status changes since the server started, newest first. A row
// whose pane still exists opens it under its current id (found by key); one
// whose pane has gone is plain text.
export function ActivityLog({
  events,
  sessions,
  groups,
  clockOffset,
  loaded,
  error,
  onOpen,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const byKey = useMemo(() => {
    const m = new Map<string, { session: Session; pane: SessionPane }>()
    for (const session of sessions) {
      for (const pane of session.panes ?? []) {
        m.set(sessionPaneKey(session, pane.id), { session, pane })
      }
    }
    return m
  }, [sessions])
  const groupName = useMemo(
    () => new Map(groups.map((g) => [g.id, g.name])),
    [groups],
  )
  const rows = useMemo(
    () =>
      events
        .filter((e) => filter === 'all' || e.to === filter)
        .slice()
        .reverse(),
    [events, filter],
  )

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <SegmentedControl
        label="Show changes to"
        options={FILTERS}
        value={filter}
        onChange={setFilter}
        className="self-start"
      />
      {error && (
        <p role="status" className="text-[12px] text-fg-muted">
          Could not read the activity; retrying.
        </p>
      )}
      {loaded && rows.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-fg-muted">
          {events.length
            ? 'No changes match.'
            : 'No status changes since the server started.'}
        </p>
      ) : (
        <ol aria-label="Status changes" className="flex flex-col">
          {rows.map((e) => {
            const found = byKey.get(e.key)
            const where = found
              ? visibleUnsafe(
                  groups.length > 1 && found.session.groupId
                    ? `${groupName.get(found.session.groupId) ?? found.session.groupId} / ${found.session.name}`
                    : found.session.name,
                )
              : 'closed'
            const name =
              agentLabel(e.agent) === 'agent'
                ? visibleUnsafe(e.agent || 'Agent')
                : agentLabel(e.agent)
            const body = (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 tabular-nums text-fg-muted">
                    {eventTime(e.ts, clockOffset)}
                  </span>
                  <span className="truncate font-semibold">{name}</span>
                  <span className="truncate text-fg-muted">{where}</span>
                </span>
                <span className="flex items-center gap-1.5 text-fg-muted">
                  <Status status={e.from} />
                  <ArrowRight size={12} aria-label="to" />
                  <Status status={e.to} />
                </span>
              </>
            )
            return (
              <li key={e.seq} className="border-b border-border last:border-0">
                {found ? (
                  <button
                    type="button"
                    onClick={() => onOpen(found.session, found.pane)}
                    className={`flex w-full min-h-touch flex-col gap-0.5 rounded-control px-1 py-1.5 text-left text-[12px] hover:bg-surface-raised ${FOCUS_RING}`}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex flex-col gap-0.5 px-1 py-1.5 text-[12px] text-fg-muted">
                    {body}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
