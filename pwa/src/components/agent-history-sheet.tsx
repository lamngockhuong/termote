import { ArrowLeft } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { NotifyOptions } from '../app-views'
import {
  agentLabel,
  reportedCostAgent,
  sessionFilesAgent,
} from '../chat-agents'
import { useAgentHistory } from '../hooks/use-agent-history'
import { useHistoryClose } from '../hooks/use-history-close'
import type {
  HistoryAgent,
  HistorySession,
  ResumeWhere,
} from '../hooks/use-mux-api'
import { useResumeSession } from '../hooks/use-resume-session'
import { useSessionUsage } from '../hooks/use-session-usage'
import { useUsageSummary } from '../hooks/use-usage-summary'
import { useT } from '../i18n/i18n-context'
import { AgentHistoryRow, HistoryTitle } from './agent-history-row'
import { HistoryTranscriptView } from './history-transcript-view'
import { ReadOnlyBar } from './read-only-bar'
import { SessionSearchField } from './session-search-field'
import { SessionUsageLine } from './session-usage-line'
import { TouchedFilesSection, type TouchedTarget } from './touched-files-list'
import { Button, IconButton } from './ui/button'
import { Sheet } from './ui/sheet'
import { UsageTotalsStrip } from './usage-totals-strip'

// The agents the history can list, in the order its filter shows them
const HISTORY_AGENTS: HistoryAgent[] = ['claude', 'codex', 'opencode']

// What the history is opened on: a pane, and a session to show at once
export interface HistoryTarget {
  paneId: string
  // Resume here is offered: the page stands on this pane, an idle shell
  here: boolean
  open?: HistorySession
}

export interface LiveTab {
  tabId: string
  paneId: string
}

export interface AgentHistorySheetProps {
  target: HistoryTarget | null
  readOnly: boolean
  // The server can resume a session (it runs tasks)
  canResume: boolean
  onClose: () => void
  notify: (message: string, options?: NotifyOptions) => void
  // Resumed: the tab and pane it runs in, and where it was asked to
  onResumed: (result: LiveTab, where: ResumeWhere) => void
  // Shows the tab a session runs in
  onOpenLive: (live: LiveTab) => void
  // Opens a path of a transcript in the Files view of the pane
  openFile?: (paneId: string, path: string, line?: number) => Promise<void>
  // Opens a file a session changed: its diff in Changes, or the file in
  // Files, of the pane's root
  openTouched?: (paneId: string, target: TouchedTarget, root: string) => void
}

// The sessions of Claude Code and Codex that ran in a pane's folder: a
// list to search, each read as the Chat view reads one, then resumed in a
// new tab, in the pane itself, or (running elsewhere) opened or forked.
export function AgentHistorySheet({
  target,
  onClose,
  ...rest
}: AgentHistorySheetProps) {
  const { t } = useT()
  return (
    <Sheet
      isOpen={!!target}
      onClose={onClose}
      title={t('chat.history.title')}
      className="max-w-2xl!"
    >
      {target && (
        <HistoryContent
          key={`${target.paneId}\0${target.open?.id ?? ''}`}
          target={target}
          onClose={onClose}
          {...rest}
        />
      )}
    </Sheet>
  )
}

function HistoryContent({
  target,
  readOnly,
  canResume,
  onClose,
  notify,
  onResumed,
  onOpenLive,
  openFile,
  openTouched,
}: Omit<AgentHistorySheetProps, 'target'> & { target: HistoryTarget }) {
  const { t } = useT()
  const history = useAgentHistory(target.paneId)
  // The folder's totals; hidden when this device may not read them
  const usage = useUsageSummary(target.paneId)
  const [query, setQuery] = useState('')
  const [agent, setAgent] = useState<HistoryAgent>()
  const [selected, setSelected] = useState<HistorySession | undefined>(
    target.open,
  )
  // The row last opened, focused again on coming back to the list
  const lastOpened = useRef<string>(undefined)
  const listRef = useRef<HTMLDivElement>(null)
  const now = useMemo(() => Date.now(), [])

  const agents = new Set(history.sessions.map((s) => s.agent))
  const q = query.trim().toLowerCase()
  const shown = history.sessions.filter(
    (s) =>
      (!agent || s.agent === agent) &&
      (!q ||
        s.title.toLowerCase().includes(q) ||
        !!s.branch?.toLowerCase().includes(q)),
  )

  // Back on the list: the row that was open takes focus
  useEffect(() => {
    if (selected || !lastOpened.current) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-history-id="${lastOpened.current}"]`)
      ?.focus()
  }, [selected])

  const open = (s: HistorySession) => {
    lastOpened.current = s.id
    setSelected(s)
  }
  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = [
      ...e.currentTarget.querySelectorAll<HTMLElement>('[data-history-id]'),
    ]
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const next = rows[at + (e.key === 'ArrowDown' ? 1 : -1)] ?? rows[0]
    next?.focus()
    e.preventDefault()
  }

  const done = useCallback(
    (result: LiveTab, where: ResumeWhere) => {
      onClose()
      onResumed(result, where)
    },
    [onClose, onResumed],
  )
  const { pending, resume } = useResumeSession({
    notify,
    onResumed: done,
    // The list's row is what the open session reads from
    onLive: history.setLive,
  })

  if (selected) {
    // The list's copy is the newest (marked running since)
    const s = history.sessions.find((x) => x.id === selected.id) ?? selected
    return (
      <SessionScreen
        session={s}
        paneId={target.paneId}
        onBack={() => setSelected(undefined)}
        notify={notify}
        openFile={openFile}
        openTouched={openTouched}
        actions={
          readOnly ? (
            <ReadOnlyBar label={t('chat.history.readOnly')} />
          ) : canResume ? (
            <ResumeBar
              session={s}
              here={target.here}
              pending={pending === s.id}
              onResume={(where, fork) => resume(target.paneId, s, where, fork)}
              onOpenLive={(live) => {
                onClose()
                onOpenLive(live)
              }}
            />
          ) : undefined
        }
      />
    )
  }

  if (!history.loaded) {
    return (
      <p className="p-6 text-center text-fg-muted" role="status">
        {t('chat.history.loading')}
      </p>
    )
  }
  if (history.error && history.sessions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center text-fg-muted">
        <p role="alert">
          {history.error === 'view-only'
            ? t('chat.history.viewOnly')
            : t('chat.history.failed')}
        </p>
        {history.error === 'failed' && (
          <Button size="sm" onClick={history.retry}>
            {t('chat.history.retry')}
          </Button>
        )}
      </div>
    )
  }
  if (history.sessions.length === 0) {
    return (
      <p className="p-6 text-center text-fg-muted">{t('chat.history.empty')}</p>
    )
  }
  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 space-y-2 border-b border-border bg-bg px-4 py-3 ui-native:bg-surface">
        <SessionSearchField
          id="history-search"
          label={t('chat.history.search')}
          value={query}
          onChange={setQuery}
          onClose={() => setQuery('')}
          onSubmit={() => shown[0] && open(shown[0])}
          onArrowDown={() =>
            listRef.current
              ?.querySelector<HTMLElement>('[data-history-id]')
              ?.focus()
          }
          autoFocus={false}
        />
        {agents.size > 1 && (
          <fieldset className="flex gap-2">
            <legend className="sr-only">{t('chat.history.title')}</legend>
            {[undefined, ...HISTORY_AGENTS.filter((a) => agents.has(a))].map(
              (a) => (
                <Button
                  key={a ?? 'all'}
                  size="sm"
                  variant={agent === a ? 'primary' : 'secondary'}
                  aria-pressed={agent === a}
                  onClick={() => setAgent(a)}
                >
                  {a ? agentLabel(a) : t('chat.history.all')}
                </Button>
              ),
            )}
          </fieldset>
        )}
      </div>
      <UsageTotalsStrip
        summary={usage.summary}
        now={now}
        className="mx-4 mt-3"
      />
      {/* Arrow keys move between the row buttons */}
      <div
        ref={listRef}
        onKeyDown={onListKey}
        className="divide-y divide-border"
      >
        {shown.map((s) => (
          <AgentHistoryRow key={s.id} session={s} now={now} onOpen={open} />
        ))}
      </div>
      {shown.length === 0 && (
        <p className="p-6 text-center text-fg-muted">
          {t('chat.history.noMatch')}
        </p>
      )}
      {(history.hasMore || history.truncated) && (
        <div className="flex flex-col items-center gap-2 p-4 text-[12px] text-fg-muted">
          {history.hasMore && (
            <Button
              size="sm"
              disabled={history.loadingMore}
              onClick={history.loadMore}
            >
              {history.loadingMore
                ? t('chat.view.loadingOlder')
                : t('chat.history.loadMore')}
            </Button>
          )}
          {history.truncated && !history.hasMore && (
            <p>{t('chat.history.truncated')}</p>
          )}
        </div>
      )}
    </div>
  )
}

// One session read: a header with the way back, its transcript, and the
// actions under it. Back (the browser's, a gesture) returns to the list.
function SessionScreen({
  session,
  paneId,
  onBack,
  notify,
  openFile,
  openTouched,
  actions,
}: {
  session: HistorySession
  paneId: string
  onBack: () => void
  notify: (message: string) => void
  openFile?: AgentHistorySheetProps['openFile']
  openTouched?: AgentHistorySheetProps['openTouched']
  actions?: ReactNode
}) {
  const { t } = useT()
  const back = useHistoryClose(onBack)
  const usage = useSessionUsage(paneId, session.agent, session.id)
  const open = useMemo(
    () =>
      openFile
        ? (path: string, line?: number) => openFile(paneId, path, line)
        : undefined,
    [openFile, paneId],
  )
  return (
    <div className="flex h-[min(75vh,48rem)] flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <IconButton
          size="sm"
          aria-label={t('chat.history.back')}
          onClick={back}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </IconButton>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium">
            <HistoryTitle session={session} />
          </span>
          {usage && (
            <SessionUsageLine
              tokens={usage.tokens.total}
              costUsd={usage.costUsd}
              unpricedTokens={usage.unpricedTokens}
              unpricedModels={usage.unpricedModels}
              subTokens={usage.sub?.tokens}
              subCostUsd={usage.sub?.costUsd}
              pricesUpdated={usage.pricesUpdated}
              history
              reported={reportedCostAgent(session.agent)}
              className="text-[12px] text-fg-muted"
            />
          )}
        </span>
      </div>
      {openTouched && sessionFilesAgent(session.agent) && (
        <TouchedFilesSection
          paneId={paneId}
          agent={session.agent}
          sessionId={session.id}
          onOpen={(target, root) => openTouched(paneId, target, root)}
        />
      )}
      <HistoryTranscriptView
        paneId={paneId}
        agent={session.agent}
        sessionId={session.id}
        notify={notify}
        openFile={open}
      />
      {actions}
    </div>
  )
}

// What can be done with a session read: resume a stopped one (a new tab,
// or this pane when it is an idle shell), or open or fork a running one.
function ResumeBar({
  session,
  here,
  pending,
  onResume,
  onOpenLive,
}: {
  session: HistorySession
  here: boolean
  pending: boolean
  onResume: (where: ResumeWhere, fork?: boolean) => void
  onOpenLive: (live: LiveTab) => void
}) {
  const { t } = useT()
  const live = session.live
  return (
    <div className="shrink-0 space-y-2 border-t border-border bg-surface px-3 py-2 ui-terminal:bg-bg">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {pending && (
          <span role="status" className="mr-auto text-[13px] text-fg-muted">
            {t('chat.history.resuming')}
          </span>
        )}
        {live ? (
          <>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => onResume('tab', true)}
            >
              {t('chat.history.fork')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={() => onOpenLive(live)}
            >
              {t('chat.history.openLive')}
            </Button>
          </>
        ) : (
          <>
            {here && (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => onResume('here')}
              >
                {t('chat.history.resumeHere')}
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={() => onResume('tab')}
            >
              {t('chat.history.resumeTab')}
            </Button>
          </>
        )}
      </div>
      {live && (
        <p className="text-right text-[12px] text-fg-muted">
          {t('chat.history.forkHint')}
        </p>
      )}
    </div>
  )
}
