import { ChevronDown, Plus } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useJobs } from '../hooks/use-jobs'
import type { Job } from '../hooks/use-mux-api'
import { useNow } from '../hooks/use-now'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { groupJobs, jobFinished } from '../utils/jobs'
import { JobCard } from './job-card'
import { type JobAgentChoice, JobEditSheet } from './job-edit-sheet'
import { JobGrantSheet } from './job-grant-sheet'
import { Button } from './ui/button'

interface Props {
  // View-only: the jobs' brief data, nothing to change
  readOnly: boolean
  // The agents a job can be given to
  agents: JobAgentChoice[]
  // Opens the pane of one of agents, as its card would
  onOpenPane: (paneId: string) => void
  // A new object brings the section into view and focuses its title (a
  // job's notification was tapped)
  focus?: object
}

// The overview's Plan: the jobs an orchestrator agent handed out, kept by
// the server (use-jobs.ts), grouped by what they need from the user. On a
// desktop the groups are columns, on a phone one list under another.
export function OverviewJobs({ readOnly, agents, onOpenPane, focus }: Props) {
  const { t } = useT()
  const store = useJobs()
  const now = useNow(store.clockOffset)
  const titleId = useId()
  const finishedId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [showFinished, setShowFinished] = useState(false)
  // undefined: no editor; null: a new job
  const [editing, setEditing] = useState<Job | null | undefined>()
  const [granting, setGranting] = useState<Job | null>(null)
  const canWrite = !readOnly && !store.readOnly
  const shown = store.loaded && !store.unavailable

  useEffect(() => {
    if (!focus || !shown) return
    // Shown, so the title is drawn
    const title = titleRef.current!
    title.scrollIntoView({ block: 'start' })
    title.focus()
  }, [focus, shown])

  if (store.unavailable || (!store.loaded && !store.error)) return null
  const groups = groupJobs(store.jobs)
  const card = (job: Job) => {
    const finished = jobFinished(job.state)
    return (
      <li key={job.id}>
        <JobCard
          job={job}
          now={now}
          onOpenPane={
            job.live.paneId && agents.some((a) => a.paneId === job.live.paneId)
              ? onOpenPane
              : undefined
          }
          onEdit={canWrite ? setEditing : undefined}
          onGrants={
            canWrite && !finished && (job.agent || job.grants?.length)
              ? setGranting
              : undefined
          }
        />
      </li>
    )
  }
  const column = (key: MessageKey, jobs: Job[]) =>
    jobs.length > 0 && (
      <div className="flex min-w-0 flex-col gap-1.5">
        <h4 className="m-0 text-[12px] font-semibold text-fg-muted">
          {t(key, { count: jobs.length })}
        </h4>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {jobs.map(card)}
        </ul>
      </div>
    )
  const open =
    groups.waiting.length +
    groups.unread.length +
    groups.running.length +
    groups.review.length +
    groups.todo.length

  return (
    <section aria-labelledby={titleId} className="mb-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          className="m-0 flex-1 text-[13px] font-semibold outline-none"
        >
          {t('jobs.title')}
        </h3>
        {canWrite && (
          <Button size="sm" onClick={() => setEditing(null)}>
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
      {store.loaded && open === 0 && (
        <p className="m-0 text-[12px] text-fg-muted">
          {store.jobs.length === 0 ? t('jobs.none') : t('jobs.noneOpen')}
        </p>
      )}
      {open > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
          {column('jobs.group.waiting', groups.waiting)}
          {column('jobs.group.unread', groups.unread)}
          {column('jobs.group.running', groups.running)}
          {column('jobs.group.review', groups.review)}
          {column('jobs.group.todo', groups.todo)}
        </div>
      )}
      {groups.finished.length > 0 && (
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
            {t('jobs.group.finished', { count: groups.finished.length })}
          </Button>
          {showFinished && (
            <ul
              id={finishedId}
              className="m-0 grid list-none grid-cols-1 gap-2 p-0 md:grid-cols-2 xl:grid-cols-3"
            >
              {groups.finished.map(card)}
            </ul>
          )}
        </div>
      )}
      {editing !== undefined && (
        <JobEditSheet
          job={editing}
          agents={agents}
          onClose={() => setEditing(undefined)}
        />
      )}
      {granting && (
        <JobGrantSheet
          job={granting}
          canGrant={store.canGrant}
          now={now}
          onClose={() => setGranting(null)}
        />
      )}
    </section>
  )
}
