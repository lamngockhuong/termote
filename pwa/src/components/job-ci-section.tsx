import { ExternalLink } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { changeJob, pinJobPRs, runJobCI } from '../hooks/use-jobs'
import { type Job, RequestError } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { formatAgo } from '../utils/format-ago'
import {
  ciErrorWords,
  ciFailKey,
  parsePRNumber,
  prChecksTone,
  prChecksWords,
  prStateWords,
} from '../utils/job-ci'
import { jobFinished } from '../utils/jobs'
import { serverErrorText } from '../utils/server-error'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'

interface Props {
  job: Job
  // Server time (ms)
  now: number
}

const FIELD =
  'h-9 w-24 min-w-0 rounded-control border border-border bg-bg px-2.5 font-term text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch'

// A job's pull requests in its details (a full client, on a server that
// follows them): each one's state and failed checks with a link to it, the
// ones attached by number with a way to detach them, a field to attach one,
// when they were read with a way to read them again, sending the failed
// checks to the job's agent, and once every one is merged or closed, a way
// to set the job done. termote never opens or merges a pull request.
export function JobCISection({ job, now }: Props) {
  const { t } = useT()
  const ids = useId()
  const [busy, setBusy] = useState<'refresh' | 'send' | 'pin' | 'done' | null>(
    null,
  )
  const [problem, setProblem] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [number, setNumber] = useState('')
  const [badNumber, setBadNumber] = useState(false)
  const ci = job.ci
  const prs = ci?.prs ?? []
  const failKey = ciFailKey(prs)
  const finished = jobFinished(job.state)
  const canSend = !!failKey && !!job.agent && !finished
  const allMerged = !!job.ciSummary?.allMerged

  const run = async (
    what: 'refresh' | 'send' | 'pin' | 'done',
    fn: () => Promise<string | null>,
  ) => {
    setBusy(what)
    setProblem(null)
    setStatus(null)
    try {
      setStatus(await fn())
    } catch (err) {
      setProblem(
        err instanceof RequestError
          ? serverErrorText(err, t)
          : t('jobs.ci.failed'),
      )
    } finally {
      setBusy(null)
    }
  }

  const send = () =>
    run('send', async () => {
      const r = await runJobCI(job, 'send')
      return r.queued ? t('jobs.ci.queued') : t('jobs.ci.sent')
    })
  const refresh = () =>
    run('refresh', async () => {
      await runJobCI(job, 'refresh')
      return null
    })
  const detach = (n: number) =>
    run('pin', async () => {
      await pinJobPRs(job, [], [n])
      return null
    })
  const attach = (e: FormEvent) => {
    e.preventDefault()
    const n = parsePRNumber(number)
    setBadNumber(n === null)
    if (n === null) return
    void run('pin', async () => {
      await pinJobPRs(job, [n], [])
      setNumber('')
      return null
    })
  }
  const setDone = () =>
    run('done', async () => {
      await changeJob(job, { state: 'done' })
      return null
    })

  const checked = job.ciChecked ? Date.parse(job.ciChecked) : Number.NaN

  return (
    <section
      aria-labelledby={`${ids}-title`}
      data-testid="job-ci"
      className="flex flex-col gap-2"
    >
      <h4
        id={`${ids}-title`}
        className="m-0 text-[12px] font-semibold text-fg-muted"
      >
        {t('jobs.ci.title')}
      </h4>
      {prs.length === 0 && !ci?.error && (
        <p className="m-0 text-[12px] text-fg-muted">{t('jobs.ci.none')}</p>
      )}
      {prs.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {prs.map((pr) => {
            const checks = prChecksWords(pr)
            return (
              <li
                key={`${pr.repo}#${pr.number}`}
                data-testid="job-pr"
                className="flex items-start gap-2.5 rounded-control border border-border px-3 py-2.5 text-[12px]"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-term font-semibold">
                      #{pr.number}
                    </span>
                    <span>{t(prStateWords(pr))}</span>
                    {checks && (
                      <span className={prChecksTone(pr)}>{t(checks)}</span>
                    )}
                    {pr.pinned && (
                      <span className="text-fg-muted">
                        {t('jobs.ci.attached')}
                      </span>
                    )}
                  </span>
                  {pr.failing && pr.failing.length > 0 && (
                    <span className="break-all font-term text-[11px] text-danger">
                      {pr.failing.map((n) => visibleUnsafe(n)).join(', ')}
                    </span>
                  )}
                  {pr.foreign && (
                    <span className="text-[11px] text-fg-muted">
                      {t('jobs.ci.foreign')}
                    </span>
                  )}
                </span>
                {pr.url && (
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('jobs.ci.open', { n: pr.number })}
                    className="inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-control text-fg-muted hover:text-fg"
                  >
                    <ExternalLink aria-hidden="true" className="size-4" />
                  </a>
                )}
                {pr.pinned && (
                  <Button
                    size="sm"
                    onClick={() => void detach(pr.number)}
                    disabled={busy !== null}
                    aria-label={t('jobs.ci.detachName', { n: pr.number })}
                  >
                    {t('jobs.ci.detach')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {ci?.error && (
        <p role="status" className="m-0 text-[12px] text-warning">
          {t(ciErrorWords(ci.error))}
        </p>
      )}
      {allMerged && (
        <div className="flex flex-col gap-2 rounded-control border border-info/40 px-3 py-2.5 text-[12px]">
          <p className="m-0">{t('jobs.ci.allMerged')}</p>
          {!finished && (
            <Button
              size="sm"
              variant="primary"
              className="self-start"
              onClick={() => void setDone()}
              disabled={busy !== null}
            >
              {t('jobs.ci.setDone')}
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canSend && (
          <Button
            variant="primary"
            onClick={() => void send()}
            disabled={busy !== null}
          >
            {busy === 'send'
              ? t('jobs.ci.sending')
              : ci?.sent === failKey
                ? t('jobs.ci.sendAgain')
                : t('jobs.ci.send')}
          </Button>
        )}
        <Button onClick={() => void refresh()} disabled={busy !== null}>
          {busy === 'refresh' ? t('jobs.ci.refreshing') : t('jobs.ci.refresh')}
        </Button>
        {Number.isFinite(checked) && (
          <span className="text-[12px] text-fg-muted">
            {t('jobs.ci.checked', {
              ago: formatAgo(Math.max(0, now - checked), t),
            })}
          </span>
        )}
      </div>
      {!finished && (
        <form onSubmit={attach} className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={`${ids}-number`}
            className="text-[12px] text-fg-muted"
          >
            {t('jobs.ci.attachLabel')}
          </label>
          <input
            id={`${ids}-number`}
            type="text"
            inputMode="numeric"
            value={number}
            placeholder="#123"
            autoComplete="off"
            aria-invalid={badNumber || undefined}
            onChange={(e) => {
              setNumber(e.target.value)
              setBadNumber(false)
            }}
            className={FIELD}
          />
          <Button size="sm" type="submit" disabled={busy !== null}>
            {t('jobs.ci.attach')}
          </Button>
        </form>
      )}
      {badNumber && (
        <p role="alert" className="m-0 text-[12px] text-danger">
          {t('jobs.ci.attachInvalid')}
        </p>
      )}
      {problem && (
        <p role="alert" className="m-0 text-[12px] text-danger">
          {problem}
        </p>
      )}
      {status && (
        <p role="status" className="m-0 text-[12px] text-fg-muted">
          {status}
        </p>
      )}
    </section>
  )
}
