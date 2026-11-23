import { History, ListChecks, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useActivityLog } from '../hooks/use-activity-log'
import { useAgentOverview } from '../hooks/use-agent-overview'
import { useJobs } from '../hooks/use-jobs'
import { useMediaQuery } from '../hooks/use-media-query'
import { ENTER_FROM, useNewKeys } from '../hooks/use-new-keys'
import { NOW_TICK, useNow } from '../hooks/use-now'
import { LEAVE_TO, usePresenceList } from '../hooks/use-presence-list'
import { useUsageSummary } from '../hooks/use-usage-summary'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type {
  AgentStatus,
  Session,
  SessionGroup,
  SessionPane,
} from '../types/session'
import { agentCards, type OverviewCard } from '../utils/agent-cards'
import { stuckFor } from '../utils/agent-stuck'
import { asksOverviewPlan } from '../utils/deep-link'
import { jobOfPane } from '../utils/job-of-pane'
import { groupJobs } from '../utils/jobs'
import { overviewOrder } from '../utils/overview-order'
import { sessionPaneKey } from '../utils/pane-remap'
import {
  matchesPaneFilter,
  type SidebarFilter,
  summarizePanes,
} from '../utils/session-filter'
import { matchesPaneQuery, searchTerms } from '../utils/session-search'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { ActivityLog } from './activity-log'
import { AgentCard, agentCardName } from './agent-card'
import { AgentFilterBar } from './agent-filter-bar'
import { NeedsMeQueue } from './needs-me-queue'
import { type DispatchTarget, OverviewDispatch } from './overview-dispatch'
import { OverviewJobs } from './overview-jobs'
import {
  type OverviewTab,
  type OverviewTabDef,
  OverviewTabs,
  overviewPanelId,
  overviewTabId,
  readOverviewTab,
  writeOverviewTab,
} from './overview-tabs'
import { OverviewUsageButton } from './overview-usage-button'
import { SearchToggle, SessionSearchField } from './session-search-field'
import {
  type SubagentTarget,
  SubagentTranscriptSheet,
} from './subagent-transcript-sheet'
import { Toast } from './toast'
import { Button, FOCUS_RING, IconButton } from './ui/button'
import { Sheet } from './ui/sheet'

// The card's time is a coarse "3 min ago", read again this often
export const OVERVIEW_TICK = NOW_TICK

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
  // Whether the server answers the agent's dialogs and takes a message for
  // it (else the terminal)
  canAnswer: (pane: SessionPane) => boolean
  // View-only: dialogs are shown, never answered, and nothing is sent
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
  // A short message (a code block copied in a subagent's conversation)
  notify?: (message: string) => void
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
  notify = noNotify,
}: Props) {
  const { t } = useT()
  const overview = useAgentOverview(pollInterval)
  const activity = useActivityLog(pollInterval)
  // Every session's tokens, today and in the last 7 days
  const usage = useUsageSummary()
  // The activity log: a column beside the cards on a wide screen, a sheet
  // anywhere else.
  const [logOpen, setLogOpen] = useState(false)
  const wide = useMediaQuery('(min-width: 1280px)')
  // Focus moves into the overview and back to where it was when it closes.
  const titleRef = useRef<HTMLHeadingElement>(null)
  // The Plan asked for by the address (a job's notification), now or once
  // open: it takes focus over the title
  const [planFocus, setPlanFocus] = useState<object | undefined>(() =>
    asksOverviewPlan(window.location.hash) ? {} : undefined,
  )
  const askedPlan = useRef(!!planFocus)
  // The tab shown: the Plan the address asks for, else Agents for a card
  // asked for, else the one this browser looked at last
  const [tab, setTab] = useState<OverviewTab>(() =>
    askedPlan.current ? 'plan' : focusPane ? 'agents' : readOverviewTab(),
  )
  // Without a job ledger there is no Plan, and no tabs
  const jobs = useJobs()
  // Known once the ledger was read (or failed to be): no tab flashes on a
  // server without one
  const hasPlan = !jobs.unavailable && (jobs.loaded || jobs.error)
  const shownTab = hasPlan ? tab : 'agents'
  const tabsId = useId()
  useEffect(() => {
    const onHashChange = (e: HashChangeEvent) => {
      const hash = e.newURL ? new URL(e.newURL).hash : window.location.hash
      if (!asksOverviewPlan(hash)) return
      setTab('plan')
      setPlanFocus({})
      // As a tab chosen by hand: the Plan has no picking
      setPicking(false)
      setPicked(new Set())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    if (!askedPlan.current) titleRef.current?.focus()
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
  const now = useNow(clockOffset)
  // A card asked for while the Plan is shown brings Agents back, and may
  // take the focus from the Plan
  const [asked, setAsked] = useState<{ pane?: object; fromPlan: boolean }>({
    pane: focusPane,
    fromPlan: false,
  })
  if (focusPane !== asked.pane) {
    setAsked({ pane: focusPane, fromPlan: !!focusPane && shownTab === 'plan' })
    if (focusPane) setTab('agents')
  }

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
  // The cards, each section named by a row before its first card (but the
  // blocked ones, under the dialogs). The cards stay in one list, so one
  // moving to another section is not drawn anew.
  const rows: ({ head: Section } | { entry: (typeof entries)[number] })[] = []
  const headed = new Set<Section>()
  for (const entry of entries) {
    const section = sectionOf(entry.item.pane.agentStatus)
    if (section !== 'blocked' && !headed.has(section)) {
      headed.add(section)
      rows.push({ head: section })
    }
    rows.push({ entry })
  }
  const sectionCount = (section: Section) =>
    shown.filter((c) => sectionOf(c.pane.agentStatus) === section).length
  // The job each card's pane works on
  const jobByPane = useMemo(() => jobOfPane(jobs.jobs), [jobs.jobs])
  const jobTitleOf = useCallback(
    (paneId: string) => jobByPane.get(paneId)?.title,
    [jobByPane],
  )
  // The card asked for takes focus once it is shown (the cards are drawn
  // only when ready), over the title, and keeps an accent border until focus
  // leaves it. A card shown after the user moved on takes nothing.
  const targetRef = useRef<HTMLButtonElement>(null)
  const focused = useRef<object>(undefined)
  const [highlighted, setHighlighted] = useState<string>()
  const target =
    ready &&
    shownTab === 'agents' &&
    focusPane &&
    shown.some((c) => c.pane.id === focusPane.paneId)
      ? focusPane
      : undefined
  const fromPlan = asked.fromPlan && asked.pane === target
  useEffect(() => {
    if (!target || focused.current === target) return
    focused.current = target
    const at = document.activeElement
    if (!fromPlan && at !== titleRef.current && at !== document.body) return
    // The target is shown, so its card holds the ref
    targetRef.current?.focus()
    setHighlighted(target.paneId)
  }, [target, fromPlan])
  // Leaving the Plan lets the card take the focus once, in the commit that
  // shows Agents: a card shown later (a filter cleared, a pane come late)
  // finds the user elsewhere
  useEffect(() => {
    if (asked.fromPlan) setAsked((a) => ({ ...a, fromPlan: false }))
  }, [asked])
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
  // The agents a job can be given to, and whose pane a job's card opens
  const jobAgents = useMemo(
    () =>
      cards.map((c) => ({
        paneId: c.pane.id,
        name: agentCardName(c.pane, t),
        place: visibleUnsafe(placeOf(c.session)),
      })),
    [cards, placeOf, t],
  )
  const openJobPane = (paneId: string) => {
    // Only the panes of jobAgents are offered
    const c = cards.find((card) => card.pane.id === paneId)!
    onOpen(c.session, c.pane, opensChat(c.pane) ? 'chat' : 'terminal')
  }
  const queueCards = useMemo(
    () => cards.map((c) => ({ ...c, where: placeOf(c.session) })),
    [cards, placeOf],
  )

  // Picking agents to send one message to: only those the server takes a
  // message for, never in view-only.
  const pickable = readOnly ? [] : cards.filter((c) => canAnswer(c.pane))
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const selecting = picking && pickable.length > 0
  // An agent whose pane went (or that can no longer take a message) is
  // unpicked, so a pane that comes back under its id is not picked again.
  const pickableKey = pickable.map(cardKey).join(' ')
  useEffect(() => {
    const ids = new Set(pickableKey.split(' '))
    setPicked((s) =>
      [...s].every((id) => ids.has(id))
        ? s
        : new Set([...s].filter((id) => ids.has(id))),
    )
  }, [pickableKey])
  const togglePick = (paneId: string, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s)
      if (on) next.add(paneId)
      else next.delete(paneId)
      return next
    })
  const targets: DispatchTarget[] = pickable
    .filter((c) => picked.has(c.pane.id))
    .map((c) => ({
      paneId: c.pane.id,
      name: agentCardName(c.pane, t),
      place: visibleUnsafe(placeOf(c.session)),
    }))
  const stopPicking = () => {
    setPicking(false)
    setPicked(new Set())
  }
  // The user's own choice of tab is remembered; leaving Agents ends picking
  const chooseTab = (next: OverviewTab) => {
    setTab(next)
    writeOverviewTab(next)
    // A Plan asked for by the address and not shown yet is not met later
    setPlanFocus(undefined)
    if (next !== 'agents') stopPicking()
  }
  const jobGroups = groupJobs(jobs.jobs)
  const openJobs =
    jobGroups.waiting.length +
    jobGroups.unread.length +
    jobGroups.running.length +
    jobGroups.review.length +
    jobGroups.todo.length
  // A tab's label carries its count ("Agents · 5", "Plan · 2 open"); its
  // name says what is counted
  const tabDef = (
    id: OverviewTab,
    name: string,
    count: string,
    countName: string,
    alert?: string,
  ): OverviewTabDef => ({
    id,
    label: t('tasks.tabs.counted', { name, count }),
    alert,
    name: [name, countName, alert].filter(Boolean).join(', '),
  })
  const tabs = [
    tabDef(
      'agents',
      t('tasks.tabs.agents'),
      String(cards.length),
      t('tasks.filter.agents', { count: cards.length }),
      summary.blocked > 0
        ? t('tasks.tabs.needsYou', { count: summary.blocked })
        : undefined,
    ),
    tabDef(
      'plan',
      t('tasks.tabs.plan'),
      t('tasks.tabs.open', { count: openJobs }),
      t('tasks.tabs.open', { count: openJobs }),
      jobGroups.waiting.length > 0
        ? t('tasks.tabs.waiting', { count: jobGroups.waiting.length })
        : undefined,
    ),
  ]
  // The panels are both drawn, the one not shown hidden, so what is open in
  // either (a dialog skipped, a History, a job's editor) outlives a switch.
  const panel = (id: OverviewTab) =>
    hasPlan
      ? {
          role: 'tabpanel',
          id: overviewPanelId(tabsId, id),
          'aria-labelledby': overviewTabId(tabsId, id),
          hidden: shownTab !== id,
        }
      : {}

  // Why a card's Stop was refused: one toast for the whole overview, the
  // latest refusal replacing the one before.
  const [stopError, setStopError] = useState<string | null>(null)
  // The subagent whose conversation is open: held here, so it stays open
  // when its card leaves the list (a filter, the agent going)
  const [subagent, setSubagent] = useState<SubagentTarget>()

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
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
        <h2
          id="overview-title"
          ref={titleRef}
          tabIndex={-1}
          className="text-[15px] font-semibold outline-none"
        >
          {t('tasks.overview.title')}
        </h2>
        {/* The tabs beside the title; on a phone a row of their own */}
        {hasPlan && (
          <div className="order-last w-full sm:order-none sm:w-auto">
            <OverviewTabs
              label={t('tasks.tabs.label')}
              tabs={tabs}
              value={shownTab}
              onChange={chooseTab}
              idPrefix={tabsId}
            />
          </div>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-0.5">
          <OverviewUsageButton
            summary={usage.summary}
            accounts={overview.accounts}
            now={now}
            clockOffset={clockOffset}
          />
          {shownTab === 'agents' && cards.length > 0 && (
            <SearchToggle
              controls={searchId}
              noun={t('tasks.overview.searchNoun')}
              open={searchOpen}
              onToggle={() =>
                searchOpen ? closeSearch() : setSearchOpen(true)
              }
            />
          )}
          {shownTab === 'agents' && pickable.length > 0 && (
            <IconButton
              onClick={() => (picking ? stopPicking() : setPicking(true))}
              aria-label={t('tasks.dispatch.select')}
              aria-pressed={picking}
              title={t('tasks.dispatch.select')}
            >
              <ListChecks size={18} aria-hidden="true" />
            </IconButton>
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
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
          {overview.error && (
            <p role="status" className="mb-3 text-[12px] text-fg-muted">
              {t('tasks.overview.readFailed')}
            </p>
          )}
          {hasPlan && (
            <div {...panel('plan')} className="flex-1">
              {ready && (
                <OverviewJobs
                  readOnly={readOnly}
                  agents={jobAgents}
                  onOpenPane={openJobPane}
                  focus={shownTab === 'plan' ? planFocus : undefined}
                  onFocused={() => setPlanFocus(undefined)}
                  activityOpen={logOpen}
                  wide={wide}
                  onCloseActivity={() => setLogOpen(false)}
                />
              )}
            </div>
          )}
          <div {...panel('agents')}>
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
                <div className="mb-4 flex max-w-xl flex-col gap-2">
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
                        listRef.current
                          ?.querySelector<HTMLElement>(
                            'li[data-card]:not([data-leaving]) button',
                          )
                          ?.focus()
                      }
                    />
                  )}
                  <AgentFilterBar
                    summary={summary}
                    filter={filter}
                    onChange={setFilter}
                    unit="agent"
                    labelled
                  />
                </div>
                {/* The dialogs to answer, whatever the filter or the search
                  shows, then the cards of those agents */}
                {summary.blocked > 0 && (
                  <>
                    <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
                      {t('tasks.overview.section.blocked', {
                        count: summary.blocked,
                      })}
                    </h3>
                    <NeedsMeQueue
                      cards={queueCards}
                      readOnly={readOnly}
                      canAnswer={canAnswer}
                      onOpen={onOpen}
                      now={now}
                      jobOf={jobTitleOf}
                    />
                  </>
                )}
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
                    className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-3"
                  >
                    {rows.map((row) => {
                      if ('head' in row) {
                        return (
                          <li
                            key={`section-${row.head}`}
                            // A heading, not one of the cards the list counts
                            role="presentation"
                            className="col-span-full pt-3"
                          >
                            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
                              {t(SECTION_WORDS[row.head], {
                                count: sectionCount(row.head),
                              })}
                            </h3>
                          </li>
                        )
                      }
                      const {
                        item: { session, pane },
                        leaving,
                      } = row.entry
                      const group = session.groupId
                        ? groupOf.get(session.groupId)
                        : undefined
                      const named = showGroups && group
                      const where = named
                        ? `${group.name} / ${session.name}`
                        : session.name
                      const card = (
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
                          canStop={!readOnly && canAnswer(pane)}
                          onStopFailed={setStopError}
                          job={jobByPane.get(pane.id)?.title}
                          // Only Claude Code's subagents have a conversation
                          // to read, never on a view-only device
                          onOpenSubagent={
                            pane.agentName === 'claude' && !readOnly
                              ? (node) => setSubagent({ paneId: pane.id, node })
                              : undefined
                          }
                        />
                      )
                      const pick = selecting && canAnswer(pane)
                      return (
                        <li
                          key={pane.id}
                          data-card
                          ref={ref(pane.id)}
                          inert={leaving}
                          aria-hidden={leaving || undefined}
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
                          {/* One shape picking or not, so the card is never
                          drawn anew (its History stays open) */}
                          <div className="flex items-start gap-1">
                            {pick && (
                              <label className="flex min-h-touch min-w-touch shrink-0 cursor-pointer items-center justify-center">
                                <input
                                  type="checkbox"
                                  checked={picked.has(pane.id)}
                                  onChange={(e) =>
                                    togglePick(pane.id, e.target.checked)
                                  }
                                  aria-label={t('tasks.dispatch.pick', {
                                    name: agentCardName(pane, t),
                                    place: visibleUnsafe(where),
                                  })}
                                  className={`size-5 accent-accent ${FOCUS_RING}`}
                                />
                              </label>
                            )}
                            <div className="min-w-0 flex-1">{card}</div>
                          </div>
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
      {selecting && shownTab === 'agents' && (
        <OverviewDispatch
          targets={targets}
          onDelivered={(ids) =>
            setPicked((s) => new Set([...s].filter((id) => !ids.includes(id))))
          }
          onRemove={(id) => togglePick(id, false)}
          onClear={() => setPicked(new Set())}
        />
      )}
      <Sheet
        isOpen={logOpen && !wide}
        onClose={() => setLogOpen(false)}
        title={t('tasks.activity.title')}
        closeLabel={t('tasks.activity.close')}
      >
        <div className="overflow-y-auto px-4 pb-4">{log}</div>
      </Sheet>
      <SubagentTranscriptSheet
        target={subagent}
        onClose={() => setSubagent(undefined)}
        notify={notify}
        clockOffset={clockOffset}
      />
      {stopError && (
        <Toast
          variant="warning"
          message={stopError}
          onClose={() => setStopError(null)}
        />
      )}
    </section>
  )
}

const cardKey = (c: OverviewCard) => c.pane.id

type Section = 'blocked' | 'working' | 'done' | 'idle'

// The Agents tab's section of an agent; one without a status is idle
const sectionOf = (status?: AgentStatus): Section =>
  status === 'blocked' || status === 'working' || status === 'done'
    ? status
    : 'idle'

const SECTION_WORDS = {
  blocked: 'tasks.overview.section.blocked',
  working: 'tasks.overview.section.working',
  done: 'tasks.overview.section.done',
  idle: 'tasks.overview.section.idle',
} as const satisfies Record<Section, MessageKey>

const noNotify = () => {}
