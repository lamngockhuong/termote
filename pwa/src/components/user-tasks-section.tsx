import { useEffect, useRef, useState } from 'react'
import { RequestError, type UserTask } from '../hooks/use-mux-api'
import { useUserTasks } from '../hooks/use-user-tasks'
import { useT } from '../i18n/i18n-context'
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
  const { t } = useT()
  const store = useUserTasks()
  const { refresh } = store
  const canWrite = !store.readOnly
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
      await store.remove(task)
      tell(null, t('settings.deleted', { name: visibleUnsafe(task.name) }))
    } catch (err) {
      if (err instanceof RequestError && err.code === 'conflict' && err.task)
        setDeleting({ task: err.task, again: true })
      else if (err instanceof RequestError && err.code === 'not_found') {
        tell(null, t('settings.deleted', { name: visibleUnsafe(task.name) }))
        void refresh()
      } else tell(userTaskErrorText(err, t))
    } finally {
      newRef.current?.focus()
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <p className="m-0 text-[12px] text-fg-muted">
        {t('settings.tasks.intro')}
      </p>
      {store.readOnly && (
        <p className="m-0 text-[12px] text-fg-muted">
          {t('settings.tasks.newer')}
        </p>
      )}
      {(problem || (store.error && !store.loaded)) && (
        <p role="alert" className="m-0 text-sm text-danger">
          {problem ?? t('settings.tasks.readFailed')}
        </p>
      )}
      {done && (
        <p role="status" className="m-0 text-sm text-fg-muted">
          {done}
        </p>
      )}
      {store.loaded && store.tasks.length === 0 && (
        <p className="m-0 text-sm text-fg-muted">{t('settings.tasks.none')}</p>
      )}
      {store.tasks.length > 0 && (
        <ul
          aria-label={t('common.tasks')}
          className="m-0 flex list-none flex-col p-0"
        >
          {store.tasks.map((task) => {
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
                      aria-label={t('settings.editName', { name })}
                    >
                      {t('settings.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setDeleting({ task })}
                      aria-label={t('settings.deleteName', { name })}
                    >
                      {t('settings.delete')}
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
          {t('settings.tasks.new')}
        </Button>
      )}
      {editing !== undefined && (
        <UserTaskEditor task={editing} onClose={() => setEditing(undefined)} />
      )}
      <ConfirmDialog
        isOpen={!!deleting}
        title={
          deleting?.again
            ? t('settings.deleteAgain')
            : t('settings.deleteTitle', {
                name: visibleUnsafe(deleting?.task.name ?? ''),
              })
        }
        confirmLabel={t('settings.delete')}
        destructive
        defaultAction={deleting?.again ? 'cancel' : 'confirm'}
        onConfirm={() => remove(deleting as Deleting)}
        onCancel={() => setDeleting(null)}
      >
        <p className="m-0">
          {t('settings.deleteBody', {
            name: visibleUnsafe(deleting?.task.name ?? ''),
          })}
        </p>
      </ConfirmDialog>
    </div>
  )
}
