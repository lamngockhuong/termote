import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { RequestError } from '../hooks/use-mux-api'
import { Button } from './ui/button'
import { Sheet } from './ui/sheet'

const INPUT_CLASSES =
  'h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch'

// The server takes a name of at most 64 bytes
export const MAX_GROUP_NAME_BYTES = 64

export const nameTooLong = (name: string) =>
  new TextEncoder().encode(name).length > MAX_GROUP_NAME_BYTES

// Why a name was refused: tmux reads some characters in a target
export const invalidNameMessage = (noun: string) =>
  noun === 'tmux session'
    ? "This name can't be used. Avoid : . * ? [ \\ and a leading = or -"
    : "This name can't be used"

// Why the server would not create the group, by its code; noun is
// "workspace" or "tmux session"
export function groupProblem(code: string, noun: string): string {
  const messages: Record<string, string> = {
    invalid_name: invalidNameMessage(noun),
    invalid_cwd: 'Enter an absolute path on the host, or leave it empty',
    not_found: 'No such directory on the host',
    not_directory: 'That path is a file, not a directory',
    not_allowed: `A ${noun} can't start in that directory`,
    busy: 'The directory did not answer. Try again',
    exists: `A ${noun} of that name already exists`,
    unsupported: `This server can't create a ${noun}`,
  }
  return messages[code] ?? `Could not create the ${noun}`
}

interface Props {
  // "workspace" (Herdr) or "tmux session"
  noun: string
  onClose: () => void
  // Creates the group; a refusal throws RequestError with the server's code.
  // isOpen tells whether the box is still open once the reply is in: after
  // a Cancel the group is made but nothing switches to it
  onCreate: (name: string, cwd: string, isOpen: () => boolean) => Promise<void>
}

// Asks for the name and directory of a new group and creates it. A refusal
// is shown under the fields, which keep what was typed.
export function GroupDialog({ noun, onClose, onCreate }: Props) {
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
      setProblem('Enter a name')
      return
    }
    if (nameTooLong(trimmed)) {
      setProblem(`Use at most ${MAX_GROUP_NAME_BYTES} bytes`)
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
          ? groupProblem(err.code, noun)
          : // Lost on the way back, perhaps after the group was made
            `The ${noun} may have been created. Check the list.`,
      )
    } finally {
      if (!closed.current) setSending(false)
    }
  }

  const describedBy = problem ? errorId : undefined
  return (
    <Sheet isOpen onClose={close} title={`New ${noun}`}>
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <label htmlFor={nameId} className="text-sm text-fg-muted">
          Name
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
          Directory (an absolute path on the host)
        </label>
        <input
          id={cwdId}
          type="text"
          value={cwd}
          placeholder="Home directory"
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
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={sending}>
            Create
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
