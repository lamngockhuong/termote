import { useEffect, useId, useRef, useState } from 'react'
import type { ViewProps } from '../app-views'
import { agentLabel } from '../chat-agents'
import { useHaptic } from '../hooks/use-haptic'
import {
  type AgentChoice,
  type AgentPrompt,
  AgentRequestError,
  answerAgentPrompt,
  MAX_FREE_TEXT_BYTES,
} from '../hooks/use-mux-api'
import { OpenTerminalButton } from './open-terminal-button'
import { Button } from './ui/button'

// A dialog Claude Code has open, as a card in place of the composer. Only
// one answer per dialog reaches the pane: the server consumes the promptId,
// so locking the buttons here is for the user, not for safety.

// Labels that refuse or stop: shown as such so they are not tapped by habit.
const REFUSING = /^(no|cancel|deny|reject)\b/i

const encoder = new TextEncoder()

interface Props {
  paneId: string
  // The pane's agent, named while the card waits for it
  agentName?: string
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
  agentName,
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
  // The free-text answer being typed; null while the field is closed
  const [text, setText] = useState<string | null>(null)
  // A new id is another dialog, maybe asking the same again: the text was
  // typed for the last one
  const promptId = prompt.promptId
  useEffect(() => {
    if (promptId !== undefined) setText(null)
  }, [promptId])
  const { trigger } = useHaptic()
  const titleId = useId()
  const bodyId = useId()
  const textId = useId()
  const answerable =
    !readOnly && prompt.kind !== 'unsupported' && !!prompt.promptId
  const multi = prompt.kind === 'multiselect'

  // The button pressed is disabled while the answer is sent, which drops
  // its focus: give it back, so ticking several options of a multiSelect
  // tab from the keyboard or a screen reader does not restart each time.
  const pressed = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!busy && pressed.current?.isConnected) pressed.current.focus()
    if (!busy) pressed.current = null
  }, [busy])

  const answer = async (choice: AgentChoice) => {
    /* v8 ignore next */
    if (!prompt.promptId) return
    // Any focused element can take the focus back (SVG ones too)
    pressed.current = document.activeElement as HTMLElement | null
    setBusy(true)
    setNotice(null)
    try {
      await answerAgentPrompt(paneId, prompt.promptId, choice)
      trigger('light')
      setSent(true)
      setText(null)
      onAnswered()
    } catch (err) {
      if (err instanceof AgentRequestError && err.code === 'invalid_text') {
        // Nothing was sent and the dialog is the same: fix the text
        setNotice('The answer cannot hold line breaks or control characters.')
      } else if (
        err instanceof AgentRequestError &&
        err.code === 'text_too_long'
      ) {
        setNotice(
          `The answer is too long: the limit is ${err.limit ?? MAX_FREE_TEXT_BYTES} bytes.`,
        )
      } else if (
        err instanceof AgentRequestError &&
        err.code === 'text_not_confirmed'
      ) {
        setNotice(
          'The text may be in the dialog but was not sent; check it in the terminal.',
        )
        onAnswered()
      } else if (
        err instanceof AgentRequestError &&
        err.code === 'prompt_changed'
      ) {
        setNotice('The screen changed; check the dialog again.')
        onChanged(err.prompt ?? null)
      } else if (
        err instanceof AgentRequestError &&
        err.code === 'step_not_confirmed'
      ) {
        setNotice('That tab did not open; check the dialog.')
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

  const free = prompt.freeText
  const option = (o: NonNullable<AgentPrompt['options']>[number]) => (
    <Button
      key={o.index}
      variant={REFUSING.test(o.label) ? 'danger' : 'secondary'}
      disabled={busy}
      onClick={() => answer(o.index)}
      // On a multiSelect tab a digit toggles the option
      aria-pressed={multi && !isChat(o.label) ? !!o.checked : undefined}
      size="grow"
      className="justify-start text-left"
    >
      <span className="shrink-0 text-fg-subtle">{o.index}.</span>
      {multi && !isChat(o.label) && (
        <span aria-hidden="true" className="shrink-0">
          {o.checked ? '☑' : '☐'}
        </span>
      )}
      <span className="min-w-0">
        {o.label}
        {o.detail && (
          <span className="block text-[12px] font-normal text-fg-muted">
            {o.detail}
          </span>
        )}
      </span>
    </Button>
  )
  const other = (f: NonNullable<AgentPrompt['freeText']>) =>
    text === null ? (
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => setText('')}
        size="grow"
        className="justify-start text-left"
      >
        <span className="shrink-0 text-fg-subtle">{f.index}.</span>
        Other…
      </Button>
    ) : (
      <FreeTextField
        id={textId}
        text={text}
        busy={busy}
        onChange={setText}
        onSend={() => answer({ text })}
        onCancel={() => {
          setText(null)
          setNotice(null)
        }}
      />
    )

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
              className="flex"
            >
              {answerable && !s.current ? (
                // Another tab: the server moves there one arrow at a time
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => answer({ step: i })}
                  className={`${STEP} border-border text-fg-muted hover:text-fg disabled:opacity-50`}
                >
                  <StepLabel step={s} />
                </button>
              ) : (
                <span
                  className={`${STEP} ${s.current ? 'border-accent text-fg' : 'border-border text-fg-muted'}`}
                >
                  <StepLabel step={s} />
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      <p id={titleId} className="font-medium text-fg">
        {prompt.title || `${agentLabel(agentName)} is asking`}
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
          {/* "Type something" sits where the terminal draws it, above
              "Chat about this" */}
          {prompt.options
            ?.filter((o) => !free || o.index < free.index)
            .map(option)}
          {free && other(free)}
          {free &&
            prompt.options?.filter((o) => o.index > free.index).map(option)}
          {multi && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => answer('next')}
            >
              Next
            </Button>
          )}
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
              {sent ? 'Answer sent…' : `Waiting for ${agentLabel(agentName)}…`}
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

// The answer typed for a question's free-text option. Cancel only closes
// it: Esc in the terminal would leave the whole dialog.
function FreeTextField({
  id,
  text,
  busy,
  onChange,
  onSend,
  onCancel,
}: {
  id: string
  text: string
  busy: boolean
  onChange: (text: string) => void
  onSend: () => void
  onCancel: () => void
}) {
  const tooLong = encoder.encode(text).length > MAX_FREE_TEXT_BYTES
  const limitId = `${id}-limit`
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy && !tooLong && text.trim()) onSend()
      }}
    >
      <label htmlFor={id} className="sr-only">
        Your answer
      </label>
      <input
        id={id}
        type="text"
        value={text}
        autoFocus
        enterKeyHint="send"
        placeholder="Type your answer"
        aria-invalid={tooLong || undefined}
        aria-describedby={tooLong ? limitId : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-touch w-full rounded-control border border-border bg-bg px-3 py-2 text-[15px] text-fg focus-visible:border-accent focus-visible:outline-none"
      />
      {tooLong && (
        <p id={limitId} className="text-[12px] text-danger">
          Too long: the limit is {MAX_FREE_TEXT_BYTES} bytes.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || tooLong || !text.trim()}
        >
          Send
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

// A step of a question in several parts; tall enough to tap (24px)
const STEP =
  'inline-flex min-h-6 items-center rounded-full border px-2.5 py-1 text-[12px]'

// "Chat about this" ends the questions, on a multiSelect tab as well
const isChat = (label: string) => label === 'Chat about this'

function StepLabel({ step }: { step: NonNullable<AgentPrompt['steps']>[0] }) {
  return (
    <>
      {step.answered && (
        <span aria-hidden="true" className="mr-1">
          ✓
        </span>
      )}
      {step.label}
      {step.answered && (
        <>
          {' '}
          <span className="sr-only">(answered)</span>
        </>
      )}
    </>
  )
}

// The agent waits for an answer the server cannot read (a dialog this
// version does not know): the terminal is the way.
export function WaitingCard({
  agentName,
  showView,
}: Pick<ViewProps, 'showView'> & { agentName?: string }) {
  return (
    <div className="flex items-center gap-2 border-t border-border bg-surface p-3 pb-safe ui-terminal:bg-bg">
      <p className="flex-1 text-[13px] text-fg">
        {agentLabel(agentName)} is waiting for you in the terminal.
      </p>
      <OpenTerminalButton showView={showView} />
    </div>
  )
}
