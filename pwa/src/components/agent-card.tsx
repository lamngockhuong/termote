import { ChevronDown, GitBranch, Hourglass, SquareTerminal } from 'lucide-react'
import { memo, type Ref, useId, useState } from 'react'
import { agentLabel } from '../chat-agents'
import type {
  ActivityEvent,
  OverviewPane,
  OverviewUsage,
} from '../hooks/use-mux-api'
import { useSubagents } from '../hooks/use-subagents'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import type { AgentStatus, Session, SessionPane } from '../types/session'
import { formatAgo } from '../utils/format-ago'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { percentLabel, usageLevel } from '../utils/usage-format'
import { AgentStatusBadge } from './agent-status-badge'
import { StatusTimeline } from './status-timeline'
import { SubagentTree, subagentSummary } from './subagent-tree'
import { FOCUS_RING, IconButton } from './ui/button'
import { UsageMeter } from './usage-meter'

const STATUS_WORDS: Record<AgentStatus, MessageKey> = {
  blocked: 'tasks.status.blocked',
  working: 'tasks.status.working',
  done: 'tasks.status.done',
  idle: 'tasks.status.idle',
}

// A token count the way a card has room for it: 950, 12.3k, 184k, 1.2M.
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const LEVEL_TEXT = {
  normal: 'text-fg-muted',
  warning: 'text-warning',
  danger: 'text-danger',
}

// How full the agent's context is: a bar, the share ("~" when the window is
// assumed) and the tokens of the window; only the tokens from a server that
// does not know the window.
function ContextUsage({ usage }: { usage: OverviewUsage }) {
  const { t } = useT()
  const { contextTokens, contextWindow, contextPercent, exact, model } = usage
  const known = !!contextWindow && contextPercent !== undefined
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {known ? (
        <>
          <UsageMeter
            percent={contextPercent}
            label={t('tasks.card.context')}
            valueText={t('tasks.card.contextValue', {
              percent: percentLabel(contextPercent, exact),
              used: formatTokens(contextTokens),
              size: formatTokens(contextWindow),
            })}
            className="w-12 shrink-0"
          />
          <span
            className={`shrink-0 tabular-nums ${LEVEL_TEXT[usageLevel(contextPercent)]}`}
            title={exact ? undefined : t('tasks.card.windowAssumed')}
          >
            {percentLabel(contextPercent, exact)}
          </span>
          <span className="shrink-0 tabular-nums">
            {formatTokens(contextTokens)}/{formatTokens(contextWindow)}
          </span>
        </>
      ) : (
        <span className="shrink-0 tabular-nums">
          {t('tasks.card.tokens', { tokens: formatTokens(contextTokens) })}
        </span>
      )}
      {model && <span className="truncate">· {visibleUnsafe(model)}</span>}
    </span>
  )
}

// How long the agent has been in its status: "≥" when the server saw it
// already in it (since is then when the server first saw it).
export function statusAge(
  since: string | undefined,
  firstSeen: boolean | undefined,
  now: number,
  t: Translate<MessageKey>,
): string | undefined {
  const at = since ? Date.parse(since) : Number.NaN
  if (!Number.isFinite(at)) return undefined
  const ms = Math.max(0, now - at)
  const ago = formatAgo(ms, t)
  // "just now" is under a minute
  return firstSeen && ms >= 60_000 ? `≥ ${ago}` : ago
}

interface Props {
  session: Session
  pane: SessionPane
  // Where it runs: "group / tab", and the group's name in the backend's
  // words ("workspace api"), when there are several
  where: string
  groupTitle?: string
  // The group is a worktree of a Herdr worktree group
  worktree?: boolean
  // What /api/mux/overview read for the pane, once read
  overview?: OverviewPane
  // The overview could not be read: no placeholder waits for it
  overviewFailed?: boolean
  // Server time (ms), updated every 30 s
  now: number
  // The pane's key (paneKeys) and the status changes the server kept, for
  // its strip of the last hour
  paneKey: string
  events: readonly ActivityEvent[]
  // Minutes a working agent has written nothing, past the stuck threshold
  stuckFor?: number
  // A tap on the card opens the Chat view (else the terminal); the chat's
  // card has a second way in, to the terminal
  opensChat: boolean
  onOpen: (
    session: Session,
    pane: SessionPane,
    view: 'chat' | 'terminal',
  ) => void
  // The card the overview was opened on: its open button, and an accent
  // border until focus leaves it
  openRef?: Ref<HTMLButtonElement>
  highlighted?: boolean
}

// One agent of the overview: its status and how long it has been in it,
// where it runs, its last message, its branch and changed files, and how
// full its context is. The whole card opens the pane.
export const AgentCard = memo(function AgentCard({
  session,
  pane,
  where,
  groupTitle,
  worktree,
  overview,
  overviewFailed,
  now,
  paneKey,
  events,
  stuckFor,
  opensChat,
  onOpen,
  openRef,
  highlighted,
}: Props) {
  const { t } = useT()
  const detailsId = useId()
  const moreId = useId()
  const [expanded, setExpanded] = useState(false)
  // Only Claude Code's sessions have a subagent tree to read.
  const claude = pane.agentName === 'claude'
  const subagents = useSubagents(pane.id, expanded && claude)
  const subagentCount = claude ? subagentSummary(subagents.tree, t) : undefined
  const label = agentLabel(pane.agentName)
  const name =
    label === 'agent'
      ? visibleUnsafe(pane.agentName || t('tasks.agent'))
      : label
  const place = visibleUnsafe(where)
  const openLabel = opensChat
    ? t('tasks.card.openChat')
    : t('tasks.card.openTerminal')
  const status = pane.agentStatus
  const age = statusAge(pane.agentSince, pane.agentSinceFirstSeen, now, t)
  const pending = (what: string) => overview?.unavailable?.includes(what)
  const showChanges =
    overview && !pending('changes') && overview.changed !== undefined
  return (
    <div
      data-status={status}
      data-stuck={stuckFor !== undefined || undefined}
      data-highlighted={highlighted || undefined}
      className={`relative rounded-panel border bg-surface ui-terminal:bg-bg ${
        highlighted
          ? 'border-accent ring-1 ring-accent'
          : status === 'blocked'
            ? 'border-danger/60'
            : stuckFor !== undefined
              ? 'border-warning/60'
              : 'border-border'
      }`}
    >
      <button
        ref={openRef}
        type="button"
        onClick={() => onOpen(session, pane, opensChat ? 'chat' : 'terminal')}
        aria-label={t('tasks.card.label', {
          open: openLabel,
          name,
          status: status ? t(STATUS_WORDS[status]) : t('tasks.card.noStatus'),
          place,
        })}
        aria-describedby={detailsId}
        className={`flex w-full min-h-touch flex-col gap-1.5 rounded-panel p-3 pr-12 text-left transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-raised ${FOCUS_RING}`}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <AgentStatusBadge status={status} />
          <span className="truncate font-semibold text-fg">{name}</span>
          {status && (
            <span className="shrink-0 text-fg-muted">
              · {t(STATUS_WORDS[status])}
              {age && (
                <span
                  title={
                    pane.agentSinceFirstSeen
                      ? t('tasks.card.firstSeen')
                      : undefined
                  }
                >
                  {' '}
                  · {age}
                </span>
              )}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-muted">
          <span
            className="truncate"
            title={groupTitle && visibleUnsafe(groupTitle)}
          >
            {place}
          </span>
          {worktree && (
            <span className="shrink-0 rounded-control border border-border px-1 text-[11px]">
              {t('tasks.card.worktree')}
            </span>
          )}
        </span>
        {/* What a screen reader reads after the card's name */}
        <span id={detailsId} className="contents">
          {stuckFor !== undefined && (
            <span className="flex items-center gap-1.5 text-[12px] text-warning">
              <Hourglass size={13} aria-hidden="true" className="shrink-0" />
              {t('tasks.card.stuck', { n: stuckFor })}
            </span>
          )}
          {overview?.lastText ? (
            <span className="line-clamp-2 text-[13px] text-fg">
              {visibleUnsafe(overview.lastText)}
            </span>
          ) : (
            (pending('transcript') || (!overview && !overviewFailed)) && (
              <span
                aria-hidden="true"
                className="h-4 w-3/4 rounded-control bg-surface-raised motion-safe:animate-pulse"
              />
            )
          )}
          {(showChanges || overview?.usage) && (
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-muted">
              {showChanges && (
                <span className="flex min-w-0 items-center gap-1">
                  <GitBranch
                    size={13}
                    aria-hidden="true"
                    className="shrink-0"
                  />
                  {overview.branch && (
                    <span className="truncate font-mono">
                      {visibleUnsafe(overview.branch)}
                    </span>
                  )}
                  <span className="shrink-0">
                    ·{' '}
                    {t('tasks.card.changed', {
                      n: `${overview.changed}${overview.changedTruncated ? '+' : ''}`,
                    })}
                  </span>
                </span>
              )}
              {overview?.usage && <ContextUsage usage={overview.usage} />}
            </span>
          )}
        </span>
      </button>
      <div className="border-t border-border px-3 py-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={moreId}
          onClick={() => setExpanded((v) => !v)}
          className={`flex min-h-touch w-full items-center gap-1.5 rounded-control text-left text-[12px] text-fg-muted hover:text-fg ${FOCUS_RING}`}
        >
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={`shrink-0 transition-transform duration-(--duration-fast) ease-standard ${expanded ? 'rotate-180' : ''}`}
          />
          <span className="truncate">
            {expanded ? t('tasks.card.hideHistory') : t('tasks.card.history')}
            {subagentCount && ` · ${subagentCount}`}
          </span>
        </button>
        {expanded && (
          <div id={moreId} className="flex flex-col gap-3 pb-2 pt-1">
            <StatusTimeline events={events} paneKey={paneKey} now={now} />
            {claude && (
              <SubagentTree
                tree={subagents.tree}
                error={subagents.error}
                now={now}
              />
            )}
          </div>
        )}
      </div>
      {opensChat && (
        <IconButton
          size="sm"
          onClick={() => onOpen(session, pane, 'terminal')}
          aria-label={t('tasks.card.openTerminalOf', { name, place })}
          title={t('tasks.card.openTerminal')}
          className="absolute right-2 top-2"
        >
          <SquareTerminal size={16} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  )
})
