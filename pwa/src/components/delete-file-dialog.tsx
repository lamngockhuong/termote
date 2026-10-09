import { useEffect, useRef, useState } from 'react'
import {
  type DeletedFile,
  deleteFile,
  fetchFileHash,
  RequestError,
} from '../hooks/use-mux-api'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Sheet } from './ui/sheet'

// Why the server would not delete it, by its code
const REFUSED: Record<string, string> = {
  changed: 'The file changed since it was read',
  not_empty: 'The folder is not empty',
  not_file: 'This is not a regular file',
  not_directory: 'This is not a folder',
  symlink: 'Part of this path is a symbolic link',
  not_allowed: "Files can't be deleted there",
  permission: "The server can't delete this",
  read_only: 'The file system there is read-only',
  hardlink: 'This file has several hard links; delete it from a terminal',
  too_large: 'Too large to delete here; use the terminal',
  busy: 'Too many writes at once. Try again',
  trash_unavailable: 'Deleting is not available on this server',
  storage_full: "The host's disk or quota is full",
}

// What a delete did, for the caller's notice and its Undo
export interface DeleteOutcome {
  path: string
  kind: 'file' | 'dir'
  // In the trash under this id: Undo puts it back
  trashId?: string
  permanent?: boolean
  // The file had changed: what was moved is another file, kept for Undo
  swapped?: boolean
}

type Hash =
  | { status: 'loading' }
  | { status: 'ready'; hash: string }
  | { status: 'too-large' }
  | { status: 'error'; message: string; retry: boolean }

interface Props {
  paneId: string
  root: string
  path: string
  kind: 'file' | 'dir'
  // A name that usually holds secrets: said so, and sent with reveal
  sensitive: boolean
  // The sha256 of the text the viewer shows, when it shows the file
  hash?: string
  onClose: () => void
  onDeleted: (outcome: DeleteOutcome) => void
  onRootChanged: (root: string) => void
  onRefresh: () => void
}

// Asks before deleting a file (into the server's trash, with an Undo) or an
// empty folder, showing the full path. Cancel has the focus, so Enter never
// deletes. A file on another file system than the trash is deleted for good
// only after a second ask.
export function DeleteFileDialog({
  paneId,
  root,
  path,
  kind,
  sensitive,
  hash: known,
  onClose,
  onDeleted,
  onRootChanged,
  onRefresh,
}: Props) {
  const [hash, setHash] = useState<Hash>(
    kind === 'dir' || known
      ? { status: 'ready', hash: known ?? '' }
      : { status: 'loading' },
  )
  const [tries, setTries] = useState(0)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [askPermanent, setAskPermanent] = useState(false)
  // The hash the box was opened with no longer matches the file: read it
  const [stale, setStale] = useState(false)
  const shown = stale ? undefined : known
  const cancel = useRef<HTMLButtonElement>(null)
  // The user closed the box: a reply arriving later changes nothing here
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
    const id = requestAnimationFrame(() => cancel.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  // The hash a delete must match: read without the contents
  // biome-ignore lint/correctness/useExhaustiveDependencies: tries reads it again
  useEffect(() => {
    if (kind === 'dir' || shown) return
    let live = true
    setHash({ status: 'loading' })
    fetchFileHash(paneId, path, root).then(
      (r) =>
        live &&
        setHash(
          r.hash ? { status: 'ready', hash: r.hash } : { status: 'too-large' },
        ),
      (err) => {
        if (!live) return
        if (err instanceof RequestError && err.status === 409 && err.root) {
          close()
          onRootChanged(err.root)
          return
        }
        const busy = err instanceof RequestError && err.status === 429
        setHash({
          status: 'error',
          message: busy
            ? 'Busy; try again'
            : err instanceof RequestError && err.status === 404
              ? 'File not found'
              : 'Could not read the file',
          retry: busy,
        })
      },
    )
    return () => {
      live = false
    }
  }, [paneId, path, root, kind, shown, tries])

  // Delete is offered only once this is known (a folder needs none)
  const baseHash =
    hash.status === 'ready' && kind === 'file' ? hash.hash : undefined
  const send = async (permanent: boolean) => {
    setSending(true)
    setProblem(undefined)
    try {
      const res: DeletedFile = await deleteFile(paneId, {
        root,
        path,
        kind,
        baseHash,
        reveal: sensitive,
        permanent,
      })
      // Told even when the box was closed meanwhile: the file is in the
      // trash, and only the notice carries its Undo
      if (!closed.current) onClose()
      onDeleted({
        path: res.path,
        kind,
        trashId: res.trashId,
        permanent: res.permanent,
      })
    } catch (err) {
      if (!(err instanceof RequestError)) {
        if (closed.current) onRefresh()
        else setProblem('It may have been deleted. Refresh to check.')
        return
      }
      if (err.status === 409 && err.root) {
        if (!closed.current) onClose()
        onRootChanged(err.root)
        return
      }
      // Changed meanwhile: the tree is read again. A swapped file that
      // went to the trash anyway can still be put back.
      if (err.code === 'changed') {
        onRefresh()
        if (err.trashId)
          onDeleted({ path, kind, trashId: err.trashId, swapped: true })
        // The next Delete sends the file's hash now, once the user agrees
        else setStale(true)
      }
      if (closed.current) return
      if (err.code === 'cross_device') setAskPermanent(true)
      else if (err.status === 404) setProblem('Not found; it may be gone')
      else setProblem(REFUSED[err.code] ?? 'Could not delete it')
    } finally {
      if (!closed.current) setSending(false)
    }
  }

  const what = kind === 'dir' ? 'folder' : 'file'
  const ready = hash.status === 'ready'
  return (
    <>
      <Sheet isOpen onClose={close} title={`Delete ${what}?`}>
        <div className="flex flex-col gap-3 p-4">
          <p className="m-0 break-all font-term text-[13px] text-fg">
            {visibleUnsafe(`${root.endsWith('/') ? root : `${root}/`}${path}`)}
          </p>
          <p className="m-0 text-sm text-fg-muted">
            {kind === 'dir'
              ? 'The empty folder is removed. Undo makes it again.'
              : "The file goes to Termote's trash; Undo puts it back."}
          </p>
          {sensitive && (
            <p className="m-0 text-sm text-warning">This is a sensitive file</p>
          )}
          {hash.status === 'too-large' && (
            <p role="alert" className="m-0 text-sm text-danger">
              Too large to delete here; use the terminal
            </p>
          )}
          {hash.status === 'error' && (
            <div
              role="alert"
              className="flex items-center gap-2 text-sm text-danger"
            >
              <span className="min-w-0 flex-1">{hash.message}</span>
              {hash.retry && (
                <Button size="sm" onClick={() => setTries((n) => n + 1)}>
                  Try again
                </Button>
              )}
            </div>
          )}
          {problem && (
            <p role="alert" className="m-0 text-sm text-danger">
              {problem}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button ref={cancel} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!ready || sending}
              onClick={() => send(false)}
              className="border border-danger/40 bg-danger/5"
            >
              Delete
            </Button>
          </div>
        </div>
      </Sheet>
      <ConfirmDialog
        isOpen={askPermanent}
        title="Delete permanently?"
        confirmLabel="Delete permanently"
        destructive
        onConfirm={() => {
          setAskPermanent(false)
          send(true)
        }}
        onCancel={() => setAskPermanent(false)}
      >
        This file is on another file system than Termote's trash, so it cannot
        be moved there. Delete it permanently? This cannot be undone.
      </ConfirmDialog>
    </>
  )
}
