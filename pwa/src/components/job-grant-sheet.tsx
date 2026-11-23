import { KeyRound } from 'lucide-react'
import { type FormEvent, useId, useRef, useState } from 'react'
import { grantJob, revokeJobGrant, useCurrentJob } from '../hooks/use-jobs'
import {
  type GrantKind,
  type Job,
  type JobGrant,
  RequestError,
} from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import {
  grantPrefixProblem,
  grantPrefixTooWide,
  MAX_GRANT_PREFIX,
  type PrefixProblem,
} from '../utils/grant-prefix'
import {
  activeGrants,
  grantLabel,
  grantLeft,
  jobFinished,
  jobPaneRef,
} from '../utils/jobs'
import { serverErrorText } from '../utils/server-error'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { SegmentedControl } from './ui/segmented-control'
import { Sheet } from './ui/sheet'

interface Props {
  job: Job
  // This browser may give and end grants (JobList.canGrant)
  canGrant: boolean
  // Server time (ms)
  now: number
  onClose: () => void
}

// How long a grant lasts, in minutes: the last one is the server's most,
// and a grant also ends with its job
export const GRANT_MINUTES = [30, 60, 240, 480, 1440] as const
const MOST_MINUTES = 1440

const PROBLEM_WORDS: Record<Exclude<PrefixProblem, 'empty'>, MessageKey> = {
  length: 'jobs.grant.problem.length',
  chars: 'jobs.grant.problem.chars',
  interpreter: 'jobs.grant.problem.interpreter',
}

const FIELD =
  'h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch'

// The grants of one job: those in force, each with the pane and folder it
// is pinned to and a way to end it, and a form to give one more. The user
// types the prefix: nothing fills it from what the agent asked.
export function JobGrantSheet({ job: given, canGrant, now, onClose }: Props) {
  const { t } = useT()
  const job = useCurrentJob(given)
  const ids = useId()
  const prefixRef = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<GrantKind>('bash')
  const [prefix, setPrefix] = useState('')
  const [minutes, setMinutes] = useState<number>(MOST_MINUTES)
  const [tried, setTried] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [revoking, setRevoking] = useState<JobGrant | null>(null)

  const grants = activeGrants(job, now)
  const ref = jobPaneRef(job)
  const dir = job.worktree?.dir
  const canGive = canGrant && !jobFinished(job.state) && !!job.agent
  const check = kind === 'bash' ? grantPrefixProblem(prefix) : null
  const showCheck = check && (check !== 'empty' || tried)
  // An edit grant covers the worktree; the server refuses one while the
  // job's agent works in another folder
  const outside = !!dir && !!job.live.outsideWorktree
  const editBlocked = kind === 'edit' && (!dir || outside)

  const left = (expires: string) => grantLeft(expires, now, t)

  const refused = (err: unknown) =>
    setProblem(
      err instanceof RequestError
        ? serverErrorText(err, t)
        : t('jobs.grant.failed'),
    )

  const give = async (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    setDone(null)
    if (check) {
      prefixRef.current!.focus()
      return
    }
    setProblem(null)
    setSaving(true)
    try {
      await grantJob(job, {
        kind,
        prefix: kind === 'bash' ? prefix.trim() : undefined,
        minutes,
      })
      setPrefix('')
      setTried(false)
      setDone(t('jobs.grant.given'))
    } catch (err) {
      refused(err)
    } finally {
      setSaving(false)
    }
  }

  const revoke = async (g: JobGrant) => {
    setRevoking(null)
    setDone(null)
    try {
      await revokeJobGrant(job, g.id)
      setProblem(null)
      setDone(t('jobs.grant.revoked'))
    } catch (err) {
      refused(err)
    }
  }

  return (
    <Sheet
      isOpen
      onClose={onClose}
      title={t('jobs.grant.title', { title: visibleUnsafe(job.title) })}
    >
      <div className="flex flex-col gap-3 overflow-y-auto p-4 text-sm">
        <p className="m-0 text-fg-muted">{t('jobs.grant.intro')}</p>
        {!canGrant && (
          <p role="note" className="m-0 text-fg-muted">
            {t('jobs.grant.cannot')}
          </p>
        )}
        <section aria-labelledby={`${ids}-active`}>
          <h3
            id={`${ids}-active`}
            className="m-0 mb-1 text-[13px] font-semibold"
          >
            {t('jobs.grant.active')}
          </h3>
          {grants.length === 0 ? (
            <p className="m-0 text-fg-muted">{t('jobs.grant.none')}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {grants.map((g) => {
                const label = grantLabel(g, t)
                return (
                  <li
                    key={g.id}
                    className="flex items-start gap-2 rounded-control border border-border p-2"
                  >
                    <KeyRound
                      size={16}
                      aria-hidden="true"
                      className="mt-0.5 shrink-0 text-accent"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="m-0 break-all font-term text-[13px]">
                        {label}
                      </p>
                      <p className="m-0 text-[12px] text-fg-muted">
                        {t('jobs.grant.pinnedPane', {
                          ref: visibleUnsafe(g.agent.ref || g.agent.paneId),
                        })}
                      </p>
                      {g.dir && (
                        <p className="m-0 break-all text-[12px] text-fg-muted">
                          {t('jobs.grant.pinnedDir', {
                            dir: visibleUnsafe(g.dir),
                          })}
                        </p>
                      )}
                      <p className="m-0 text-[12px] text-fg-muted">
                        {left(g.expires)}
                        {' · '}
                        {t('jobs.grant.uses', {
                          count: g.uses?.length ?? 0,
                        })}
                      </p>
                    </div>
                    {canGrant && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setRevoking(g)}
                        aria-label={t('jobs.grant.revokeName', { label })}
                      >
                        {t('jobs.grant.revoke')}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        {canGive && (
          <form
            onSubmit={give}
            noValidate
            aria-labelledby={`${ids}-new`}
            className="flex flex-col gap-2 border-t border-border pt-3"
          >
            <h3 id={`${ids}-new`} className="m-0 text-[13px] font-semibold">
              {t('jobs.grant.new')}
            </h3>
            <p className="m-0 text-[12px] text-fg-muted">
              {dir
                ? t('jobs.grant.pinnedBoth', { ref, dir: visibleUnsafe(dir) })
                : t('jobs.grant.pinnedPane', { ref })}
            </p>
            <SegmentedControl
              label={t('jobs.grant.kind')}
              value={kind}
              onChange={(k) => {
                setKind(k)
                setProblem(null)
              }}
              options={[
                { value: 'bash', content: t('jobs.grant.kindBash') },
                { value: 'edit', content: t('jobs.grant.kindEdit') },
              ]}
            />
            {kind === 'bash' ? (
              <>
                <label
                  htmlFor={`${ids}-prefix`}
                  className="text-sm text-fg-muted"
                >
                  {t('jobs.grant.prefix')}
                </label>
                <input
                  ref={prefixRef}
                  id={`${ids}-prefix`}
                  type="text"
                  value={prefix}
                  maxLength={MAX_GRANT_PREFIX * 2}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  aria-invalid={showCheck ? true : undefined}
                  aria-describedby={`${ids}-prefix-hint`}
                  onChange={(e) => setPrefix(e.target.value)}
                  className={`${FIELD} font-term text-[13px]`}
                />
                <p
                  id={`${ids}-prefix-hint`}
                  className="m-0 text-[12px] text-fg-muted"
                >
                  {t('jobs.grant.prefixHint')}
                </p>
                {showCheck && (
                  <p role="alert" className="m-0 text-[12px] text-danger">
                    {check === 'empty'
                      ? t('jobs.grant.problem.empty')
                      : t(PROBLEM_WORDS[check])}
                  </p>
                )}
                {!check && grantPrefixTooWide(prefix) && (
                  <p role="status" className="m-0 text-[12px] text-warning">
                    {t('jobs.grant.oneWord', {
                      word: visibleUnsafe(prefix.trim()),
                    })}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="m-0 text-[12px] text-fg-muted">
                  {outside
                    ? t('jobs.grant.editOutsideWorktree')
                    : dir
                      ? t('jobs.grant.editHint')
                      : t('jobs.grant.editNeedsWorktree')}
                </p>
                <p className="m-0 text-[12px] text-fg-muted">
                  {t('jobs.grant.editDenied')}
                </p>
              </>
            )}
            <label htmlFor={`${ids}-minutes`} className="text-sm text-fg-muted">
              {t('jobs.grant.duration')}
            </label>
            <select
              id={`${ids}-minutes`}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className={FIELD}
            >
              {GRANT_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m === MOST_MINUTES
                    ? t('jobs.grant.untilDone')
                    : m < 60
                      ? t('jobs.grant.forMinutes', { n: m })
                      : t('jobs.grant.forHours', { count: m / 60 })}
                </option>
              ))}
            </select>
            <Button
              type="submit"
              variant="primary"
              className="self-end"
              disabled={saving || editBlocked}
            >
              {t('jobs.grant.give')}
            </Button>
          </form>
        )}
        {canGrant && !canGive && (
          <p className="m-0 text-[12px] text-fg-muted">
            {t('jobs.grant.noAgent')}
          </p>
        )}
        {problem && (
          <p role="alert" className="m-0 text-sm text-danger">
            {problem}
          </p>
        )}
        {done && (
          <p role="status" className="m-0 text-sm text-fg-muted">
            {done}
          </p>
        )}
      </div>
      <ConfirmDialog
        isOpen={!!revoking}
        title={t('jobs.grant.revokeTitle')}
        confirmLabel={t('jobs.grant.revoke')}
        destructive
        onConfirm={() => void revoke(revoking as JobGrant)}
        onCancel={() => setRevoking(null)}
      >
        <p className="m-0 break-all">{revoking && grantLabel(revoking, t)}</p>
      </ConfirmDialog>
    </Sheet>
  )
}
