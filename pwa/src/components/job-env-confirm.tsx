import { useState } from 'react'
import { confirmJobEnv, dismissJobEnv } from '../hooks/use-jobs'
import { type Job, RequestError } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { serverErrorText } from '../utils/server-error'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'

interface Props {
  // A job whose envConfirm names files
  job: Job
  // This browser may confirm: signed in with the password or a full paired
  // device (as for a grant), and the job can change
  canConfirm: boolean
}

// The cleanup the orchestrator asked for, held back by ignored .env files
// the main checkout does not hold the same: their names (never their
// contents, which the server never sends), and the user's yes, which runs
// the cleanup and deletes them with the worktree. Only the user answers
// it here: the agent's own command cannot.
export function JobEnvConfirmNotice({ job, canConfirm }: Props) {
  const { t } = useT()
  const files = job.envConfirm?.files ?? []
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const failed = (err: unknown) =>
    setProblem(
      err instanceof RequestError
        ? serverErrorText(err, t)
        : t('jobs.envConfirm.failed'),
    )
  const confirm = async () => {
    setOpen(false)
    setBusy(true)
    setProblem(null)
    try {
      await confirmJobEnv(job)
      setDone(true)
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  const dismiss = async () => {
    setBusy(true)
    setProblem(null)
    try {
      await dismissJobEnv(job)
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-panel border border-warning/40 bg-warning/5 p-3">
      <p className="m-0 text-warning">
        {t('jobs.envConfirm.note', { count: files.length })}
      </p>
      {canConfirm ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => setOpen(true)}
            className="border border-danger/40 bg-danger/5"
          >
            {t('jobs.envConfirm.review')}
          </Button>
          <Button disabled={busy} onClick={() => void dismiss()}>
            {t('jobs.envConfirm.dismiss')}
          </Button>
        </div>
      ) : (
        <p className="m-0 text-[12px] text-fg-muted">
          {t('jobs.envConfirm.noGrant')}
        </p>
      )}
      {problem && (
        <p role="alert" className="m-0 text-[12px] text-danger">
          {problem}
        </p>
      )}
      {done && (
        <p role="status" className="m-0 text-[12px] text-fg-muted">
          {t('jobs.envConfirm.done')}
        </p>
      )}
      <ConfirmDialog
        isOpen={open}
        title={t('jobs.envConfirm.title')}
        confirmLabel={t('jobs.envConfirm.confirm')}
        destructive
        // Deleting files for good never defaults to the destructive button
        defaultAction="cancel"
        onConfirm={() => void confirm()}
        onCancel={() => setOpen(false)}
      >
        <ul className="m-0 mb-3 flex list-none flex-col gap-1 p-0 font-term text-[12px] text-fg">
          {files.map((f) => (
            <li key={f} className="break-all">
              {visibleUnsafe(f)}
            </li>
          ))}
        </ul>
        <p className="m-0">{t('jobs.envConfirm.body')}</p>
      </ConfirmDialog>
    </div>
  )
}
