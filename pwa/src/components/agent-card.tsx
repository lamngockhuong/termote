import {
  ChevronDown,
  GitBranch,
  Hourglass,
  ListTodo,
  Square,
  SquareTerminal,
} from 'lucide-react'
import { memo, type ReactNode, type Ref, useId, useState } from 'react'
import { agentLabel, reportedCostAgent, subagentAgent } from '../chat-agents'
import { useAgentStop } from '../hooks/use-agent-stop'
import type {
  ActivityEvent,
  OverviewPane,
  OverviewUsage,
  SubagentNode,
} from '../hooks/use-mux-api'
import { AgentRequestError } from '../hooks/use-mux-api'
import { useSubagents } from '../hooks/use-subagents'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import type { AgentStatus, Session, SessionPane } from '../types/session'
import { formatAgo } from '../utils/format-ago'
import { serverErrorText } from '../utils/server-error'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { percentLabel, usageLevel } from '../utils/usage-format'
import { AgentStatusBadge } from './agent-status-badge'
import { SessionUsageLine } from './session-usage-line'
import { StatusTimeline } from './status-timeline'
import { formatTokens, SubagentTree, subagentSummary } from './subagent-tree'
import { FOCUS_RING, IconButton } from './ui/button'
import { Skeleton } from './ui/skeleton'
import { UsageMeter } from './usage-meter'

const STATUS_WORDS: Record<AgentStatus, MessageKey> = {
  blocked: 'tasks.status.blocked',
  working: 'tasks.status.working',
  done: 'tasks.status.done',
  idle: 'tasks.status.idle',
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
  // The group is a linked worktree of a repository
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
  // A Stop for the agent while it works: one the server takes a message
  // for, never on a view-only device
  canStop?: boolean
  // Why a Stop was refused, for the overview's one toast: a refusal from
  // another card replaces it rather than stacking a second one
  onStopFailed?: (message: string) => void
  // Opens a subagent's conversation from the card's tree (each row a button);
  // the overview holds it open, so it outlives the card
  onOpenSubagent?: (node: SubagentNode) => void
  // The title of the job the pane works on (utils/job-of-pane.ts), as the
  // ledger has it
  job?: string
}

// One of the card's figures under its name (Branch, Context, Session): spans
// only, as the card's open button holds them
function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="text-fg-subtle">
        {label}
        <span className="sr-only">: </span>
      </span>
      <span className="min-w-0">
        {children}
        <span className="sr-only">. </span>
      </span>
    </>
  )
}

// What a card calls its agent: the product's name, else what the server
// reported, shown safe
export function agentCardName(
  pane: SessionPane,
  t: Translate<MessageKey>,
): string {
  const label = agentLabel(pane.agentName)
  return label === 'agent'
    ? visibleUnsafe(pane.agentName || t('tasks.agent'))
    : label
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
  canStop,
  onStopFailed,
  onOpenSubagent,
  job,
}: Props) {
  const { t } = useT()
  const halt = useAgentStop(pane.id, pane.agentStatus, pane.agentSince)
  const detailsId = useId()
  const moreId = useId()
  const [expanded, setExpanded] = useState(false)
  // Only Claude Code's and OpenCode's sessions have a subagent tree to read.
  const hasSubagents = subagentAgent(pane.agentName)
  const subagents = useSubagents(pane.id, expanded && hasSubagents)
  const subagentCount = hasSubagents
    ? subagentSummary(subagents.tree, t)
    : undefined
  const name = agentCardName(pane, t)
  const place = visibleUnsafe(where)
  const openLabel = opensChat
    ? t('tasks.card.openChat')
    : t('tasks.card.openTerminal')
  const status = pane.agentStatus
  const age = statusAge(pane.agentSince, pane.agentSinceFirstSeen, now, t)
  const pending = (what: string) => overview?.unavailable?.includes(what)
  const showChanges =
    overview && !pending('changes') && overview.changed !== undefined
  // The cursor of the session the card sums up: a Stop never reaches
  // another one, and one refused as changed is not tried again.
  const cursor = overview?.cursor
  // Only background work left: Esc would stop nothing, and the server says so
  const background = status === 'working' ? overview?.background : undefined
  const stopShown =
    !!canStop &&
    !!cursor &&
    ((status === 'working' && !background) || halt.stopping)
  const stop = async (c: string) => {
    const err = await halt.stop(c)
    if (!err) return
    const message =
      err instanceof AgentRequestError
        ? serverErrorText(err, t)
        : t('errors.unknown')
    onStopFailed?.(t('tasks.card.notStopped', { name, message }))
  }
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
      {/* Hovering the open button lights the whole first part of the card,
        its Stop and terminal buttons included, as one surface */}
      <div className="flex items-start rounded-t-panel transition-colors duration-(--duration-fast) ease-standard has-[>button:hover]:bg-surface-raised">
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
          className={`flex min-h-touch min-w-0 flex-1 flex-col gap-1.5 rounded-panel p-3 text-left ${FOCUS_RING}`}
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
            {job && (
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-accent">
                <ListTodo size={13} aria-hidden="true" className="shrink-0" />
                <span className="truncate">
                  {t('tasks.card.job', { title: visibleUnsafe(job) })}
                </span>
              </span>
            )}
            {stuckFor !== undefined && (
              <span className="flex items-center gap-1.5 text-[12px] text-warning">
                <Hourglass size={13} aria-hidden="true" className="shrink-0" />
                {t('tasks.card.stuck', { n: stuckFor })}
              </span>
            )}
            {background && (
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-muted">
                <Hourglass size={13} aria-hidden="true" className="shrink-0" />
                <span className="truncate">
                  {t('chat.activity.background', {
                    what: visibleUnsafe(background),
                  })}
                </span>
              </span>
            )}
            {overview?.lastText ? (
              <span className="line-clamp-2 text-[13px] text-fg">
                {visibleUnsafe(overview.lastText)}
              </span>
            ) : (
              (pending('transcript') || (!overview && !overviewFailed)) && (
                <Skeleton className="h-4 w-3/4" />
              )
            )}
            {(showChanges ||
              overview?.usage ||
              !!overview?.sessionUsage?.tokens ||
              pending('sessionUsage')) && (
              <span className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-[12px] text-fg-muted">
                {showChanges && (
                  <Metric label={t('tasks.card.metric.branch')}>
                    <span className="flex min-w-0 items-center gap-1">
                      <GitBranch
                        size={13}
                        aria-hidden="true"
                        className="shrink-0 self-center"
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
                  </Metric>
                )}
                {overview?.usage && (
                  <Metric label={t('tasks.card.metric.context')}>
                    <ContextUsage usage={overview.usage} />
                  </Metric>
                )}
                {overview?.sessionUsage?.tokens ? (
                  <Metric label={t('tasks.card.metric.session')}>
                    <SessionUsageLine
                      {...overview.sessionUsage}
                      reported={reportedCostAgent(pane.agentName)}
                    />
                  </Metric>
                ) : (
                  pending('sessionUsage') && (
                    <Metric label={t('tasks.card.metric.session')}>
                      <Skeleton className="h-4 w-1/3" />
                    </Metric>
                  )
                )}
              </span>
            )}
          </span>
        </button>
        {(stopShown || opensChat) && (
          <span className="flex shrink-0 items-center gap-0.5 p-1">
            {stopShown && (
              <IconButton
                onClick={() => void stop(cursor)}
                disabled={halt.stopping}
                aria-busy={halt.stopping}
                aria-label={
                  halt.stopping
                    ? t('tasks.card.stopping', { name })
                    : t('tasks.card.stop', { name, place })
                }
                title={t('tasks.card.stop', { name, place })}
              >
                <Square size={14} aria-hidden="true" fill="currentColor" />
              </IconButton>
            )}
            {opensChat && (
              <IconButton
                onClick={() => onOpen(session, pane, 'terminal')}
                aria-label={t('tasks.card.openTerminalOf', { name, place })}
                title={t('tasks.card.openTerminal')}
              >
                <SquareTerminal size={16} aria-hidden="true" />
              </IconButton>
            )}
          </span>
        )}
      </div>
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
            {hasSubagents && (
              <SubagentTree
                tree={subagents.tree}
                error={subagents.error}
                now={now}
                onOpen={onOpenSubagent}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
})
