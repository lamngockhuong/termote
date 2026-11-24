import { type FormEvent, useId, useRef, useState } from 'react'
import { addJob, changeJob, removeJob } from '../hooks/use-jobs'
import {
  JOB_PRIORITIES,
  JOB_STATES,
  type Job,
  type JobField,
  type JobPriorityChoice,
  type JobState,
  RequestError,
} from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { SessionGroup } from '../types/session'
import {
  jobDependents,
  jobFinished,
  jobWorkspace,
  workspaceName,
} from '../utils/jobs'
import { serverErrorText } from '../utils/server-error'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { JOB_STATE_WORDS } from './job-card'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { SegmentedControl } from './ui/segmented-control'
import { Sheet } from './ui/sheet'

// An agent a job can be given to: its pane, its name and where it runs
export interface JobAgentChoice {
  paneId: string
  name: string
  place: string
}

interface Props {
  // The job to change; null adds a new todo job
  job: Job | null
  agents: JobAgentChoice[]
  onClose: () => void
  // Every job held: those this one can wait on
  jobs?: readonly Job[]
  // The workspaces a job can belong to
  groups?: readonly SessionGroup[]
  // The fields beyond the first ones the server takes: the editors of the
  // others are hidden (an older server)
  fields?: readonly JobField[]
}

// The server's limit on a title, in characters (maxJobTitle)
export const MAX_JOB_TITLE = 200

// The server's limit on the jobs one job waits on (maxJobAfter)
export const MAX_JOB_AFTER = 20

const PRIORITY_WORDS: Record<JobPriorityChoice, MessageKey> = {
  high: 'jobs.edit.priority.high',
  normal: 'jobs.edit.priority.normal',
  low: 'jobs.edit.priority.low',
}

const samePicks = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id))

const FIELD =
  'w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent'
const LINE = `${FIELD} h-9 pointer-coarse:h-touch`
const AREA = `${FIELD} min-h-20 py-2`

// Adds a job, or changes one: its title, prompt, note, priority, the jobs it
// waits on, its workspace, state and the agent that works on it. A new job
// is todo, with no agent: the orchestrator takes it up. A job changed
// elsewhere meanwhile is shown as it is now, for the change to be made
// again. The workspace of a job with an agent or a worktree is the one it
// was started in, and stays.
export function JobEditSheet({
  job,
  agents,
  onClose,
  jobs = [],
  groups = [],
  fields = [],
}: Props) {
  const { t } = useT()
  const ids = useId()
  const has = (f: JobField) => fields.includes(f)
  const titleRef = useRef<HTMLInputElement>(null)
  const [base, setBase] = useState(job)
  const [title, setTitle] = useState(job?.title ?? '')
  const [prompt, setPrompt] = useState(job?.prompt ?? '')
  const [note, setNote] = useState(job?.note ?? '')
  const [state, setState] = useState<JobState>(job?.state ?? 'todo')
  const [pane, setPane] = useState('')
  const [priority, setPriority] = useState<JobPriorityChoice>(
    job?.priority ?? 'normal',
  )
  const [after, setAfter] = useState<string[]>(job?.after ?? [])
  const [workspace, setWorkspace] = useState(job ? jobWorkspace(job) : '')
  const [query, setQuery] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = (j: Job) => {
    setBase(j)
    setTitle(j.title)
    setPrompt(j.prompt ?? '')
    setNote(j.note ?? '')
    setState(j.state)
    setPane('')
    setPriority(j.priority ?? 'normal')
    setAfter(j.after ?? [])
    setWorkspace(jobWorkspace(j))
  }

  const refused = (err: unknown) => {
    if (!(err instanceof RequestError)) {
      setProblem(t('jobs.edit.failed'))
      return
    }
    if (err.code === 'job_conflict' && err.job) {
      load(err.job)
      setProblem(t('jobs.edit.conflict'))
      return
    }
    if (err.code === 'job_not_found') setGone(true)
    setProblem(serverErrorText(err, t))
  }

  const save = async () => {
    const clean = title.trim()
    if (!clean) {
      setProblem(t('jobs.edit.titleEmpty'))
      titleRef.current?.focus()
      return
    }
    if ([...clean].length > MAX_JOB_TITLE) {
      setProblem(t('jobs.edit.titleLong', { max: MAX_JOB_TITLE }))
      titleRef.current?.focus()
      return
    }
    setProblem(null)
    setSaving(true)
    try {
      if (!base) {
        const order: Parameters<typeof addJob>[0] = {
          title: clean,
          prompt: prompt.trim() ? prompt : undefined,
          note: note.trim() ? note : undefined,
        }
        if (has('priority') && priority !== 'normal') order.priority = priority
        if (has('after') && after.length > 0) order.after = after
        if (has('workspace') && workspace) order.workspace = workspace
        await addJob(order)
      } else {
        const change: Parameters<typeof changeJob>[1] = {}
        if (clean !== base.title) change.title = clean
        if (prompt !== (base.prompt ?? '')) change.prompt = prompt
        if (note !== (base.note ?? '')) change.note = note
        if (state !== base.state) change.state = state
        if (pane) change.pane = pane
        if (has('priority') && priority !== (base.priority ?? 'normal'))
          change.priority = priority
        if (has('after') && !samePicks(after, base.after ?? []))
          change.after = after
        if (has('workspace') && !bound && workspace !== jobWorkspace(base))
          change.workspace = workspace
        if (Object.keys(change).length > 0) await changeJob(base, change)
      }
      onClose()
    } catch (err) {
      refused(err)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    setDeleting(false)
    try {
      await removeJob(base as Job)
      onClose()
    } catch (err) {
      refused(err)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void save()
  }

  // A job started (an agent or a worktree) keeps its workspace
  const bound = !!(base?.agent || base?.worktree)
  // The jobs it can wait on: the others not finished, and those it waits
  // on already; those waiting on it would make a cycle
  const dependents = base ? jobDependents(base.id, jobs) : new Set<string>()
  const candidates = jobs.filter(
    (j) => j.id !== base?.id && (!jobFinished(j.state) || after.includes(j.id)),
  )
  const needle = query.trim().toLowerCase()
  const shownCandidates = needle
    ? candidates.filter((j) => j.title.toLowerCase().includes(needle))
    : candidates
  const full = after.length >= MAX_JOB_AFTER
  const toggle = (id: string, on: boolean) =>
    setAfter((cur) => (on ? [...cur, id] : cur.filter((x) => x !== id)))
  // The workspaces offered, and the one it has when no group is it now
  const workspaces = groups.map((g) => g.id)
  if (workspace && !workspaces.includes(workspace)) workspaces.push(workspace)

  // An agent is picked only for a job being changed
  const endsGrants =
    pane !== '' && (base as Job).grants?.some((g) => !g.revoked) === true

  return (
    <Sheet
      isOpen
      onClose={onClose}
      title={
        base
          ? t('jobs.edit.title', { title: visibleUnsafe(base.title) })
          : t('jobs.new')
      }
      focusOnOpen={() => titleRef.current?.focus()}
    >
      <form
        onSubmit={submit}
        className="flex flex-col gap-2 overflow-y-auto p-4"
        noValidate
      >
        <label htmlFor={`${ids}-title`} className="text-sm text-fg-muted">
          {t('jobs.edit.titleLabel')}
        </label>
        <input
          ref={titleRef}
          id={`${ids}-title`}
          type="text"
          value={title}
          autoComplete="off"
          onChange={(e) => setTitle(e.target.value)}
          className={LINE}
        />
        <label htmlFor={`${ids}-prompt`} className="text-sm text-fg-muted">
          {t('jobs.edit.promptLabel')}
        </label>
        <textarea
          id={`${ids}-prompt`}
          value={prompt}
          aria-describedby={`${ids}-prompt-hint`}
          onChange={(e) => setPrompt(e.target.value)}
          className={AREA}
        />
        <p id={`${ids}-prompt-hint`} className="m-0 text-[12px] text-fg-muted">
          {t('jobs.edit.promptHint')}
        </p>
        <label htmlFor={`${ids}-note`} className="text-sm text-fg-muted">
          {t('jobs.edit.noteLabel')}
        </label>
        <textarea
          id={`${ids}-note`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={AREA}
        />
        {has('priority') && (
          <>
            {/* The group's name is its own label; this one is seen only */}
            <span aria-hidden="true" className="text-sm text-fg-muted">
              {t('jobs.edit.priorityLabel')}
            </span>
            <SegmentedControl
              label={t('jobs.edit.priorityLabel')}
              options={JOB_PRIORITIES.map((p) => ({
                value: p,
                content: t(PRIORITY_WORDS[p]),
              }))}
              value={priority}
              onChange={setPriority}
              className="self-start"
            />
          </>
        )}
        {has('workspace') && (
          <>
            <label
              htmlFor={`${ids}-workspace`}
              className="text-sm text-fg-muted"
            >
              {t('jobs.edit.workspaceLabel')}
            </label>
            <select
              id={`${ids}-workspace`}
              value={workspace}
              disabled={bound}
              aria-describedby={bound ? `${ids}-workspace-hint` : undefined}
              onChange={(e) => setWorkspace(e.target.value)}
              className={`${LINE} disabled:opacity-60`}
            >
              <option value="">{t('jobs.edit.workspaceNone')}</option>
              {workspaces.map((id) => (
                <option key={id} value={id}>
                  {workspaceName(id, groups)}
                </option>
              ))}
            </select>
            {bound && (
              <p
                id={`${ids}-workspace-hint`}
                className="m-0 text-[12px] text-fg-muted"
              >
                {t('jobs.edit.workspaceBound')}
              </p>
            )}
          </>
        )}
        {has('after') && (
          <fieldset
            aria-describedby={`${ids}-after-hint`}
            className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
          >
            <legend className="mb-2 p-0 text-sm text-fg-muted">
              {t('jobs.edit.afterLabel')}
            </legend>
            <p
              id={`${ids}-after-hint`}
              className="m-0 text-[12px] text-fg-muted"
            >
              {full
                ? t('jobs.edit.afterMax', { max: MAX_JOB_AFTER })
                : t('jobs.edit.afterHint')}
            </p>
            {candidates.length === 0 ? (
              <p className="m-0 text-[12px] text-fg-subtle">
                {t('jobs.edit.afterNone')}
              </p>
            ) : (
              <>
                <input
                  type="search"
                  value={query}
                  autoComplete="off"
                  aria-label={t('jobs.edit.afterSearch')}
                  placeholder={t('jobs.edit.afterSearch')}
                  onChange={(e) => setQuery(e.target.value)}
                  className={LINE}
                />
                {shownCandidates.length === 0 ? (
                  <p className="m-0 text-[12px] text-fg-subtle">
                    {t('jobs.edit.afterNoMatch')}
                  </p>
                ) : (
                  <ul className="m-0 flex max-h-48 list-none flex-col gap-0.5 overflow-y-auto rounded-control border border-border p-1">
                    {shownCandidates.map((j) => {
                      const picked = after.includes(j.id)
                      const cycle = dependents.has(j.id)
                      const box = `${ids}-after-${j.id}`
                      return (
                        <li key={j.id}>
                          <label
                            htmlFor={box}
                            className={`flex min-h-touch items-center gap-2 rounded-control px-2 text-sm ${cycle ? 'text-fg-subtle' : 'text-fg'}`}
                          >
                            <input
                              id={box}
                              type="checkbox"
                              checked={picked}
                              disabled={!picked && (cycle || full)}
                              aria-describedby={
                                cycle ? `${box}-cycle` : undefined
                              }
                              onChange={(e) => toggle(j.id, e.target.checked)}
                            />
                            <span className="min-w-0 flex-1 break-words">
                              {visibleUnsafe(j.title)}
                            </span>{' '}
                            {cycle ? (
                              // Its description, not part of its name
                              <span
                                id={`${box}-cycle`}
                                aria-hidden="true"
                                className="shrink-0 text-[11px]"
                              >
                                {t('jobs.edit.afterDependent')}
                              </span>
                            ) : (
                              <span className="shrink-0 text-[11px] text-fg-muted">
                                {t(JOB_STATE_WORDS[j.state])}
                              </span>
                            )}
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </>
            )}
          </fieldset>
        )}
        {base && (
          <>
            <label htmlFor={`${ids}-state`} className="text-sm text-fg-muted">
              {t('jobs.edit.stateLabel')}
            </label>
            <select
              id={`${ids}-state`}
              value={state}
              onChange={(e) => setState(e.target.value as JobState)}
              className={LINE}
            >
              {JOB_STATES.map((s) => (
                <option key={s} value={s}>
                  {t(JOB_STATE_WORDS[s])}
                </option>
              ))}
            </select>
            <label htmlFor={`${ids}-pane`} className="text-sm text-fg-muted">
              {t('jobs.edit.paneLabel')}
            </label>
            <select
              id={`${ids}-pane`}
              value={pane}
              onChange={(e) => setPane(e.target.value)}
              className={LINE}
            >
              <option value="">
                {base.agent ? t('jobs.edit.paneKeep') : t('jobs.edit.paneNone')}
              </option>
              {agents.map((a) => (
                <option key={a.paneId} value={a.paneId}>
                  {`${a.name} · ${a.place}`}
                </option>
              ))}
            </select>
            {endsGrants && (
              <p role="status" className="m-0 text-[12px] text-warning">
                {t('jobs.edit.paneEndsGrants')}
              </p>
            )}
          </>
        )}
        {problem && (
          <p role="alert" className="m-0 text-sm text-danger">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {base && !gone && (
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t('jobs.edit.delete')}
            </Button>
          )}
          <span className="flex-1" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={saving || gone}>
            {base ? t('jobs.edit.save') : t('jobs.edit.add')}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        isOpen={deleting}
        title={t('jobs.edit.deleteTitle', {
          title: visibleUnsafe(base?.title ?? ''),
        })}
        confirmLabel={t('jobs.edit.delete')}
        destructive
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(false)}
      >
        <p className="m-0">{t('jobs.edit.deleteBody')}</p>
      </ConfirmDialog>
    </Sheet>
  )
}
