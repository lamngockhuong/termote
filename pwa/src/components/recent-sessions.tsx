import { agentLabel } from '../chat-agents'
import { useAgentHistory } from '../hooks/use-agent-history'
import type { HistorySession, ResumeWhere } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { sessionAge } from '../utils/session-age'
import { HistoryTitle } from './agent-history-row'
import { AgentLogo } from './agent-logo'
import { Button } from './ui/button'

// How many sessions the Chat view of an idle pane offers to resume
export const RECENT_SESSIONS = 3

interface Props {
  paneId: string
  // Where a resume goes from here (the pane itself when it is an idle
  // shell); none: the sessions are only offered to read
  where?: ResumeWhere
  // The session being resumed
  pending?: string
  onResume: (s: HistorySession, where: ResumeWhere) => void
  // Opens the history, at a session when given
  onOpen: (s?: HistorySession) => void
}

// The latest sessions of the pane's folder, under what a pane without an
// agent shows: a title opens it in the history, Resume takes it up again.
// Nothing shows while it loads, on a failure or without any.
export function RecentSessions({
  paneId,
  where,
  pending,
  onResume,
  onOpen,
}: Props) {
  const { t } = useT()
  const history = useAgentHistory(paneId)
  const now = Date.now()
  const recent = history.sessions
    .filter((s) => !s.live)
    .slice(0, RECENT_SESSIONS)
  if (recent.length === 0) return null
  return (
    <section
      aria-label={t('chat.history.recent')}
      className="w-full max-w-md text-left"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="m-0 text-[13px] font-medium text-fg">
          {t('chat.history.recent')}
        </h3>
        <Button size="sm" variant="ghost" onClick={() => onOpen()}>
          {t('chat.history.seeAll')}
        </Button>
      </div>
      <ul className="m-0 list-none divide-y divide-border rounded-control border border-border p-0">
        {recent.map((s) => (
          <li key={s.id} className="flex items-center gap-2 px-3 py-1.5">
            <button
              type="button"
              onClick={() => onOpen(s)}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="text-[16px]" title={agentLabel(s.agent)}>
                <AgentLogo agent={s.agent} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-fg">
                  <HistoryTitle session={s} />
                </span>
                <span className="block text-[11px] text-fg-muted">
                  {sessionAge(s.updatedAt, now, t)}
                </span>
              </span>
            </button>
            {where && (
              <Button
                size="sm"
                disabled={!!pending}
                onClick={() => onResume(s, where)}
              >
                {pending === s.id
                  ? t('chat.history.resuming')
                  : t('chat.history.resume')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
