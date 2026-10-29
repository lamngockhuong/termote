import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { hasDirtyDraftAt } from '../hooks/use-files'
import { RequestError, renameFile } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { baseNameSelection, nameProblem } from '../utils/file-name'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Sheet } from './ui/sheet'

// Why the server would not rename the file, by its code
const REFUSED: Record<string, MessageKey> = {
  not_directory: 'files.rename.notDirectory',
  symlink: 'files.refused.symlink',
  not_allowed: 'files.rename.notAllowed',
  not_file: 'files.rename.notFile',
  permission: 'files.rename.permission',
  invalid_name: 'files.refused.invalidName',
  invalid_path: 'files.rename.invalidPath',
  in_use: 'files.rename.inUse',
  cross_device: 'files.rename.crossDevice',
  changed: 'files.rename.changed',
  busy: 'files.refused.busy',
  storage_full: 'files.refused.storageFull',
  read_only: 'files.refused.readOnly',
}

type Problem = {
  message: string
  // What the button under the message does: open the file found at path,
  // or read the tree again
  action?: { kind: 'open'; path: string } | { kind: 'refresh' }
}

interface Props {
  paneId: string
  // The Place the files are under (absent: the pane's folder)
  place?: string
  root: string
  // The file renamed, from the root
  path: string
  // The user chose to show this sensitive file already: no second ask
  reveal: boolean
  onClose: () => void
  // The file is at to now (changed: it was swapped while renamed, and
  // stayed there), shown as sensitive when reveal
  onRenamed: (to: string, reveal: boolean, changed: boolean) => void
  // Opens the file found at path (the new path was taken)
  onOpen: (path: string) => void
  onRootChanged: (root: string) => void
  onRefresh: () => void
}

// Asks for the new path of a file under the pane's root and moves it there:
// a rename, or a move when the directories change (made when missing).
// Nothing there is ever replaced. A name that usually holds secrets is
// renamed only after a second ask.
export function RenameFileDialog({
  paneId,
  place,
  root,
  path,
  reveal,
  onClose,
  onRenamed,
  onOpen,
  onRootChanged,
  onRefresh,
}: Props) {
  const { t } = useT()
  const [newPath, setNewPath] = useState(path)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<Problem>()
  const [ask, setAsk] = useState<'sensitive'>()
  const inputId = useId()
  const errorId = useId()
  const input = useRef<HTMLInputElement>(null)
  // The user closed the box: a reply arriving later still moves the tabs
  // (the file moved), but shows nothing
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

  // On open: the name without its extension selected, ready to type over
  const focusOnOpen = () => {
    const el = input.current
    el?.focus()
    el?.setSelectionRange(...baseNameSelection(el.value))
  }

  const send = async (withReveal: boolean) => {
    setSending(true)
    setProblem(undefined)
    try {
      const res = await renameFile(
        { paneId, place },
        {
          root,
          path,
          newPath,
          reveal: withReveal,
        },
      )
      if (!closed.current) onClose()
      onRenamed(res.path, withReveal, false)
    } catch (err) {
      if (err instanceof RequestError && err.status === 409 && err.root) {
        if (!closed.current) onClose()
        onRootChanged(err.root)
      } else if (
        err instanceof RequestError &&
        err.code === 'changed' &&
        err.path
      ) {
        // Swapped while renamed and left where the server says
        if (!closed.current) onClose()
        onRenamed(err.path, withReveal, true)
      } else if (closed.current) {
        // Never shown in a box opened since
      } else if (!(err instanceof RequestError)) {
        // Lost on the way back, perhaps after the file moved
        setProblem({
          message: t('files.rename.maybeRenamed'),
          action: { kind: 'refresh' },
        })
      } else if (err.status === 404) {
        setProblem({
          message: t('files.rename.gone'),
          action: { kind: 'refresh' },
        })
      } else if (err.code === 'sensitive') {
        setAsk('sensitive')
      } else if (err.code === 'exists') {
        setProblem({
          message: t('files.refused.exists'),
          // The server's name for it, cleaned
          action: { kind: 'open', path: err.path ?? newPath },
        })
      } else {
        setProblem({
          message: t(REFUSED[err.code] ?? 'files.rename.failed'),
        })
      }
    } finally {
      setSending(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (sending || newPath === path) return
    const message = nameProblem(newPath, t)
    if (message) {
      setProblem({ message })
      return
    }
    // A file being edited at the new path would lose its changes; the path
    // as the server cleans it (no "." or empty parts)
    const target = newPath
      .split('/')
      .filter((p) => p && p !== '.')
      .join('/')
    if (hasDirtyDraftAt(root, target)) {
      setProblem({
        message: t('files.rename.targetDirty', {
          name: visibleUnsafe(target),
        }),
      })
      return
    }
    send(reveal)
  }

  const action = problem?.action
  return (
    <>
      <Sheet
        isOpen
        onClose={close}
        title={t('files.rename.title')}
        focusOnOpen={focusOnOpen}
      >
        <form onSubmit={submit} className="flex flex-col gap-3 p-4">
          <label htmlFor={inputId} className="text-sm text-fg-muted">
            {t('files.rename.pathLabel')}
          </label>
          <input
            ref={input}
            id={inputId}
            type="text"
            value={newPath}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            enterKeyHint="done"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? errorId : undefined}
            onChange={(e) => {
              setNewPath(e.target.value)
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
                    if (action.kind === 'open') onOpen(action.path)
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
            <Button
              type="submit"
              variant="primary"
              disabled={sending || newPath === path}
            >
              {t('files.rename.title')}
            </Button>
          </div>
        </form>
      </Sheet>
      <ConfirmDialog
        isOpen={ask === 'sensitive'}
        title={t('files.rename.askSensitive')}
        confirmLabel={t('files.rename.title')}
        onConfirm={() => {
          setAsk(undefined)
          send(true)
        }}
        onCancel={() => setAsk(undefined)}
      >
        {t('files.rename.askSensitiveBody')}
      </ConfirmDialog>
    </>
  )
}
