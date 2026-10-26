import { type FormEvent, useId, useRef, useState } from 'react'
import { RequestError, type UserTask } from '../hooks/use-mux-api'
import { createTask, updateTask } from '../hooks/use-user-tasks'
import { visibleUnsafe } from '../utils/unsafe-chars'
import {
  MAX_USER_TASK_NAME,
  userTaskErrorText,
  userTaskProblem,
} from '../utils/user-tasks'
import { Button } from './ui/button'
import { Sheet } from './ui/sheet'

interface Props {
  // The task to change; null makes a new one
  task: UserTask | null
  onClose: () => void
}

// What a refused save offers: another device changed the task (take theirs,
// or save over it) or deleted it (save this one as new)
type Refusal =
  | { kind: 'conflict'; theirs: UserTask }
  | { kind: 'gone' }
  | { kind: 'other'; text: string }

const FIELD =
  'h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch'

// Makes or changes a task: a name and one command line, run in the shell of
// a tab at the pane's root. The limits are checked here first; the
// server's answer is final.
export function UserTaskEditor({ task, onClose }: Props) {
  const [base, setBase] = useState(task)
  const [name, setName] = useState(task?.name ?? '')
  const [command, setCommand] = useState(task?.command ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [saving, setSaving] = useState(false)
  const [bad, setBad] = useState<'name' | 'command' | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const ids = useId()

  const save = async (over: UserTask | null = base) => {
    const p = userTaskProblem(name, command)
    if (p) {
      setProblem(p.message)
      setBad(p.field)
      setRefusal(null)
      return
    }
    setProblem(null)
    setBad(null)
    setRefusal(null)
    setSaving(true)
    try {
      if (over)
        await updateTask(over.id, { name, command, updated: over.updated })
      else await createTask({ name, command })
      onClose()
    } catch (err) {
      setSaving(false)
      if (err instanceof RequestError && err.code === 'conflict' && err.task)
        setRefusal({ kind: 'conflict', theirs: err.task })
      else if (err instanceof RequestError && err.code === 'not_found')
        setRefusal({ kind: 'gone' })
      else {
        setRefusal({ kind: 'other', text: userTaskErrorText(err) })
        if (err instanceof RequestError)
          setBad(
            err.field === 'name' || err.field === 'command' ? err.field : null,
          )
      }
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void save()
  }

  return (
    <Sheet
      isOpen
      onClose={onClose}
      title={base ? `Edit ${visibleUnsafe(base.name)}` : 'New task'}
      focusOnOpen={() => nameRef.current?.focus()}
    >
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <label htmlFor={`${ids}-name`} className="text-sm text-fg-muted">
          Name
        </label>
        <input
          ref={nameRef}
          id={`${ids}-name`}
          type="text"
          value={name}
          maxLength={MAX_USER_TASK_NAME * 2}
          autoComplete="off"
          aria-invalid={bad === 'name' || undefined}
          aria-describedby={bad === 'name' ? `${ids}-error` : undefined}
          onChange={(e) => setName(e.target.value)}
          className={FIELD}
        />
        <label htmlFor={`${ids}-command`} className="text-sm text-fg-muted">
          Command
        </label>
        <input
          id={`${ids}-command`}
          type="text"
          value={command}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-invalid={bad === 'command' || undefined}
          aria-describedby={
            bad === 'command' ? `${ids}-hint ${ids}-error` : `${ids}-hint`
          }
          // One line: a pasted line break becomes a space
          onChange={(e) => setCommand(e.target.value.replace(/[\r\n]+/g, ' '))}
          className={`${FIELD} font-term text-[13px]`}
        />
        <p id={`${ids}-hint`} className="m-0 text-[12px] text-fg-muted">
          Runs in the shell of a tab opened at the pane's folder (bash, zsh, sh,
          fish or pwsh), as if typed there.
        </p>
        {(problem || refusal?.kind === 'other') && (
          <p
            id={`${ids}-error`}
            role="alert"
            className="m-0 text-sm text-danger"
          >
            {problem ?? (refusal as { text: string }).text}
          </p>
        )}
        {refusal?.kind === 'conflict' && (
          <div role="alert" className="flex flex-col gap-2">
            <p className="m-0 text-sm text-danger">Changed on another device</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setBase(refusal.theirs)
                  setName(refusal.theirs.name)
                  setCommand(refusal.theirs.command)
                  setRefusal(null)
                }}
              >
                Load theirs
              </Button>
              <Button
                size="sm"
                disabled={saving}
                onClick={() => {
                  setBase(refusal.theirs)
                  void save(refusal.theirs)
                }}
              >
                Keep mine
              </Button>
            </div>
          </div>
        )}
        {refusal?.kind === 'gone' && (
          <div role="alert" className="flex flex-col gap-2">
            <p className="m-0 text-sm text-danger">Deleted on another device</p>
            <Button
              size="sm"
              className="self-start"
              disabled={saving}
              onClick={() => {
                setBase(null)
                void save(null)
              }}
            >
              Save as new
            </Button>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            Save
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
