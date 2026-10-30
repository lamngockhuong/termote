import { ArrowRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { agentLabel } from '../chat-agents'
import type { ActivityEvent } from '../hooks/use-mux-api'
import type { Locale } from '../i18n'
import { formatTime } from '../i18n/format'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
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

const FILTERS: { value: Filter; content: MessageKey }[] = [
  { value: 'all', content: 'tasks.activity.all' },
  { value: 'blocked', content: 'tasks.status.blocked' },
  { value: 'working', content: 'tasks.status.working' },
  { value: 'done', content: 'tasks.status.done' },
  { value: 'idle', content: 'tasks.status.idle' },
]

const STATUS_WORDS: Record<string, MessageKey> = {
  blocked: 'tasks.activity.blocked',
  working: 'tasks.activity.working',
  done: 'tasks.activity.done',
  idle: 'tasks.activity.idle',
}

function Status({ status }: { status: string }) {
  const { t } = useT()
  if (!status)
    return <span className="text-fg-subtle">{t('tasks.activity.gone')}</span>
  // A status this version does not know is shown as the server names it
  const known = Object.hasOwn(STATUS_WORDS, status)
  return (
    <span className="flex items-center gap-1">
      {known && <AgentStatusBadge status={status as AgentStatus} size={12} />}
      {known ? t(STATUS_WORDS[status]) : status}
    </span>
  )
}

// The time of a server timestamp on this device's clock, in locale's way
// with its seconds ("2:03:27 PM")
export function eventTime(
  ts: string,
  clockOffset: number,
  locale: Locale,
): string {
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return ''
  return formatTime(t - clockOffset, locale, true)
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
  const { t, locale } = useT()
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
        label={t('tasks.activity.filter')}
        options={FILTERS.map((f) => ({ ...f, content: t(f.content) }))}
        value={filter}
        onChange={setFilter}
        className="self-start"
      />
      {error && (
        <p role="status" className="text-[12px] text-fg-muted">
          {t('tasks.activity.readFailed')}
        </p>
      )}
      {loaded && rows.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-fg-muted">
          {events.length
            ? t('tasks.activity.noMatch')
            : t('tasks.activity.none')}
        </p>
      ) : (
        <ol aria-label={t('tasks.activity.list')} className="flex flex-col">
          {rows.map((e) => {
            const found = byKey.get(e.key)
            const where = found
              ? visibleUnsafe(
                  groups.length > 1 && found.session.groupId
                    ? `${groupName.get(found.session.groupId) ?? found.session.groupId} / ${found.session.name}`
                    : found.session.name,
                )
              : t('tasks.activity.closed')
            const name =
              agentLabel(e.agent) === 'agent'
                ? visibleUnsafe(e.agent || t('tasks.agent'))
                : agentLabel(e.agent)
            const body = (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 tabular-nums text-fg-muted">
                    {eventTime(e.ts, clockOffset, locale)}
                  </span>
                  <span className="truncate font-semibold">{name}</span>
                  <span className="truncate text-fg-muted">{where}</span>
                </span>
                <span className="flex items-center gap-1.5 text-fg-muted">
                  <Status status={e.from} />
                  <ArrowRight size={12} aria-label={t('tasks.activity.to')} />
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
