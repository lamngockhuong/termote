import { Cpu, GitBranch } from 'lucide-react'
import { agentLabel } from '../chat-agents'
import type { HistorySession } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { sessionAge } from '../utils/session-age'
import { AgentLogo } from './agent-logo'

// The title of a session of the history: a prompt standing in for a title
// reads lighter, and one with nothing at all says so.
export function HistoryTitle({ session }: { session: HistorySession }) {
  const { t } = useT()
  if (!session.title) {
    return (
      <span className="italic text-fg-muted">{t('chat.history.untitled')}</span>
    )
  }
  return (
    <span
      className={
        session.titleSource === 'prompt' ? 'italic text-fg-muted' : undefined
      }
    >
      {session.title}
    </span>
  )
}

// One session in the history: its agent, title, when it was last active,
// its branch and folder under the pane's root, the model of its last answer
// (OpenCode), and whether it runs now.
export function AgentHistoryRow({
  session,
  now,
  onOpen,
}: {
  session: HistorySession
  now: number
  onOpen: (s: HistorySession) => void
}) {
  const { t } = useT()
  return (
    <button
      type="button"
      data-history-id={session.id}
      onClick={() => onOpen(session)}
      className="flex w-full min-h-11 items-start gap-3 px-4 py-2.5 text-left hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
    >
      <span className="mt-0.5 text-[18px]" title={agentLabel(session.agent)}>
        <AgentLogo agent={session.agent} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px]">
          <HistoryTitle session={session} />
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-fg-muted">
          <span>{sessionAge(session.updatedAt, now, t)}</span>
          {session.branch && (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch size={12} aria-hidden="true" />
              <span className="truncate">{session.branch}</span>
            </span>
          )}
          {session.cwd && (
            <span className="truncate font-mono">{session.cwd}/</span>
          )}
          {session.model && (
            <span className="flex min-w-0 items-center gap-1">
              <Cpu size={12} aria-hidden="true" />
              <span className="truncate">{session.model}</span>
            </span>
          )}
        </span>
      </span>
      {session.live && (
        <span className="shrink-0 rounded-full bg-success-soft px-2 py-0.5 text-[11px] text-success">
          {t('chat.history.running')}
        </span>
      )}
    </button>
  )
}
