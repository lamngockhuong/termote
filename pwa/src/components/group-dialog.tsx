import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { RequestError } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { Button } from './ui/button'
import { Sheet } from './ui/sheet'

const INPUT_CLASSES =
  'h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch'

// The server takes a name of at most 64 bytes
export const MAX_GROUP_NAME_BYTES = 64

export const nameTooLong = (name: string) =>
  new TextEncoder().encode(name).length > MAX_GROUP_NAME_BYTES

// What a group is on each backend: a Herdr workspace, a tmux or a Zellij
// session
export type GroupKind = 'workspace' | 'tmux' | 'zellij'

const GROUP_NOUN: Record<GroupKind, MessageKey> = {
  workspace: 'shell.group.workspace',
  tmux: 'shell.group.tmux',
  zellij: 'shell.group.zellij',
}

// What a group is called, in the app's language ("tmux session")
export const groupNoun = (kind: GroupKind, t: Translate<MessageKey>) =>
  t(GROUP_NOUN[kind])

// Why a name was refused: tmux reads some characters in a target
export const invalidNameMessage = (
  kind: GroupKind,
  t: Translate<MessageKey>,
) =>
  kind === 'tmux'
    ? t('shell.group.invalidNameTmux')
    : t('shell.group.invalidName')

// Why the server would not create the group, by its code
export function groupProblem(
  code: string,
  kind: GroupKind,
  t: Translate<MessageKey>,
): string {
  const noun = groupNoun(kind, t)
  const messages: Record<string, string> = {
    invalid_name: invalidNameMessage(kind, t),
    invalid_cwd: t('shell.group.invalidCwd'),
    not_found: t('shell.group.notFound'),
    not_directory: t('shell.group.notDirectory'),
    not_allowed: t('shell.group.notAllowed', { noun }),
    busy: t('shell.group.busy'),
    exists: t('shell.group.exists', { noun }),
    unsupported: t('shell.group.unsupported', { noun }),
  }
  return messages[code] ?? t('shell.group.createFailed', { noun })
}

interface Props {
  kind: GroupKind
  onClose: () => void
  // Creates the group; a refusal throws RequestError with the server's code.
  // isOpen tells whether the box is still open once the reply is in: after
  // a Cancel the group is made but nothing switches to it
  onCreate: (name: string, cwd: string, isOpen: () => boolean) => Promise<void>
}

// Asks for the name and directory of a new group and creates it. A refusal
// is shown under the fields, which keep what was typed.
export function GroupDialog({ kind, onClose, onCreate }: Props) {
  const { t } = useT()
  const noun = groupNoun(kind, t)
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const nameId = useId()
  const cwdId = useId()
  const errorId = useId()
  const nameInput = useRef<HTMLInputElement>(null)
  // The user closed the box: a reply arriving later shows nothing
  const closed = useRef(false)
  useEffect(() => {
    closed.current = false
    return () => {
      closed.current = true
    }
  }, [])
  const close = () => {
    closed.current = true
    onClose()
  }

  // After the sheet focuses itself on open
  useEffect(() => {
    const id = requestAnimationFrame(() => nameInput.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (sending) return
    const trimmed = name.trim()
    if (!trimmed) {
      setProblem(t('shell.group.enterName'))
      return
    }
    if (nameTooLong(trimmed)) {
      setProblem(t('shell.group.tooLong', { n: MAX_GROUP_NAME_BYTES }))
      return
    }
    setSending(true)
    setProblem(undefined)
    try {
      await onCreate(trimmed, cwd.trim(), () => !closed.current)
      if (!closed.current) onClose()
    } catch (err) {
      if (closed.current) return
      setProblem(
        err instanceof RequestError
          ? groupProblem(err.code, kind, t)
          : // Lost on the way back, perhaps after the group was made
            t('shell.group.maybeCreated', { noun }),
      )
    } finally {
      if (!closed.current) setSending(false)
    }
  }

  const describedBy = problem ? errorId : undefined
  return (
    <Sheet isOpen onClose={close} title={t('shell.group.new', { noun })}>
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <label htmlFor={nameId} className="text-sm text-fg-muted">
          {t('shell.group.name')}
        </label>
        <input
          ref={nameInput}
          id={nameId}
          type="text"
          value={name}
          autoComplete="off"
          enterKeyHint="next"
          aria-invalid={problem ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => {
            setName(e.target.value)
            setProblem(undefined)
          }}
          className={INPUT_CLASSES}
        />
        <label htmlFor={cwdId} className="text-sm text-fg-muted">
          {t('shell.group.directory')}
        </label>
        <input
          id={cwdId}
          type="text"
          value={cwd}
          placeholder={t('shell.group.home')}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          enterKeyHint="done"
          aria-describedby={describedBy}
          onChange={(e) => {
            setCwd(e.target.value)
            setProblem(undefined)
          }}
          className={`${INPUT_CLASSES} font-term`}
        />
        {problem && (
          <div id={errorId} role="alert" className="text-sm text-danger">
            {problem}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={sending}>
            {t('shell.group.create')}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
