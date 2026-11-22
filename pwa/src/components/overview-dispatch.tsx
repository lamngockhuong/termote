import { Send, X } from 'lucide-react'
import { type KeyboardEvent, useId, useRef, useState } from 'react'
import { RequestError } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { sendToAgent } from '../utils/send-to-agent'
import { serverErrorText } from '../utils/server-error'
import { Button, FOCUS_RING, IconButton } from './ui/button'

// An agent picked in the overview: its pane, its name and where it runs
export interface DispatchTarget {
  paneId: string
  name: string
  place: string
}

type Outcome =
  | { kind: 'sent' }
  | { kind: 'queued' }
  | { kind: 'failed'; reason: string }

interface Props {
  // The agents picked, in the overview's order
  targets: DispatchTarget[]
  // The panes that took the message (sent or queued): no longer picked
  onDelivered: (paneIds: string[]) => void
  onRemove: (paneId: string) => void
  onClear: () => void
}

// The overview's bar to send one message to every agent picked, each its
// own sendToAgent. Beside each agent: the last send's outcome. The text is
// kept until every agent took it, and the agents that did are unpicked, so
// sending again reaches only the ones that failed.
export function OverviewDispatch({
  targets,
  onDelivered,
  onRemove,
  onClear,
}: Props) {
  const { t } = useT()
  const fieldId = useId()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  // A second press before the first one's state is drawn sends nothing
  const busy = useRef(false)
  // The last send: every agent it went to, with its outcome
  const [last, setLast] = useState<
    { target: DispatchTarget; outcome: Outcome }[]
  >([])
  const canSend = !sending && text.trim() !== '' && targets.length > 0

  const send = async () => {
    if (!canSend || busy.current) return
    busy.current = true
    setSending(true)
    const message = text
    const to = targets
    const outcomes = await Promise.all(
      to.map(async (target): Promise<Outcome> => {
        try {
          const { queued } = await sendToAgent(target.paneId, message)
          return { kind: queued ? 'queued' : 'sent' }
        } catch (err) {
          return {
            kind: 'failed',
            reason:
              err instanceof RequestError
                ? serverErrorText(err, t)
                : t('tasks.dispatch.sendFailed'),
          }
        }
      }),
    )
    const results = to.map((target, i) => ({ target, outcome: outcomes[i] }))
    const delivered = results
      .filter((r) => r.outcome.kind !== 'failed')
      .map((r) => r.target.paneId)
    setLast(results)
    if (delivered.length === to.length) setText('')
    onDelivered(delivered)
    busy.current = false
    setSending(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    }
  }

  const outcomeOf = new Map(last.map((r) => [r.target.paneId, r.outcome]))
  const picked = new Set(targets.map((x) => x.paneId))
  // The agents picked, then those the last send reached and are no longer
  const rows = [
    ...targets.map((target) => ({ target, picked: true })),
    ...last
      .filter((r) => !picked.has(r.target.paneId))
      .map((r) => ({ target: r.target, picked: false })),
  ]

  return (
    <section
      aria-labelledby={`${fieldId}-title`}
      className="flex shrink-0 flex-col gap-2 border-t border-border bg-surface px-3 py-2 ui-terminal:bg-bg"
    >
      <div className="flex items-center gap-2">
        <h3
          id={`${fieldId}-title`}
          className="flex-1 text-[13px] font-semibold"
        >
          {targets.length === 0
            ? t('tasks.dispatch.none')
            : t('tasks.dispatch.count', { count: targets.length })}
        </h3>
        {targets.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onClear}
            disabled={sending}
          >
            {t('tasks.dispatch.clear')}
          </Button>
        )}
      </div>
      <p role="status" className="sr-only">
        {last.length > 0 &&
          t('tasks.dispatch.summary', {
            ok: last.filter((r) => r.outcome.kind !== 'failed').length,
            count: last.length,
          })}
      </p>
      {rows.length > 0 && (
        <ul
          aria-label={t('tasks.dispatch.agents')}
          className="flex max-h-32 flex-col gap-1 overflow-y-auto text-[13px]"
        >
          {rows.map(({ target, picked }) => {
            const outcome = outcomeOf.get(target.paneId)
            return (
              <li
                key={target.paneId}
                data-outcome={outcome?.kind}
                className="flex min-w-0 items-center gap-2"
              >
                <span className="min-w-0 flex-1 truncate">
                  {target.name}
                  <span className="text-fg-muted"> · {target.place}</span>
                </span>
                {outcome && <OutcomeText outcome={outcome} />}
                {picked && (
                  <IconButton
                    size="sm"
                    onClick={() => onRemove(target.paneId)}
                    disabled={sending}
                    aria-label={t('tasks.dispatch.remove', {
                      name: target.name,
                      place: target.place,
                    })}
                  >
                    <X size={14} aria-hidden="true" />
                  </IconButton>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <textarea
          id={fieldId}
          aria-label={t('tasks.dispatch.field')}
          placeholder={t('tasks.dispatch.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          className={`max-h-40 min-h-touch min-w-0 flex-1 resize-y rounded-control border border-border bg-bg p-2 text-[13px] text-fg pointer-coarse:text-[16px] ${FOCUS_RING}`}
        />
        <Button
          variant="primary"
          onClick={() => void send()}
          disabled={!canSend}
          title={t('tasks.dispatch.sendHint')}
        >
          <Send size={16} aria-hidden="true" />
          {sending ? t('tasks.dispatch.sending') : t('tasks.dispatch.send')}
        </Button>
      </div>
    </section>
  )
}

function OutcomeText({ outcome }: { outcome: Outcome }) {
  const { t } = useT()
  if (outcome.kind === 'failed')
    return (
      <span
        className="min-w-0 max-w-[60%] truncate text-danger"
        title={outcome.reason}
      >
        {t('tasks.dispatch.failed', { reason: outcome.reason })}
      </span>
    )
  return (
    <span className="shrink-0 text-fg-muted">
      {t(
        outcome.kind === 'queued'
          ? 'tasks.dispatch.queued'
          : 'tasks.dispatch.sent',
      )}
    </span>
  )
}
