import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { hasDirtyDraftAt } from '../hooks/use-files'
import { RequestError, renameFile } from '../hooks/use-mux-api'
import { baseNameSelection, nameProblem } from '../utils/file-name'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Sheet } from './ui/sheet'

// Why the server would not rename the file, by its code
const REFUSED: Record<string, string> = {
  not_directory: 'Part of the new path is a file, not a directory',
  symlink: 'Part of this path is a symbolic link',
  not_allowed: "Files can't be moved there",
  not_file: 'Only a file can be renamed',
  permission: "The server can't rename this file",
  invalid_name: "This name can't be used",
  invalid_path: "This file can't be renamed",
  in_use: 'The file is open in another program on the host',
  cross_device: "Can't move a file to another file system",
  changed: 'The file changed while it was being renamed',
  busy: 'Too many writes at once. Try again',
  storage_full: "The host's disk or quota is full",
  read_only: 'The file system there is read-only',
}

type Problem = {
  message: string
  // What the button under the message does: open the file found at path,
  // or read the tree again
  action?: { kind: 'open'; path: string } | { kind: 'refresh' }
}

interface Props {
  paneId: string
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
  root,
  path,
  reveal,
  onClose,
  onRenamed,
  onOpen,
  onRootChanged,
  onRefresh,
}: Props) {
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

  // After the sheet focuses itself on open: the name without its extension
  // selected, ready to type over
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = input.current
      el?.focus()
      el?.setSelectionRange(...baseNameSelection(el.value))
    })
    return () => cancelAnimationFrame(id)
  }, [])

  const send = async (withReveal: boolean) => {
    setSending(true)
    setProblem(undefined)
    try {
      const res = await renameFile(paneId, {
        root,
        path,
        newPath,
        reveal: withReveal,
      })
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
          message: 'The file may have been renamed. Refresh to check.',
          action: { kind: 'refresh' },
        })
      } else if (err.status === 404) {
        setProblem({
          message: 'This file no longer exists',
          action: { kind: 'refresh' },
        })
      } else if (err.code === 'sensitive') {
        setAsk('sensitive')
      } else if (err.code === 'exists') {
        setProblem({
          message: 'A file or directory of that name already exists',
          // The server's name for it, cleaned
          action: { kind: 'open', path: err.path ?? newPath },
        })
      } else {
        setProblem({
          message: REFUSED[err.code] ?? 'Could not rename the file',
        })
      }
    } finally {
      setSending(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (sending || newPath === path) return
    const message = nameProblem(newPath)
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
        message: `${visibleUnsafe(target)} has unsaved changes. Save or discard them first`,
      })
      return
    }
    send(reveal)
  }

  const action = problem?.action
  return (
    <>
      <Sheet isOpen onClose={close} title="Rename">
        <form onSubmit={submit} className="flex flex-col gap-3 p-4">
          <label htmlFor={inputId} className="text-sm text-fg-muted">
            New path from the pane's directory. Change the directories to move
            the file; missing ones are created.
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
                  {action.kind === 'open' ? 'Open it' : 'Refresh'}
                </Button>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={sending || newPath === path}
            >
              Rename
            </Button>
          </div>
        </form>
      </Sheet>
      <ConfirmDialog
        isOpen={ask === 'sensitive'}
        title="Rename this file?"
        confirmLabel="Rename"
        onConfirm={() => {
          setAsk(undefined)
          send(true)
        }}
        onCancel={() => setAsk(undefined)}
      >
        The old or the new name usually holds secrets. Under an ordinary name
        its contents show without asking. Rename it anyway?
      </ConfirmDialog>
    </>
  )
}
