import { useId, useState } from 'react'
import type { ViewProps } from '../app-views'
import { useHaptic } from '../hooks/use-haptic'
import {
  type AgentPrompt,
  AgentRequestError,
  answerAgentPrompt,
} from '../hooks/use-mux-api'
import { OpenTerminalButton } from './open-terminal-button'
import { Button } from './ui/button'

// A dialog Claude Code has open, as a card in place of the composer. Only
// one answer per dialog reaches the pane: the server consumes the promptId,
// so locking the buttons here is for the user, not for safety.

// Labels that refuse or stop: shown as such so they are not tapped by habit.
const REFUSING = /^(no|cancel|deny|reject)\b/i

interface Props {
  paneId: string
  prompt: AgentPrompt
  // A view-only role sees the dialog but has no buttons
  readOnly?: boolean
  showView: ViewProps['showView']
  // The dialog was answered: poll again now
  onAnswered: () => void
  // The server refused with the dialog now on screen (or none)
  onChanged: (prompt: AgentPrompt | null) => void
}

export function PromptCard({
  paneId,
  prompt,
  readOnly,
  showView,
  onAnswered,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // This card sent the answer: a dialog without an id is that answer settling
  const [sent, setSent] = useState(false)
  const { trigger } = useHaptic()
  const titleId = useId()
  const bodyId = useId()
  const answerable =
    !readOnly && prompt.kind !== 'unsupported' && !!prompt.promptId

  const answer = async (choice: number | 'cancel') => {
    /* v8 ignore next */
    if (!prompt.promptId) return
    setBusy(true)
    setNotice(null)
    try {
      await answerAgentPrompt(paneId, prompt.promptId, choice)
      trigger('light')
      setSent(true)
      onAnswered()
    } catch (err) {
      if (err instanceof AgentRequestError && err.code === 'prompt_changed') {
        setNotice('The screen changed; check the dialog again.')
        onChanged(err.prompt ?? null)
      } else if (
        err instanceof AgentRequestError &&
        err.code === 'prompt_expired'
      ) {
        setNotice('This dialog was already answered.')
        onAnswered()
      } else {
        // The key may have reached the pane even when the reply did not:
        // read the dialog again rather than claim either way.
        setNotice(
          err instanceof AgentRequestError &&
            err.code === 'answer_not_confirmed'
            ? 'The answer was sent but the dialog is still open; check it in the terminal.'
            : 'Could not confirm the answer; check the dialog.',
        )
        onAnswered()
      }
    } finally {
      setBusy(false)
    }
  }

  const label = {
    'aria-labelledby': titleId,
    'aria-describedby': prompt.body ? bodyId : undefined,
    className:
      'space-y-2 border-t border-border bg-surface p-3 pb-safe ui-terminal:bg-bg',
  }
  const content = (
    <>
      {prompt.steps && prompt.steps.length > 0 && (
        <ol aria-label="Questions" className="flex flex-wrap gap-1.5">
          {prompt.steps.map((s, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: tabs can share a header
              key={i}
              aria-current={s.current ? 'step' : undefined}
              className={`rounded-full border px-2 py-0.5 text-[12px] ${
                s.current
                  ? 'border-accent text-fg'
                  : 'border-border text-fg-muted'
              }`}
            >
              {s.answered && (
                <span aria-hidden="true" className="mr-1">
                  ✓
                </span>
              )}
              {s.label}
              {s.answered && <span className="sr-only"> (answered)</span>}
            </li>
          ))}
        </ol>
      )}
      <p id={titleId} className="font-medium text-fg">
        {prompt.title || 'Claude Code is asking'}
      </p>
      {prompt.body && (
        <p
          id={bodyId}
          className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] text-fg-muted"
        >
          {prompt.body}
        </p>
      )}
      <p aria-live="polite" className="text-[13px] text-warning empty:hidden">
        {notice ??
          (prompt.kind === 'unsupported' && !readOnly
            ? 'Answer this dialog in the terminal.'
            : '')}
      </p>
      {answerable ? (
        <div className="flex flex-col gap-1.5">
          {prompt.options?.map((o) => (
            <Button
              key={o.index}
              variant={REFUSING.test(o.label) ? 'danger' : 'secondary'}
              disabled={busy}
              onClick={() => answer(o.index)}
              size="grow"
              className="justify-start text-left"
            >
              <span className="shrink-0 text-fg-subtle">{o.index}.</span>
              <span className="min-w-0">
                {o.label}
                {o.detail && (
                  <span className="block text-[12px] font-normal text-fg-muted">
                    {o.detail}
                  </span>
                )}
              </span>
            </Button>
          ))}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => answer('cancel')}
            >
              Cancel (Esc)
            </Button>
            <span className="flex-1" />
            <OpenTerminalButton showView={showView} />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {!readOnly && prompt.kind !== 'unsupported' && (
            <span className="text-[13px] text-fg-muted">
              {sent ? 'Answer sent…' : 'Waiting for Claude Code…'}
            </span>
          )}
          <span className="flex-1" />
          {!readOnly && <OpenTerminalButton showView={showView} />}
        </div>
      )}
    </>
  )
  // A dialog only to look at is not one to answer: a region, not an
  // alertdialog.
  return readOnly ? (
    <section {...label}>{content}</section>
  ) : (
    <div role="alertdialog" {...label}>
      {content}
    </div>
  )
}

// The agent waits for an answer the server cannot read (a dialog this
// version does not know): the terminal is the way.
export function WaitingCard({ showView }: Pick<ViewProps, 'showView'>) {
  return (
    <div className="flex items-center gap-2 border-t border-border bg-surface p-3 pb-safe ui-terminal:bg-bg">
      <p className="flex-1 text-[13px] text-fg">
        Claude Code is waiting for you in the terminal.
      </p>
      <OpenTerminalButton showView={showView} />
    </div>
  )
}
