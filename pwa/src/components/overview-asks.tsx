import { MessageCircleQuestion } from 'lucide-react'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { answerQuestion } from '../hooks/use-jobs'
import { type Ask, RequestError } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { serverErrorText } from '../utils/server-error'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { statusAge } from './agent-card'
import { Button, FOCUS_RING } from './ui/button'

interface Props {
  // Every ask read, answered ones too: only the open ones show
  asks: Ask[]
  // View-only: how many wait, and their ids, never what they ask
  readOnly: boolean
  // Now on the server's clock (ms)
  now: number
  // Opens the details of the job an ask is about, by its id; absent when
  // that job cannot be opened here
  onOpenJob?: (jobId: string) => void
  // The job ids onOpenJob can open
  openableJobs?: ReadonlySet<string>
}

// How long the note that an answer went out stays (ms)
const NOTICE_MS = 8000

const FIELD =
  'w-full min-w-0 rounded-control border border-border bg-bg px-2.5 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent disabled:opacity-50'

// The questions orchestrator agents asked the user (termote agents ask),
// above the Plan's columns. A full client answers one with a choice or with
// text, typed into the orchestrator's input box by the server; a view-only
// device only learns that some wait. What an agent wrote is shown as plain
// text: never markdown, never a link, its unsafe characters marked.
export function OverviewAsks({
  asks,
  readOnly,
  now,
  onOpenJob,
  openableJobs,
}: Props) {
  const { t } = useT()
  const titleId = useId()
  // What the last answer sent says, kept a moment after its ask is gone
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const open = asks.filter((a) => a.state === 'open')
  if (open.length === 0 && !notice) return null

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-panel border border-danger/40 bg-surface p-3 ui-terminal:bg-bg"
    >
      <h4
        id={titleId}
        className="m-0 flex items-center gap-1.5 text-[12px] font-semibold text-fg-muted"
      >
        <MessageCircleQuestion
          size={14}
          aria-hidden="true"
          className="text-danger"
        />
        {t('jobs.asks.title')}
      </h4>
      {readOnly
        ? open.length > 0 && (
            <>
              <p className="m-0 text-[13px] text-fg-muted">
                {t('jobs.asks.viewOnly', { count: open.length })}
              </p>
              <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {open.map((a) => (
                  <li
                    key={a.id}
                    className="rounded-control border border-border px-2 py-0.5 font-term text-[12px] text-fg-muted"
                  >
                    {visibleUnsafe(a.id)}
                  </li>
                ))}
              </ul>
            </>
          )
        : open.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {open.map((a) => (
                <li key={a.id}>
                  <AskCard
                    ask={a}
                    now={now}
                    onOpenJob={
                      a.job && openableJobs?.has(a.job) ? onOpenJob : undefined
                    }
                    onSent={(queued) =>
                      setNotice(
                        queued ? t('jobs.asks.queued') : t('jobs.asks.sent'),
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}
      {notice && (
        <p role="status" className="m-0 text-[12px] text-fg-muted">
          {notice}
        </p>
      )}
    </section>
  )
}

interface CardProps {
  ask: Ask
  now: number
  onOpenJob?: (jobId: string) => void
  onSent: (queued: boolean) => void
}

function AskCard({ ask, now, onOpenJob, onSent }: CardProps) {
  const { t } = useT()
  const ids = useId()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const id = visibleUnsafe(ask.id)
  const ref = ask.live?.ref ?? ask.agent?.ref
  const age = statusAge(ask.created, false, now, t)
  const gone = ask.live?.status === 'gone'
  const choices = ask.choices ?? []
  const jobId = ask.job
  const jobTitle = ask.jobTitle ? visibleUnsafe(ask.jobTitle) : undefined

  const send = async (answer: { choice: number } | { text: string }) => {
    setSending(true)
    setProblem(null)
    try {
      const r = await answerQuestion(ask, answer)
      setText('')
      onSent(r.queued)
    } catch (err) {
      setProblem(
        err instanceof RequestError
          ? serverErrorText(err, t)
          : t('jobs.asks.failed'),
      )
    } finally {
      setSending(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!sending && text.trim()) void send({ text })
  }

  return (
    <article
      aria-label={id}
      className="flex flex-col gap-2 rounded-panel border border-border bg-bg p-3 text-[13px]"
    >
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-fg-muted">
        <span className="font-term font-semibold text-fg">{id}</span>
        {ref && (
          <span className="font-term">
            {t('jobs.asks.from', { ref: visibleUnsafe(ref) })}
          </span>
        )}
        {age && <span>{age}</span>}
        {jobId && jobTitle && (
          <span className="min-w-0 break-words">
            {t('jobs.asks.about')}{' '}
            {onOpenJob ? (
              <button
                type="button"
                onClick={() => onOpenJob(jobId)}
                className={`rounded-control text-left text-accent hover:underline ${FOCUS_RING}`}
              >
                {jobTitle}
              </button>
            ) : (
              <span className="text-fg">{jobTitle}</span>
            )}
          </span>
        )}
      </p>
      <p className="m-0 whitespace-pre-wrap break-words text-fg">
        {visibleUnsafe(ask.text ?? '', true)}
      </p>
      {gone ? (
        <p className="m-0 text-[12px] text-fg-muted">{t('jobs.asks.gone')}</p>
      ) : (
        <>
          {choices.length > 0 && (
            <fieldset
              aria-label={t('jobs.asks.choices', { id })}
              className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0"
            >
              {choices.map((label, i) => (
                <Button
                  // biome-ignore lint/suspicious/noArrayIndexKey: choices are fixed once asked, and may repeat
                  key={i}
                  size="grow"
                  className="max-w-full whitespace-pre-wrap break-words text-left"
                  disabled={sending}
                  onClick={() => void send({ choice: i + 1 })}
                >
                  {visibleUnsafe(label)}
                </Button>
              ))}
            </fieldset>
          )}
          <form onSubmit={submit} className="flex items-end gap-2">
            <label htmlFor={`${ids}-text`} className="sr-only">
              {t('jobs.asks.answerLabel', { id })}
            </label>
            <textarea
              id={`${ids}-text`}
              value={text}
              rows={1}
              disabled={sending}
              onChange={(e) => setText(e.target.value)}
              className={`${FIELD} min-h-9 flex-1 resize-y pointer-coarse:min-h-touch`}
            />
            <Button
              type="submit"
              variant="primary"
              disabled={sending || !text.trim()}
              aria-label={t('jobs.asks.sendFor', { id })}
            >
              {t('jobs.asks.send')}
            </Button>
          </form>
        </>
      )}
      {problem && (
        <p role="alert" className="m-0 text-[12px] text-danger">
          {problem}
        </p>
      )}
    </article>
  )
}
