import {
  ChevronDown,
  CircleArrowUp,
  CircleCheck,
  CircleHelp,
  ListTodo,
  Plus,
  X,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useJobs } from '../hooks/use-jobs'
import type { Job } from '../hooks/use-mux-api'
import { useNow } from '../hooks/use-now'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { Trans } from '../i18n/trans'
import type { SessionGroup } from '../types/session'
import { formatAgo } from '../utils/format-ago'
import {
  groupJobs,
  jobFinished,
  jobsByWorkspace,
  jobWorkspace,
  workspaceName,
} from '../utils/jobs'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { JOB_STATE_WORDS, JobCard, jobBranch } from './job-card'
import { JobDetail } from './job-detail'
import { type JobAgentChoice, JobEditSheet } from './job-edit-sheet'
import { JobGrantSheet } from './job-grant-sheet'
import {
  effectiveFilter,
  filterJobs,
  JobWorkspaceFilter,
  usePlanView,
} from './job-workspace-filter'
import { OrchestratorSetupSheet } from './orchestrator-setup-sheet'
import { OverviewAsks } from './overview-asks'
import { Button, FOCUS_RING, IconButton } from './ui/button'
import { Sheet } from './ui/sheet'

interface Props {
  // View-only: the jobs' brief data, nothing to change
  readOnly: boolean
  // The agents a job can be given to
  agents: JobAgentChoice[]
  // Opens the pane of one of agents, as its card would
  onOpenPane: (paneId: string) => void
  // A new object brings the section into view and focuses its title (a
  // job's notification was tapped); onFocused says it was done, so the
  // same request is not met again
  focus?: object
  onFocused?: () => void
  // The overview's Activity is open, and the screen wide enough for it to
  // be a column (1280px)
  activityOpen?: boolean
  wide?: boolean
  // Where a wide screen's job details go: a column beside the Overview's
  // scrolling body, as the Activity is, so the details scroll on their own
  // and the list's scrollbar is not beside theirs. None yet: no column
  detailSlot?: HTMLElement | null
  // Closes the Activity column
  onCloseActivity?: () => void
  // The workspaces: their names on the cards, and the filter's
  groups?: SessionGroup[]
}

type OpenGroup = 'unread' | 'running' | 'review' | 'todo'

const OPEN_GROUPS: readonly OpenGroup[] = [
  'unread',
  'running',
  'review',
  'todo',
]

const GROUP_WORDS: Record<OpenGroup, MessageKey> = {
  unread: 'jobs.group.unread',
  running: 'jobs.group.running',
  review: 'jobs.group.review',
  todo: 'jobs.group.todo',
}

const GROUP_NAMES: Record<OpenGroup, MessageKey> = {
  unread: 'jobs.groupName.unread',
  running: 'jobs.groupName.running',
  review: 'jobs.groupName.review',
  todo: 'jobs.groupName.todo',
}

// Each group's colour, beside its heading
const GROUP_DOT = {
  waiting: 'bg-danger',
  unread: 'bg-success',
  running: 'bg-warning',
  review: 'bg-accent',
  todo: 'bg-fg-subtle',
} as const

const TH = 'px-3 py-2 font-medium'

const NO_GROUPS: SessionGroup[] = []

// The overview's Plan: the jobs an orchestrator agent handed out, kept by
// the server (use-jobs.ts), in columns by what they need from the user
// (on a phone one under another), the finished ones in a table. A full
// client's job opens its details: beside the columns on a wide screen, in a
// sheet anywhere else.
export function OverviewJobs({
  readOnly,
  agents,
  onOpenPane,
  focus,
  onFocused,
  activityOpen,
  wide,
  detailSlot,
  onCloseActivity,
  groups = NO_GROUPS,
}: Props) {
  const { t } = useT()
  const store = useJobs()
  const now = useNow(store.clockOffset)
  const titleId = useId()
  const finishedId = useId()
  const detailTitleId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [showFinished, setShowFinished] = useState(false)
  // undefined: no editor; null: a new job
  const [editing, setEditing] = useState<Job | null | undefined>()
  const [granting, setGranting] = useState<Job | null>(null)
  // The job whose details are open, by id: read again from each read
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // The sheet on how an agent fills the Plan
  const [setupOpen, setSetupOpen] = useState(false)
  const canWrite = !readOnly && !store.readOnly
  const shown = store.loaded && !store.unavailable
  const selected = canWrite
    ? store.jobs.find((j) => j.id === selectedId)
    : undefined
  const editorOpen = editing !== undefined || granting !== null
  // The workspace shown and the grouping, unless the server keeps no
  // workspace a client sets (an older one): every job then, flat
  const [view, setView] = usePlanView()
  const byWorkspace = store.jobFields.includes('workspace')
  const filter = byWorkspace
    ? effectiveFilter(view.filter, store.jobs, groups)
    : 'all'
  const grouped = byWorkspace && view.grouped

  useEffect(() => {
    if (!focus || !shown) return
    // Shown, so the title is drawn
    const title = titleRef.current!
    title.scrollIntoView({ block: 'start' })
    title.focus()
    onFocused?.()
  }, [focus, shown, onFocused])
  // A job gone from the ledger closes its details, unless its editor shows
  // why (removed elsewhere) and is still open
  useEffect(() => {
    if (selectedId && !selected && !editorOpen) setSelectedId(null)
  }, [selectedId, selected, editorOpen])
  // A workspace with no job any more: every workspace from now on
  useEffect(() => {
    if (store.loaded && byWorkspace && filter !== view.filter)
      setView({ ...view, filter })
  }, [store.loaded, byWorkspace, filter, view, setView])
  // The Activity opened: the details make room for it
  useEffect(() => {
    if (activityOpen) setSelectedId(null)
  }, [activityOpen])

  // A machine whose Termote keeps no ledger yet: what to run there, and
  // nothing to change here
  if (store.outdated)
    return (
      <section aria-labelledby={titleId} className="flex flex-col pb-4">
        <h3 id={titleId} className="sr-only">
          {t('jobs.title')}
        </h3>
        <div className="flex flex-col items-center gap-1.5 rounded-panel border border-dashed border-border-strong px-4 py-8 text-center">
          <CircleArrowUp
            size={22}
            aria-hidden="true"
            className="text-fg-subtle"
          />
          <p className="m-0 mt-1 font-medium text-fg">
            {t('jobs.outdated.title')}
          </p>
          <p className="m-0 text-[12px] text-fg-muted">
            {t('jobs.outdated.hint')}
          </p>
        </div>
      </section>
    )
  if (store.unavailable || (!store.loaded && !store.error)) return null
  const shownJobs = filterJobs(store.jobs, filter)
  const jobGroups = groupJobs(shownJobs)
  const groupIds = groups.map((g) => g.id)
  // An ask's job opens as its card would, never closed by it
  const openJob = (id: string) => {
    setSelectedId(id)
    if (wide) onCloseActivity?.()
  }
  const choose = (job: Job) => {
    if (job.id === selectedId) {
      setSelectedId(null)
      return
    }
    setSelectedId(job.id)
    if (wide) onCloseActivity?.()
  }
  const card = (job: Job) => (
    <li key={job.id}>
      <JobCard
        job={job}
        now={now}
        onSelect={canWrite ? choose : undefined}
        selected={job.id === selected?.id}
        workspace={
          jobWorkspace(job)
            ? workspaceName(jobWorkspace(job), groups)
            : undefined
        }
      />
    </li>
  )
  const cards = (jobs: Job[]) => (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">{jobs.map(card)}</ul>
  )
  // Keyed by group, not by its heading: a count changing keeps the column,
  // and the focus on its cards
  const column = (
    group: keyof typeof GROUP_DOT,
    heading: string,
    jobs: Job[],
    empty?: string,
  ) => (
    <div key={group} className="flex min-w-0 flex-col gap-2">
      <h4 className="m-0 flex items-center gap-1.5 text-[12px] font-semibold text-fg-muted">
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${GROUP_DOT[group]}`}
        />
        {heading}
      </h4>
      {jobs.length > 0 && grouped ? (
        jobsByWorkspace(jobs, groupIds).map((w) => (
          <div key={w.workspace} className="flex flex-col gap-1.5">
            <h5 className="m-0 truncate text-[11px] font-medium text-fg-subtle">
              {w.workspace
                ? workspaceName(w.workspace, groups)
                : t('jobs.filter.none')}
            </h5>
            {cards(w.jobs)}
          </div>
        ))
      ) : jobs.length > 0 ? (
        cards(jobs)
      ) : (
        <p className="m-0 rounded-panel border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-fg-subtle">
          {empty}
        </p>
      )}
    </div>
  )
  const open =
    jobGroups.waiting.length +
    OPEN_GROUPS.reduce((n, g) => n + jobGroups[g].length, 0)
  const emptyGroups = OPEN_GROUPS.filter((g) => jobGroups[g].length === 0)

  // The finished jobs' table leaves out a column no row has a value for
  const finishedCols = {
    tree: jobGroups.finished.some((j) => jobBranch(j)),
    changes: jobGroups.finished.some((j) => j.diff),
    updated: jobGroups.finished.some((j) =>
      Number.isFinite(Date.parse(j.updated)),
    ),
  }
  const ago = (at: string) => {
    const ms = Date.parse(at)
    return Number.isFinite(ms) ? formatAgo(Math.max(0, now - ms), t) : ''
  }

  const detail = selected && (
    <JobDetail
      job={selected}
      now={now}
      onOpenPane={
        selected.live.paneId &&
        agents.some((a) => a.paneId === selected.live.paneId)
          ? onOpenPane
          : undefined
      }
      onEdit={setEditing}
      canEndGrants={store.canGrant}
      ciAvailable={store.ciAvailable}
      jobs={store.jobs}
      groups={groups}
      onOpenJob={openJob}
      onGrants={
        !jobFinished(selected.state) &&
        (selected.agent || selected.grants?.length)
          ? setGranting
          : undefined
      }
    />
  )
  const selectedTitle = selected ? visibleUnsafe(selected.title) : ''

  return (
    <section aria-labelledby={titleId} className="flex h-full gap-5">
      <div className="flex min-w-0 flex-1 flex-col gap-4 pb-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* The tab says Plan: its name is for a screen reader, and where a
            job's notification puts the focus */}
          <h3 id={titleId} ref={titleRef} tabIndex={-1} className="sr-only">
            {t('jobs.title')}
          </h3>
          {open > 0 && (
            <p className="m-0 text-fg-muted">
              {t('jobs.openCount', { count: open })}
              {emptyGroups.length > 0 && (
                <span className="text-fg-subtle">
                  {' · '}
                  {emptyGroups
                    .map((g) =>
                      t('jobs.groupEmpty', { name: t(GROUP_NAMES[g]) }),
                    )
                    .join(' · ')}
                </span>
              )}
            </p>
          )}
          <span className="flex-1" />
          {/* Every role and mode: a view-only device reads it too */}
          <IconButton
            onClick={() => setSetupOpen(true)}
            aria-label={t('jobs.setup.open')}
            title={t('jobs.setup.open')}
            className="text-fg-subtle"
          >
            <CircleHelp size={16} aria-hidden="true" />
          </IconButton>
          {canWrite && (
            <Button variant="primary" onClick={() => setEditing(null)}>
              <Plus size={14} aria-hidden="true" />
              {t('jobs.new')}
            </Button>
          )}
        </div>
        {store.error && (
          <p role="status" className="m-0 text-[12px] text-fg-muted">
            {t('jobs.readFailed')}
          </p>
        )}
        <OverviewAsks
          asks={store.asks}
          readOnly={!canWrite || store.asksReadOnly}
          outdated={store.asksOutdated}
          now={now}
          onOpenJob={canWrite ? openJob : undefined}
          openableJobs={new Set(store.jobs.map((j) => j.id))}
        />
        {byWorkspace && store.jobs.length > 0 && (
          <JobWorkspaceFilter
            jobs={store.jobs}
            groups={groups}
            view={{ filter, grouped }}
            onChange={setView}
          />
        )}
        {store.loaded && open === 0 && (
          <div className="flex flex-col items-center gap-1.5 rounded-panel border border-dashed border-border-strong px-4 py-8 text-center">
            {store.jobs.length === 0 ? (
              <ListTodo
                size={22}
                aria-hidden="true"
                className="text-fg-subtle"
              />
            ) : (
              <CircleCheck
                size={22}
                aria-hidden="true"
                className="text-success"
              />
            )}
            <p className="m-0 mt-1 font-medium text-fg">
              {store.jobs.length === 0 ? t('jobs.none') : t('jobs.noneOpen')}
            </p>
            <p className="m-0 text-[12px] text-fg-muted">
              {store.jobs.length === 0 ? (
                <Trans
                  k="jobs.noneHint"
                  tags={{
                    link: (s) => (
                      <button
                        type="button"
                        onClick={() => setSetupOpen(true)}
                        className={`text-accent hover:underline ${FOCUS_RING}`}
                      >
                        {s}
                      </button>
                    ),
                  }}
                />
              ) : (
                t('jobs.noneOpenHint')
              )}
            </p>
          </div>
        )}
        {open > 0 && (
          <>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] items-start gap-3.5">
              {column(
                'waiting',
                t('jobs.group.waiting', { count: jobGroups.waiting.length }),
                jobGroups.waiting,
                t('jobs.waitingNone'),
              )}
              {OPEN_GROUPS.map(
                (g) =>
                  jobGroups[g].length > 0 &&
                  column(
                    g,
                    t(GROUP_WORDS[g], { count: jobGroups[g].length }),
                    jobGroups[g],
                  ),
              )}
            </div>
          </>
        )}
        {jobGroups.finished.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              aria-expanded={showFinished}
              aria-controls={finishedId}
              onClick={() => setShowFinished((v) => !v)}
            >
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={showFinished ? 'rotate-180' : ''}
              />
              {t('jobs.group.finished', { count: jobGroups.finished.length })}
            </Button>
            {showFinished && (
              <div
                id={finishedId}
                className="overflow-x-auto rounded-panel border border-border bg-surface ui-terminal:bg-bg"
              >
                <table className="w-full border-collapse text-left text-[12px]">
                  <caption className="sr-only">{t('jobs.table.label')}</caption>
                  <thead className="text-fg-subtle">
                    <tr className="border-b border-border">
                      <th scope="col" className={TH}>
                        {t('jobs.table.job')}
                      </th>
                      <th scope="col" className={TH}>
                        {t('jobs.table.state')}
                      </th>
                      {finishedCols.tree && (
                        <th scope="col" className={TH}>
                          {t('jobs.table.worktree')}
                        </th>
                      )}
                      {finishedCols.changes && (
                        <th scope="col" className={TH}>
                          {t('jobs.table.changes')}
                        </th>
                      )}
                      {finishedCols.updated && (
                        <th scope="col" className={`${TH} text-right`}>
                          {t('jobs.table.updated')}
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {jobGroups.finished.map((job) => {
                      const title = visibleUnsafe(job.title)
                      const branch = jobBranch(job)
                      const isSelected = job.id === selected?.id
                      return (
                        <tr
                          key={job.id}
                          className={`border-b border-border last:border-b-0 ${isSelected ? 'bg-accent/10' : ''}`}
                        >
                          <th scope="row" className="px-2.5 py-1 font-medium">
                            {canWrite ? (
                              <button
                                type="button"
                                onClick={() => choose(job)}
                                aria-pressed={isSelected}
                                className={`min-h-touch rounded-control text-left text-accent hover:underline ${FOCUS_RING}`}
                              >
                                {title}
                              </button>
                            ) : (
                              title
                            )}
                          </th>
                          <td className="px-2.5 py-1 text-fg-muted">
                            {t(JOB_STATE_WORDS[job.state])}
                          </td>
                          {finishedCols.tree && (
                            <td className="px-2.5 py-1 font-term text-fg-muted">
                              {branch && visibleUnsafe(branch)}
                            </td>
                          )}
                          {finishedCols.changes && (
                            <td className="whitespace-nowrap px-2.5 py-1 text-fg-muted">
                              {job.diff &&
                                `${t('jobs.card.commits', { count: job.diff.commits })} · ${t('jobs.card.files', { count: job.diff.files })}`}
                            </td>
                          )}
                          {finishedCols.updated && (
                            <td className="whitespace-nowrap px-3 py-1 text-right text-fg-muted">
                              {ago(job.updated)}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      {wide &&
        detail &&
        detailSlot &&
        createPortal(
          <aside
            aria-labelledby={detailTitleId}
            className="flex w-[min(27.5rem,40%)] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface px-5 py-4 scrollbar-hover ui-terminal:bg-bg"
          >
            <div className="flex items-start gap-2">
              <h3
                id={detailTitleId}
                className="m-0 min-w-0 flex-1 break-words text-[17px] font-semibold"
              >
                {selectedTitle}
              </h3>
              <IconButton
                size="sm"
                onClick={() => setSelectedId(null)}
                aria-label={t('jobs.detail.close')}
                title={t('jobs.detail.close')}
              >
                <X size={16} aria-hidden="true" />
              </IconButton>
            </div>
            {detail}
          </aside>,
          detailSlot,
        )}
      {/* On a narrow screen a sheet, out of the way while the job's editor
        or grants show (never two modals at once) */}
      <Sheet
        isOpen={!wide && !!detail && !editorOpen}
        onClose={() => setSelectedId(null)}
        title={selectedTitle}
        closeLabel={t('jobs.detail.close')}
      >
        {/* Top padding too: the detail's status line sits 8px up to hug the
          aside's title, and would slip under the sheet's header without it */}
        <div className="overflow-y-auto p-4">{detail}</div>
      </Sheet>
      {editing !== undefined && (
        <JobEditSheet
          job={editing}
          agents={agents}
          jobs={store.jobs}
          groups={groups}
          fields={store.jobFields}
          onClose={() => setEditing(undefined)}
        />
      )}
      {granting && (
        <JobGrantSheet
          job={granting}
          canGrant={store.canGrant}
          ciAvailable={store.ciAvailable}
          now={now}
          onClose={() => setGranting(null)}
        />
      )}
      <OrchestratorSetupSheet
        isOpen={setupOpen}
        onClose={() => setSetupOpen(false)}
      />
    </section>
  )
}
