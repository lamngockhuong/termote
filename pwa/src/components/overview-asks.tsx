import { ChevronDown, ChevronUp, MessageCircleQuestion } from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { answerQuestion, dismissQuestion } from '../hooks/use-jobs'
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
  // The machine open in this page keeps no asks yet (an older Termote):
  // says to update it instead
  outdated?: boolean
  // Now on the server's clock (ms)
  now: number
  // Opens the details of the job an ask is about, by its id; absent when
  // that job cannot be opened here
  onOpenJob?: (jobId: string) => void
  // The job ids onOpenJob can open
  openableJobs?: ReadonlySet<string>
  // Shows only the oldest open ask, the others behind a toggle: a chat's
  // composer has little height to spare, and a second scrolled list above
  // it hides the conversation
  collapsible?: boolean
}

// How long the note that an answer went out, or that a question was
// dismissed, stays (ms)
const NOTICE_MS = 8000

const FIELD =
  'w-full min-w-0 rounded-control border border-border bg-bg px-2.5 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent disabled:opacity-50'

// The questions orchestrator agents asked the user (termote agents ask),
// above the Plan's columns. A full client answers one with a choice or with
// text, typed into the orchestrator's input box by the server, or dismisses
// it after a confirmation on its card (nothing typed); a view-only
// device only learns that some wait. What an agent wrote is shown as plain
// text: never markdown, never a link, its unsafe characters marked.
export function OverviewAsks({
  asks,
  readOnly,
  outdated = false,
  now,
  onOpenJob,
  openableJobs,
  collapsible = false,
}: Props) {
  const { t } = useT()
  const titleId = useId()
  // What the last answer sent or dismissal says, kept a moment after its
  // ask is gone
  const [notice, setNotice] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const open = asks.filter((a) => a.state === 'open')
  const folds = collapsible && open.length > 1
  // Folds again once only one is left, so the next batch starts folded
  useEffect(() => {
    if (!folds) setExpanded(false)
  }, [folds])
  if (open.length === 0 && !notice && !outdated) return null
  const shown = folds && !expanded ? open.slice(0, 1) : open

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-panel border border-danger/40 bg-surface p-3 ui-terminal:bg-bg"
    >
      {/* The toggle sits by the title, which stays at the top of a scrolled
          chat box, so folding again never needs a scroll to the end. It
          sticks over the box's top padding (ChatAsks' py-2), or the cards
          would show through that strip above it */}
      <div
        className={`flex items-center justify-between gap-2 ${folds ? 'sticky -top-2 z-10 -my-2 bg-surface py-2 ui-terminal:bg-bg' : ''}`}
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
          {folds && <span>· {open.length}</span>}
        </h4>
        {!readOnly && folds && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className={`flex shrink-0 items-center gap-1 rounded-control text-[12px] text-accent hover:underline ${FOCUS_RING}`}
          >
            {expanded ? (
              <ChevronUp size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
            {expanded
              ? t('jobs.asks.less')
              : t('jobs.asks.more', { count: open.length - 1 })}
          </button>
        )}
      </div>
      {outdated && (
        <p className="m-0 text-[13px] text-fg-muted">
          {t('jobs.asks.outdated')}
        </p>
      )}
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
              {shown.map((a) => (
                <li key={a.id}>
                  <AskCard
                    ask={a}
                    now={now}
                    onOpenJob={
                      a.job && openableJobs?.has(a.job) ? onOpenJob : undefined
                    }
                    onDone={setNotice}
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
  // What the answer or the dismissal done says
  onDone: (notice: string) => void
}

function AskCard({ ask, now, onOpenJob, onDone }: CardProps) {
  const { t } = useT()
  const ids = useId()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // Asking on the card whether to dismiss it
  const [confirming, setConfirming] = useState(false)
  const dismissRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Focus follows the confirmation: into it when it opens, back to the
  // button that opened it when it is cancelled
  const reopened = useRef(false)
  useEffect(() => {
    if (confirming) {
      cancelRef.current?.focus()
      reopened.current = true
    } else if (reopened.current) {
      reopened.current = false
      dismissRef.current?.focus()
    }
  }, [confirming])
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
      onDone(r.queued ? t('jobs.asks.queued') : t('jobs.asks.sent'))
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
  const dismiss = async () => {
    setSending(true)
    setProblem(null)
    try {
      await dismissQuestion(ask)
      onDone(t('jobs.asks.dismissed', { id }))
    } catch (err) {
      setProblem(
        err instanceof RequestError
          ? serverErrorText(err, t)
          : t('jobs.asks.dismissFailed'),
      )
      setSending(false)
    }
  }
  const confirmKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !sending) {
      e.preventDefault()
      e.stopPropagation()
      setConfirming(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!sending && !confirming && text.trim()) void send({ text })
  }

  return (
    <article
      aria-label={id}
      className="flex flex-col gap-2 rounded-panel border border-border bg-bg p-3 text-[13px]"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-fg-muted">
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
        {!confirming && (
          <Button
            ref={dismissRef}
            size="sm"
            variant="onSurface"
            className="ml-auto"
            disabled={sending}
            aria-label={t('jobs.asks.dismissFor', { id })}
            onClick={() => {
              setProblem(null)
              setConfirming(true)
            }}
          >
            {t('jobs.asks.dismiss')}
          </Button>
        )}
      </div>
      <p className="m-0 whitespace-pre-wrap break-words text-fg">
        {visibleUnsafe(ask.text ?? '', true)}
      </p>
      {confirming && (
        // Escape anywhere in it cancels
        <fieldset
          aria-label={t('jobs.asks.dismissFor', { id })}
          onKeyDown={confirmKey}
          className="m-0 flex min-w-0 flex-wrap items-center gap-2 rounded-control border border-danger/40 p-2"
        >
          <p className="m-0 min-w-0 flex-1 basis-48 text-[12px] text-fg">
            {gone
              ? t('jobs.asks.dismissConfirmGone', { id })
              : t('jobs.asks.dismissConfirm', { id })}
          </p>
          <Button
            size="sm"
            variant="danger"
            disabled={sending}
            onClick={() => void dismiss()}
          >
            {t('jobs.asks.dismiss')}
          </Button>
          <Button
            ref={cancelRef}
            size="sm"
            disabled={sending}
            onClick={() => setConfirming(false)}
          >
            {t('jobs.asks.dismissCancel')}
          </Button>
        </fieldset>
      )}
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
                  disabled={sending || confirming}
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
              disabled={sending || confirming}
              onChange={(e) => setText(e.target.value)}
              className={`${FIELD} min-h-9 flex-1 resize-y pointer-coarse:min-h-touch`}
            />
            <Button
              type="submit"
              variant="primary"
              disabled={sending || confirming || !text.trim()}
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
