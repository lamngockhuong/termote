import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { createFile, RequestError } from '../hooks/use-mux-api'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Sheet } from './ui/sheet'

// Why the server would not create the file, by its code
const REFUSED: Record<string, string> = {
  not_directory: 'Part of this path is a file, not a directory',
  symlink: 'Part of this path is a symbolic link',
  not_allowed: "Files can't be created there",
  permission: "The server can't create a file there",
  invalid_name: "This name can't be used",
  busy: 'Too many writes at once. Try again',
  storage_full: "The host's disk or quota is full",
  read_only: 'The file system there is read-only',
}

// Caught before sending; the server checks the name again
function nameProblem(path: string): string | undefined {
  if (!path) return 'Enter a file name'
  if (path.endsWith('/')) return 'Enter a file name after the last /'
  if (path.split('/').includes('..')) return "A path can't go up with .."
}

type Problem = {
  message: string
  // What the button under the message does: open the file found at path
  // (with the reveal it was asked with), or read the tree again
  action?: { kind: 'open'; path: string; reveal: boolean } | { kind: 'refresh' }
}

interface Props {
  paneId: string
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
  root,
  initialPath,
  onClose,
  onCreated,
  onRootChanged,
  onRefresh,
}: Props) {
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

  // After the sheet focuses itself on open
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = input.current
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    })
    return () => cancelAnimationFrame(id)
  }, [])

  const send = async (reveal: boolean) => {
    setSending(true)
    setProblem(undefined)
    try {
      const res = await createFile(paneId, { root, path, reveal })
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
          message: 'The file may have been created. Refresh to check.',
          action: { kind: 'refresh' },
        })
      } else if (err.status === 409 && err.root) {
        onClose()
        onRootChanged(err.root)
      } else if (err.code === 'sensitive') {
        setAsk('sensitive')
      } else if (err.code === 'exists') {
        setProblem({
          message: 'A file or directory of that name already exists',
          // Opened like any file found there: a secret one asks to Show.
          // The server's name for it: '\' separates directories on Windows
          action: { kind: 'open', path: err.path ?? path, reveal: false },
        })
      } else {
        setProblem({
          message: REFUSED[err.code] ?? 'Could not create the file',
        })
      }
    } finally {
      setSending(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (sending) return
    const message = nameProblem(path)
    if (message) setProblem({ message })
    else send(false)
  }

  const action = problem?.action
  return (
    <>
      <Sheet isOpen onClose={close} title="New file">
        <form onSubmit={submit} className="flex flex-col gap-3 p-4">
          <label htmlFor={inputId} className="text-sm text-fg-muted">
            Path from the pane's directory. Missing directories are created.
          </label>
          <input
            ref={input}
            id={inputId}
            type="text"
            value={path}
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
                  {action.kind === 'open' ? 'Open it' : 'Refresh'}
                </Button>
              )}
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
      <ConfirmDialog
        isOpen={ask === 'sensitive'}
        title="Create this file?"
        confirmLabel="Create"
        onConfirm={() => {
          setAsk(undefined)
          send(true)
        }}
        onCancel={() => setAsk(undefined)}
      >
        This name usually holds secrets. Create it anyway?
      </ConfirmDialog>
    </>
  )
}
