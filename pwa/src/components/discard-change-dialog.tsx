import { useEffect, useRef, useState } from 'react'
import {
  type AppliedChange,
  applyChange,
  type ChangeEntry,
  type DiffHunk,
  fetchFileHash,
  RequestError,
} from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { splitPath } from '../utils/files-format'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Sheet } from './ui/sheet'

// Why the server would not stage, unstage or discard it, by its code
export const APPLY_REFUSED: Record<string, MessageKey> = {
  stale_hunk: 'files.apply.staleHunk',
  changed: 'files.apply.changed',
  not_changed: 'files.apply.notChanged',
  index_locked: 'files.apply.indexLocked',
  filtered: 'files.apply.filtered',
  conflict: 'files.apply.conflict',
  unsupported: 'files.apply.unsupported',
  hunk_unsupported: 'files.apply.hunkUnsupported',
  too_large: 'files.apply.tooLarge',
  busy: 'files.refused.busy',
  sensitive: 'files.apply.sensitive',
  view_only: 'files.apply.viewOnly',
  trash_unavailable: 'files.apply.trashUnavailable',
  not_editable: 'files.apply.notEditable',
  permission: 'files.apply.permission',
  not_directory: 'files.apply.notDirectory',
  storage_full: 'files.refused.storageFull',
}

// The codes after which the list and the diff are read again: what the
// user saw is not what is there
export const APPLY_STALE = new Set(['stale_hunk', 'changed', 'not_changed'])

type Hash =
  | { status: 'loading' }
  | { status: 'ready'; hash?: string }
  | { status: 'error'; message: MessageKey }

interface Props {
  paneId: string
  root: string
  // The entry whose working tree side is discarded
  entry: ChangeEntry
  // One hunk of its diff; absent for the whole file
  hunk?: DiffHunk
  // The hash of the file the diff shown was read against; read when the box
  // opens from the list, where no diff shows
  hash?: string
  onClose: () => void
  onDiscarded: (res: AppliedChange) => void
  onRootChanged: (root: string) => void
  onRefresh: () => void
}

// Asks before discarding a file's changes (or one hunk of them): the file as
// it is goes to the server's trash, with an Undo; an untracked file is
// deleted into it; a deleted file comes back from the index. Cancel has the
// focus, so Enter never discards. An untracked file on another file system
// than the trash is deleted for good only after a second ask.
export function DiscardChangeDialog({
  paneId,
  root,
  entry,
  hunk,
  hash: known,
  onClose,
  onDiscarded,
  onRootChanged,
  onRefresh,
}: Props) {
  const { t } = useT()
  const untracked = entry.unstaged === '?'
  const deleted = entry.unstaged === 'D'
  // A hunk or a deleted file is checked by the server against the file
  // itself: no hash to send
  const needsHash = !hunk && !deleted
  const [hash, setHash] = useState<Hash>(
    !needsHash || known
      ? { status: 'ready', hash: known }
      : { status: 'loading' },
  )
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [askPermanent, setAskPermanent] = useState(false)
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

  // The hash a discard of the whole file must match: read without the
  // contents, so a sensitive file's secret never reaches the browser
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per box
  useEffect(() => {
    if (!needsHash || known) return
    let live = true
    fetchFileHash({ paneId }, entry.path, root).then(
      (r) =>
        live &&
        setHash(
          r.hash
            ? { status: 'ready', hash: r.hash }
            : { status: 'error', message: APPLY_REFUSED.too_large },
        ),
      (err) => {
        if (!live) return
        if (err instanceof RequestError && err.status === 409 && err.root) {
          close()
          onRootChanged(err.root)
          return
        }
        setHash({
          status: 'error',
          message:
            err instanceof RequestError && err.status === 404
              ? 'files.discard.fileNotFound'
              : 'files.discard.unreadable',
        })
      },
    )
    return () => {
      live = false
    }
  }, [])

  // Discard is offered only once this is known (when one is needed)
  const baseHash = hash.status === 'ready' ? hash.hash : undefined
  const send = async (permanent: boolean) => {
    setSending(true)
    setProblem(undefined)
    try {
      const res = await applyChange(paneId, {
        root,
        action: 'discard',
        path: entry.path,
        orig: entry.orig,
        hunk: hunk?.id,
        baseHash,
        reveal: entry.sensitive,
        permanent: permanent || undefined,
      })
      // Told even when the box was closed meanwhile: only the notice
      // carries its Undo
      if (!closed.current) onClose()
      onDiscarded(res)
    } catch (err) {
      if (!(err instanceof RequestError)) {
        onRefresh()
        if (!closed.current) setProblem(t('files.discard.maybeDiscarded'))
        return
      }
      if (err.status === 409 && err.root) {
        if (!closed.current) onClose()
        onRootChanged(err.root)
        return
      }
      if (APPLY_STALE.has(err.code)) onRefresh()
      if (closed.current) return
      if (err.code === 'cross_device') setAskPermanent(true)
      else setProblem(t(APPLY_REFUSED[err.code] ?? 'files.discard.failed'))
    } finally {
      if (!closed.current) setSending(false)
    }
  }

  const name = splitPath(entry.path)[1]
  const title = hunk
    ? t('files.discard.askHunk')
    : t(
        untracked
          ? 'files.discard.askDelete'
          : deleted
            ? 'files.discard.askRestore'
            : 'files.discard.askFile',
        { name },
      )
  const what = t(
    deleted
      ? 'files.discard.deletedNote'
      : untracked
        ? 'files.discard.untrackedNote'
        : 'files.discard.note',
  )
  return (
    <>
      <Sheet isOpen onClose={close} title={title}>
        <div className="flex flex-col gap-3 p-4">
          <p className="m-0 break-all font-term text-[13px] text-fg">
            {visibleUnsafe(
              `${root.endsWith('/') ? root : `${root}/`}${entry.path}`,
            )}
          </p>
          {hunk && (
            <p className="m-0 font-term text-[12px] text-fg-muted">
              {hunk.header}
            </p>
          )}
          <p className="m-0 text-sm text-fg-muted">{what}</p>
          {entry.sensitive && (
            <p className="m-0 text-sm text-warning">
              {t('files.discard.sensitive')}
            </p>
          )}
          {hash.status === 'error' && (
            <p role="alert" className="m-0 text-sm text-danger">
              {t(hash.message)}
            </p>
          )}
          {problem && (
            <p role="alert" className="m-0 text-sm text-danger">
              {problem}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button ref={cancel} onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={hash.status !== 'ready' || sending}
              onClick={() => send(false)}
              className="border border-danger/40 bg-danger/5"
            >
              {t(
                untracked
                  ? 'files.discard.delete'
                  : deleted
                    ? 'files.discard.restore'
                    : 'files.discard.discard',
              )}
            </Button>
          </div>
        </div>
      </Sheet>
      <ConfirmDialog
        isOpen={askPermanent}
        title={t('files.discard.askPermanent')}
        confirmLabel={t('files.discard.permanent')}
        destructive
        // A second ask never defaults to the destructive button
        defaultAction="cancel"
        onConfirm={() => {
          setAskPermanent(false)
          send(true)
        }}
        onCancel={() => setAskPermanent(false)}
      >
        {t('files.discard.crossDevice')}
      </ConfirmDialog>
    </>
  )
}
