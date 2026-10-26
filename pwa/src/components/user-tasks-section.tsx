import { useEffect, useRef, useState } from 'react'
import { RequestError, type UserTask } from '../hooks/use-mux-api'
import { useUserTasks } from '../hooks/use-user-tasks'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { userTaskErrorText } from '../utils/user-tasks'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { UserTaskEditor } from './user-task-editor'

// A delete waiting to be confirmed; again: the task changed on another
// device since it was shown, asked a second time with it as it is now
type Deleting = { task: UserTask; again?: boolean }

// Settings > Tasks: the tasks of the user, shared by every device of this
// server and offered in every pane's Tasks view. Read again when shown.
export function UserTasksSection() {
  const t = useUserTasks()
  const { refresh } = t
  const canWrite = !t.readOnly
  // undefined: no editor; null: a new task
  const [editing, setEditing] = useState<UserTask | null | undefined>()
  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const newRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const tell = (p: string | null, d: string | null = null) => {
    setProblem(p)
    setDone(d)
  }

  const remove = async ({ task }: Deleting) => {
    setDeleting(null)
    try {
      await t.remove(task)
      tell(null, `Deleted ${visibleUnsafe(task.name)}`)
    } catch (err) {
      if (err instanceof RequestError && err.code === 'conflict' && err.task)
        setDeleting({ task: err.task, again: true })
      else if (err instanceof RequestError && err.code === 'not_found') {
        tell(null, `Deleted ${visibleUnsafe(task.name)}`)
        void refresh()
      } else tell(userTaskErrorText(err))
    } finally {
      newRef.current?.focus()
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <p className="m-0 text-[12px] text-fg-muted">
        Saved on this server, shared by every device. Each runs from a pane's
        Tasks view, in a tab at the pane's folder.
      </p>
      {t.readOnly && (
        <p className="m-0 text-[12px] text-fg-muted">
          Saved by a newer Termote; update it to change tasks.
        </p>
      )}
      {(problem || (t.error && !t.loaded)) && (
        <p role="alert" className="m-0 text-sm text-danger">
          {problem ?? 'Could not read the tasks'}
        </p>
      )}
      {done && (
        <p role="status" className="m-0 text-sm text-fg-muted">
          {done}
        </p>
      )}
      {t.loaded && t.tasks.length === 0 && (
        <p className="m-0 text-sm text-fg-muted">No tasks yet.</p>
      )}
      {t.tasks.length > 0 && (
        <ul aria-label="Tasks" className="m-0 flex list-none flex-col p-0">
          {t.tasks.map((task) => {
            const name = visibleUnsafe(task.name)
            return (
              <li
                key={task.id}
                className="flex min-h-12 items-center gap-2 border-b border-border py-1.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-[15px] text-fg">{name}</p>
                  <p className="m-0 truncate font-term text-[12px] text-fg-muted">
                    {visibleUnsafe(task.command)}
                  </p>
                </div>
                {canWrite && (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        tell(null)
                        setEditing(task)
                      }}
                      aria-label={`Edit ${name}`}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setDeleting({ task })}
                      aria-label={`Delete ${name}`}
                    >
                      Delete
                    </Button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {canWrite && (
        <Button
          ref={newRef}
          variant="secondary"
          className="self-start"
          onClick={() => {
            tell(null)
            setEditing(null)
          }}
        >
          New task
        </Button>
      )}
      {editing !== undefined && (
        <UserTaskEditor task={editing} onClose={() => setEditing(undefined)} />
      )}
      <ConfirmDialog
        isOpen={!!deleting}
        title={
          deleting?.again
            ? 'Changed on another device: delete anyway?'
            : `Delete ${visibleUnsafe(deleting?.task.name ?? '')}?`
        }
        confirmLabel="Delete"
        destructive
        defaultAction={deleting?.again ? 'cancel' : 'confirm'}
        onConfirm={() => remove(deleting as Deleting)}
        onCancel={() => setDeleting(null)}
      >
        <p className="m-0">
          Every device of this server loses{' '}
          {visibleUnsafe(deleting?.task.name ?? '')}.
        </p>
      </ConfirmDialog>
    </div>
  )
}
