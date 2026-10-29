import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { createFile, RequestError } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { nameProblem } from '../utils/file-name'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Sheet } from './ui/sheet'

// Why the server would not create the file, by its code
const REFUSED: Record<string, MessageKey> = {
  not_directory: 'files.new.notDirectory',
  symlink: 'files.refused.symlink',
  not_allowed: 'files.new.notAllowed',
  permission: 'files.new.permission',
  invalid_name: 'files.refused.invalidName',
  busy: 'files.refused.busy',
  storage_full: 'files.refused.storageFull',
  read_only: 'files.refused.readOnly',
}

type Problem = {
  message: string
  // What the button under the message does: open the file found at path
  // (with the reveal it was asked with), or read the tree again
  action?: { kind: 'open'; path: string; reveal: boolean } | { kind: 'refresh' }
}

interface Props {
  paneId: string
  // The Place the files are under (absent: the pane's folder)
  place?: string
  root: string
  // What the box starts with: the directory the tree has focus in, with its /
  initialPath: string
  onClose: () => void
  // The file was made at path (or the one there is to be opened)
  onCreated: (path: string, root: string, reveal: boolean) => void
  onRootChanged: (root: string) => void
  onRefresh: () => void
}

// Asks for the path of a new file under the pane's root and creates it,
// empty. A name that usually holds secrets is created only after a second
// ask.
export function NewFileDialog({
  paneId,
  place,
  root,
  initialPath,
  onClose,
  onCreated,
  onRootChanged,
  onRefresh,
}: Props) {
  const { t } = useT()
  const [path, setPath] = useState(initialPath)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<Problem>()
  const [ask, setAsk] = useState<'sensitive'>()
  const inputId = useId()
  const errorId = useId()
  const input = useRef<HTMLInputElement>(null)
  // The user closed the box: a reply arriving later opens nothing
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

  // On open: the caret after the directory already filled in
  const focusOnOpen = () => {
    const el = input.current
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
  }

  const send = async (reveal: boolean) => {
    setSending(true)
    setProblem(undefined)
    try {
      const res = await createFile({ paneId, place }, { root, path, reveal })
      // Closed meanwhile: the file is there, so the tree shows it, but it
      // is not opened
      if (closed.current) {
        onRefresh()
        return
      }
      onClose()
      onCreated(res.path, res.root, reveal)
    } catch (err) {
      if (closed.current) {
        // Never closes a box opened since; the tree still follows the root
        if (err instanceof RequestError && err.status === 409 && err.root)
          onRootChanged(err.root)
      } else if (!(err instanceof RequestError)) {
        // Lost on the way back, perhaps after the file was made: never
        // guessed from the tree, where an agent may have made one too
        setProblem({
          message: t('files.new.maybeCreated'),
          action: { kind: 'refresh' },
        })
      } else if (err.status === 409 && err.root) {
        onClose()
        onRootChanged(err.root)
      } else if (err.code === 'sensitive') {
        setAsk('sensitive')
      } else if (err.code === 'exists') {
        setProblem({
          message: t('files.refused.exists'),
          // Opened like any file found there: a secret one asks to Show.
          // The server's name for it: '\' separates directories on Windows
          action: { kind: 'open', path: err.path ?? path, reveal: false },
        })
      } else {
        setProblem({
          message: t(REFUSED[err.code] ?? 'files.new.failed'),
        })
      }
    } finally {
      setSending(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (sending) return
    const message = nameProblem(path, t)
    if (message) setProblem({ message })
    else send(false)
  }

  const action = problem?.action
  return (
    <>
      <Sheet
        isOpen
        onClose={close}
        title={t('files.new.title')}
        focusOnOpen={focusOnOpen}
      >
        <form onSubmit={submit} className="flex flex-col gap-3 p-4">
          <label htmlFor={inputId} className="text-sm text-fg-muted">
            {t('files.new.pathLabel')}
          </label>
          <input
            ref={input}
            id={inputId}
            type="text"
            value={path}
            // i18n-ignore: a path, the same in every language
            placeholder="docs/notes.md"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            enterKeyHint="done"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? errorId : undefined}
            onChange={(e) => {
              setPath(e.target.value)
              setProblem(undefined)
            }}
            className="h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 font-term text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch"
          />
          {problem && (
            <div
              id={errorId}
              role="alert"
              className="flex flex-wrap items-center gap-2 text-sm text-danger"
            >
              <span className="min-w-0 flex-1">{problem.message}</span>
              {action && (
                <Button
                  size="sm"
                  onClick={() => {
                    close()
                    if (action.kind === 'open')
                      onCreated(action.path, root, action.reveal)
                    else onRefresh()
                  }}
                >
                  {action.kind === 'open'
                    ? t('files.openIt')
                    : t('files.refresh')}
                </Button>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={sending}>
              {t('files.new.create')}
            </Button>
          </div>
        </form>
      </Sheet>
      <ConfirmDialog
        isOpen={ask === 'sensitive'}
        title={t('files.new.askSensitive')}
        confirmLabel={t('files.new.create')}
        onConfirm={() => {
          setAsk(undefined)
          send(true)
        }}
        onCancel={() => setAsk(undefined)}
      >
        {t('files.new.askSensitiveBody')}
      </ConfirmDialog>
    </>
  )
}
