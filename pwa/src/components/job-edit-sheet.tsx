import { type FormEvent, useId, useRef, useState } from 'react'
import { addJob, changeJob, removeJob } from '../hooks/use-jobs'
import {
  JOB_STATES,
  type Job,
  type JobState,
  RequestError,
} from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { serverErrorText } from '../utils/server-error'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { JOB_STATE_WORDS } from './job-card'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
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
}

// The server's limit on a title, in characters (maxJobTitle)
export const MAX_JOB_TITLE = 200

const FIELD =
  'w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent'
const LINE = `${FIELD} h-9 pointer-coarse:h-touch`
const AREA = `${FIELD} min-h-20 py-2`

// Adds a job, or changes one: its title, prompt, note, state and the agent
// that works on it. A new job is todo, with no agent: the orchestrator takes
// it up. A job changed elsewhere meanwhile is shown as it is now, for the
// change to be made again.
export function JobEditSheet({ job, agents, onClose }: Props) {
  const { t } = useT()
  const ids = useId()
  const titleRef = useRef<HTMLInputElement>(null)
  const [base, setBase] = useState(job)
  const [title, setTitle] = useState(job?.title ?? '')
  const [prompt, setPrompt] = useState(job?.prompt ?? '')
  const [note, setNote] = useState(job?.note ?? '')
  const [state, setState] = useState<JobState>(job?.state ?? 'todo')
  const [pane, setPane] = useState('')
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
        await addJob({
          title: clean,
          prompt: prompt.trim() ? prompt : undefined,
          note: note.trim() ? note : undefined,
        })
      } else {
        const change: Parameters<typeof changeJob>[1] = {}
        if (clean !== base.title) change.title = clean
        if (prompt !== (base.prompt ?? '')) change.prompt = prompt
        if (note !== (base.note ?? '')) change.note = note
        if (state !== base.state) change.state = state
        if (pane) change.pane = pane
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
