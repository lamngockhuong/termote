import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { RequestError } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { UNSAFE_CHARS } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { Sheet } from './ui/sheet'

// The server takes a pane name of at most 64 bytes
export const MAX_PANE_NAME_BYTES = 64

// Why the server would not name the pane, by its code
const REFUSED: Record<string, MessageKey> = {
  unknown_pane: 'errors.unknown_pane',
  invalid_name: 'dialogs.paneRename.invalid',
  view_only: 'errors.view_only',
}

// What the server would refuse in name, as the message to show; '' when
// it is fine. An empty name removes the pane's name.
export function paneNameProblem(
  name: string,
  t: Translate<MessageKey>,
): string {
  if (new TextEncoder().encode(name).length > MAX_PANE_NAME_BYTES) {
    return t('dialogs.paneRename.tooLong', { n: MAX_PANE_NAME_BYTES })
  }
  if (
    name.startsWith('-') ||
    name.endsWith(';') ||
    name.search(UNSAFE_CHARS) >= 0
  ) {
    return t('dialogs.paneRename.invalid')
  }
  return ''
}

interface Props {
  // The pane's name now ('' without one)
  name: string
  onClose: () => void
  // Names the pane ('' removes its name); a refusal throws
  onSave: (name: string) => Promise<void>
}

// Asks for a pane's name. The name shows instead of the agent's or the
// title in the pane strip, the tab list, the Chat header and notifications.
export function PaneRenameDialog({ name: current, onClose, onSave }: Props) {
  const { t } = useT()
  const [name, setName] = useState(current)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState('')
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()
  const input = useRef<HTMLInputElement>(null)
  // The user closed the box: a reply arriving later shows nothing
  const closed = useRef(false)
  const close = () => {
    closed.current = true
    onClose()
  }
  useEffect(() => {
    closed.current = false
    return () => {
      closed.current = true
    }
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const next = name.trim()
    if (sending || next === current) return
    const message = paneNameProblem(next, t)
    if (message) {
      setProblem(message)
      return
    }
    setSending(true)
    setProblem('')
    try {
      await onSave(next)
      if (!closed.current) onClose()
    } catch (err) {
      if (closed.current) return
      const code = err instanceof RequestError ? err.code : ''
      setProblem(
        t(
          Object.hasOwn(REFUSED, code)
            ? REFUSED[code]
            : 'dialogs.paneRename.failed',
        ),
      )
    } finally {
      if (!closed.current) setSending(false)
    }
  }

  return (
    <Sheet
      isOpen
      onClose={close}
      title={t('dialogs.paneRename.title')}
      // On open: the name selected, ready to type over
      focusOnOpen={() => {
        input.current?.focus()
        input.current?.select()
      }}
    >
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <label htmlFor={inputId} className="text-sm text-fg-muted">
          {t('dialogs.paneRename.label')}
        </label>
        <input
          ref={input}
          id={inputId}
          type="text"
          value={name}
          placeholder={t('dialogs.paneRename.placeholder')}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          enterKeyHint="done"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? errorId : hintId}
          onChange={(e) => {
            setName(e.target.value)
            setProblem('')
          }}
          className="h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch"
        />
        {problem ? (
          <p id={errorId} role="alert" className="text-sm text-danger">
            {problem}
          </p>
        ) : (
          <p id={hintId} className="text-xs text-fg-subtle">
            {t('dialogs.paneRename.hint')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={sending || name.trim() === current}
          >
            {t('dialogs.paneRename.save')}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
