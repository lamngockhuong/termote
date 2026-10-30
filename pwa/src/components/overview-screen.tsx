import { History, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useActivityLog } from '../hooks/use-activity-log'
import { useAgentOverview } from '../hooks/use-agent-overview'
import { useMediaQuery } from '../hooks/use-media-query'
import { ENTER_FROM, useNewKeys } from '../hooks/use-new-keys'
import { LEAVE_TO, usePresenceList } from '../hooks/use-presence-list'
import { useT } from '../i18n/i18n-context'
import type { Session, SessionGroup, SessionPane } from '../types/session'
import { stuckFor } from '../utils/agent-stuck'
import { overviewOrder } from '../utils/overview-order'
import { sessionPaneKey } from '../utils/pane-remap'
import {
  matchesPaneFilter,
  type SidebarFilter,
  summarizePanes,
} from '../utils/session-filter'
import { matchesPaneQuery, searchTerms } from '../utils/session-search'
import { AccountUsageStrip } from './account-usage-strip'
import { ActivityLog } from './activity-log'
import { AgentCard } from './agent-card'
import { AgentFilterBar } from './agent-filter-bar'
import { NeedsMeQueue } from './needs-me-queue'
import { SearchToggle, SessionSearchField } from './session-search-field'
import { Button, IconButton } from './ui/button'
import { Sheet } from './ui/sheet'

// The card's time is a coarse "3 min ago": a tick every 30 s keeps it right
// without rendering the list every second.
export const OVERVIEW_TICK = 30_000

export interface OverviewCard {
  session: Session
  pane: SessionPane
  status?: SessionPane['agentStatus']
  since?: string
}

// Every pane running an agent, with its tab, in the sidebar's order.
export function agentCards(sessions: Session[]): OverviewCard[] {
  return sessions.flatMap((session) =>
    (session.panes ?? [])
      .filter((p) => p.hasAgent)
      .map((pane) => ({
        session,
        pane,
        status: pane.agentStatus,
        since: pane.agentSince,
      })),
  )
}

interface Props {
  sessions: Session[]
  groups: SessionGroup[]
  // What a group is called here ("workspace", "tmux session")
  groupNoun: string
  // The first snapshot is in: until then nothing says "no agent"
  ready: boolean
  // Milliseconds between reads (the session list's period)
  pollInterval: number
  // Server time minus this device's (ms)
  clockOffset: number
  // tmux and psmux track only the active pane of each window
  activePaneOnly: boolean
  // Whether a card opens the Chat view of an agent (else its terminal)
  opensChat: (pane: SessionPane) => boolean
  // Whether the server answers the agent's dialogs (else the terminal)
  canAnswer: (pane: SessionPane) => boolean
  // View-only: dialogs are shown, never answered
  readOnly: boolean
  // A working agent quiet this many minutes is marked stuck
  stuckMinutes: number
  onOpen: (
    session: Session,
    pane: SessionPane,
    view: 'chat' | 'terminal',
  ) => void
  onClose: () => void
  // Unset (view-only, or nowhere to start one): no button when empty
  onStartAgent?: () => void
  // The pane whose card takes focus (the header's usage chip); a new
  // object asks again
  focusPane?: { paneId: string }
}

// Every agent the server sees, in every group: those waiting on the user
// first, then working, done and idle, the longest in its state first. A card
// opens its pane; the filter is the overview's own, not the sidebar's.
export function OverviewScreen({
  sessions,
  groups,
  groupNoun,
  ready,
  pollInterval,
  clockOffset,
  activePaneOnly,
  opensChat,
  canAnswer,
  readOnly,
  stuckMinutes,
  onOpen,
  onClose,
  onStartAgent,
  focusPane,
}: Props) {
  const { t } = useT()
  const overview = useAgentOverview(pollInterval)
  const activity = useActivityLog(pollInterval)
  // The activity log: a column beside the cards on a wide screen, a sheet
  // anywhere else.
  const [logOpen, setLogOpen] = useState(false)
  const wide = useMediaQuery('(min-width: 1280px)')
  // Focus moves into the overview and back to where it was when it closes.
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    titleRef.current?.focus()
    return () => {
      if (before?.isConnected) before.focus()
    }
  }, [])
  const [filter, setFilter] = useState<SidebarFilter>('all')
  // The search box: the cards only, not the queue or the activity log
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const closeSearch = () => {
    setQuery('')
    setSearchOpen(false)
  }
  const [now, setNow] = useState(() => Date.now() + clockOffset)
  useEffect(() => {
    setNow(Date.now() + clockOffset)
    const id = setInterval(
      () => setNow(Date.now() + clockOffset),
      OVERVIEW_TICK,
    )
    return () => clearInterval(id)
  }, [clockOffset])

  const cards = useMemo(() => overviewOrder(agentCards(sessions)), [sessions])
  const summary = useMemo(
    () => summarizePanes(cards.map((c) => c.pane)),
    [cards],
  )
  const groupOf = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const terms = searchTerms(query)
  const shown = cards.filter(
    (c) =>
      matchesPaneFilter(c.pane, filter) &&
      matchesPaneQuery(
        c.session,
        c.pane,
        terms,
        groupOf.get(c.session.groupId ?? '')?.name,
      ),
  )
  // A card for an agent that came later fades in; one whose pane went fades
  // out where it was, inert. One the filter or the search hides just goes.
  const cardIds = cards.map(cardKey)
  const isNew = useNewKeys(cardIds)
  const known = new Set(cardIds)
  const { entries, ref } = usePresenceList(
    shown,
    cardKey,
    (id) => !known.has(id),
  )
  // The card asked for takes focus once it is shown (the cards are drawn
  // only when ready), over the title, and keeps an accent border until focus
  // leaves it. A card shown after the user moved on takes nothing.
  const targetRef = useRef<HTMLButtonElement>(null)
  const focused = useRef<object>(undefined)
  const [highlighted, setHighlighted] = useState<string>()
  const target =
    ready && focusPane && shown.some((c) => c.pane.id === focusPane.paneId)
      ? focusPane
      : undefined
  useEffect(() => {
    if (!target || focused.current === target) return
    focused.current = target
    const at = document.activeElement
    if (at !== titleRef.current && at !== document.body) return
    // The target is shown, so its card holds the ref
    targetRef.current!.focus()
    setHighlighted(target.paneId)
  }, [target])
  const showGroups = groups.length > 1
  const placeOf = useCallback(
    (session: Session) => {
      const group = session.groupId ? groupOf.get(session.groupId) : undefined
      return showGroups && group
        ? `${group.name} / ${session.name}`
        : session.name
    },
    [groupOf, showGroups],
  )
  const queueCards = useMemo(
    () => cards.map((c) => ({ ...c, where: placeOf(c.session) })),
    [cards, placeOf],
  )

  // Opening a pane from the log leaves the overview, as a card does.
  const log = (
    <ActivityLog
      events={activity.events}
      sessions={sessions}
      groups={groups}
      clockOffset={clockOffset}
      loaded={activity.loaded}
      error={activity.error}
      onOpen={(session, pane) => {
        setLogOpen(false)
        onOpen(session, pane, opensChat(pane) ? 'chat' : 'terminal')
      }}
    />
  )

  return (
    <section
      aria-labelledby="overview-title"
      className="flex h-full flex-col bg-bg"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <h2
          id="overview-title"
          ref={titleRef}
          tabIndex={-1}
          className="flex-1 text-[15px] font-semibold outline-none"
        >
          {t('tasks.overview.title')}
        </h2>
        {cards.length > 0 && (
          <SearchToggle
            controls={searchId}
            noun={t('tasks.overview.searchNoun')}
            open={searchOpen}
            onToggle={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          />
        )}
        <IconButton
          onClick={() => setLogOpen((v) => !v)}
          aria-label={t('tasks.activity.title')}
          aria-pressed={logOpen}
          title={t('tasks.activity.hint')}
        >
          <History size={18} aria-hidden="true" />
        </IconButton>
        <IconButton
          onClick={onClose}
          aria-label={t('tasks.overview.close')}
          title={t('tasks.overview.closeEsc')}
        >
          <X size={18} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {overview.error && (
            <p role="status" className="mb-3 text-[12px] text-fg-muted">
              {t('tasks.overview.readFailed')}
            </p>
          )}
          {!ready ? null : cards.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-[13px] text-fg-muted">
              <p>{t('tasks.overview.none')}</p>
              {onStartAgent && (
                <Button onClick={onStartAgent}>
                  {t('tasks.overview.start')}
                </Button>
              )}
            </div>
          ) : (
            <>
              <AccountUsageStrip accounts={overview.accounts} now={now} />
              <NeedsMeQueue
                cards={queueCards}
                readOnly={readOnly}
                canAnswer={canAnswer}
                onOpen={onOpen}
              />
              <div className="mb-3 flex max-w-md flex-col gap-2">
                {searchOpen && (
                  <SessionSearchField
                    id={searchId}
                    label={t('tasks.overview.find')}
                    value={query}
                    onChange={setQuery}
                    onClose={closeSearch}
                    onSubmit={() =>
                      shown[0] &&
                      onOpen(
                        shown[0].session,
                        shown[0].pane,
                        opensChat(shown[0].pane) ? 'chat' : 'terminal',
                      )
                    }
                    // A card's first button opens it
                    onArrowDown={() =>
                      listRef.current?.querySelector('button')?.focus()
                    }
                  />
                )}
                <AgentFilterBar
                  summary={summary}
                  filter={filter}
                  onChange={setFilter}
                  unit="agent"
                />
              </div>
              {shown.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center text-[13px] text-fg-muted">
                  {t('tasks.overview.noMatch')}
                  <Button
                    size="sm"
                    onClick={() => {
                      setFilter('all')
                      setQuery('')
                    }}
                  >
                    {t('tasks.overview.showAll')}
                  </Button>
                </div>
              ) : (
                <ul
                  ref={listRef}
                  className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
                >
                  {entries.map(({ item: { session, pane }, leaving }) => {
                    const group = session.groupId
                      ? groupOf.get(session.groupId)
                      : undefined
                    const named = showGroups && group
                    const where = named
                      ? `${group.name} / ${session.name}`
                      : session.name
                    return (
                      <li
                        key={pane.id}
                        ref={ref(pane.id)}
                        inert={leaving}
                        data-leaving={leaving || undefined}
                        className={`transition-[opacity,translate,scale] duration-(--duration-base) ease-standard ${isNew(pane.id) ? ENTER_FROM : ''} ${leaving ? LEAVE_TO : ''}`}
                        onBlur={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget)) {
                            setHighlighted((h) =>
                              h === pane.id ? undefined : h,
                            )
                          }
                        }}
                      >
                        <AgentCard
                          session={session}
                          pane={pane}
                          where={where}
                          groupTitle={
                            named
                              ? t('tasks.overview.groupTitle', {
                                  noun: groupNoun,
                                  name: group.name,
                                })
                              : undefined
                          }
                          worktree={group?.worktree?.linked}
                          overview={overview.panes.get(pane.id)}
                          overviewFailed={overview.error}
                          now={now}
                          paneKey={sessionPaneKey(session, pane.id)}
                          events={activity.events}
                          stuckFor={stuckFor(
                            pane.agentStatus,
                            overview.panes.get(pane.id)?.lastTs,
                            now,
                            stuckMinutes,
                          )}
                          opensChat={opensChat(pane)}
                          onOpen={onOpen}
                          openRef={
                            !leaving && pane.id === target?.paneId
                              ? targetRef
                              : undefined
                          }
                          highlighted={!leaving && pane.id === highlighted}
                        />
                      </li>
                    )
                  })}
                </ul>
              )}
              {activePaneOnly && (
                <p className="mt-4 text-[12px] text-fg-subtle">
                  {t('tasks.overview.activePaneOnly')}
                </p>
              )}
            </>
          )}
        </div>
        {logOpen && wide && (
          <aside
            aria-labelledby="overview-activity-title"
            className="flex w-80 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border px-3 py-3"
          >
            <h3
              id="overview-activity-title"
              className="text-[13px] font-semibold"
            >
              {t('tasks.activity.title')}
            </h3>
            {log}
          </aside>
        )}
      </div>
      <Sheet
        isOpen={logOpen && !wide}
        onClose={() => setLogOpen(false)}
        title={t('tasks.activity.title')}
        closeLabel={t('tasks.activity.close')}
      >
        <div className="overflow-y-auto px-4 pb-4">{log}</div>
      </Sheet>
    </section>
  )
}

const cardKey = (c: OverviewCard) => c.pane.id
