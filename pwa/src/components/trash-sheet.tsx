import { Lock, RotateCcw, Trash, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { NotifyOptions } from '../app-views'
import {
  deleteTrashEntry,
  emptyTrash,
  type FilesTarget,
  fetchTrash,
  RequestError,
  restoreFile,
  type TrashEntry,
} from '../hooks/use-mux-api'
import { formatDate, formatRelative } from '../i18n/format'
import { useT } from '../i18n/i18n-context'
import { formatSize, splitPath } from '../utils/files-format'
import { restoreFailure } from '../utils/restore-failure'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button, IconButton } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Sheet } from './ui/sheet'
import { SkeletonLines } from './ui/skeleton'

// The trash of the root Files shows: opens the Trash sheet
export function TrashButton({ onClick }: { onClick: () => void }) {
  const { t } = useT()
  return (
    <IconButton
      size="sm"
      variant="ghost"
      onClick={onClick}
      aria-label={t('files.trash')}
      title={t('files.trash')}
    >
      <Trash size={15} aria-hidden="true" />
    </IconButton>
  )
}

// What a confirm box is open for
type Asking =
  | { kind: 'restore'; entry: TrashEntry }
  | { kind: 'delete'; entry: TrashEntry }
  // ids: the entries shown when the user was asked, the ones sent
  | { kind: 'empty'; ids: string[]; truncated: boolean }

type Listing =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; entries: TrashEntry[]; truncated: boolean }

// What was deleted under root, read each time the sheet opens: an entry
// goes back to its path, or goes for good, or every entry shown does. Only
// what was deleted while the root was this folder shows here. root is the
// one the view shows, never one an answer names: a moved root closes the
// sheet (onRootChanged).
export function TrashSheet({
  isOpen,
  onDismiss,
  target,
  root,
  notify,
  onRestored,
  onRootChanged,
}: {
  isOpen: boolean
  onDismiss: () => void
  target: FilesTarget
  root: string
  notify: (message: string, opts?: NotifyOptions) => void
  // An entry is back at path: the view shows it (and a discarded change's
  // file reads again)
  onRestored: (entry: TrashEntry, path: string) => void
  onRootChanged: (root: string) => void
}) {
  const { t, locale } = useT()
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [asking, setAskingState] = useState<Asking>()
  // What a confirm acts on, cleared on its first press: a second press
  // before the box closes (the same render) sends nothing again
  const askingRef = useRef<Asking>(undefined)
  const setAsking = (a: Asking | undefined) => {
    askingRef.current = a
    setAskingState(a)
  }
  const [running, setRunning] = useState(false)
  const [loads, setLoads] = useState(0)
  const { paneId, place } = target
  // The latest props, for the answers of requests still running
  const live = useRef({ root, onRootChanged, onDismiss })
  live.current = { root, onRootChanged, onDismiss }

  useEffect(() => {
    if (!isOpen) return
    // loads re-reads the list on request
    void loads
    let current = true
    setListing({ status: 'loading' })
    fetchTrash({ paneId, place }, root).then(
      (res) => {
        if (current)
          setListing({
            status: 'ok',
            entries: res.entries,
            truncated: !!res.truncated,
          })
      },
      (err) => {
        if (!current) return
        if (err instanceof RequestError && err.status === 409 && err.root) {
          live.current.onDismiss()
          live.current.onRootChanged(err.root)
          return
        }
        setListing({ status: 'error' })
      },
    )
    return () => {
      current = false
    }
  }, [isOpen, paneId, place, root, loads])

  const drop = (id: string) =>
    setListing((l) =>
      l.status === 'ok'
        ? { ...l, entries: l.entries.filter((e) => e.trashId !== id) }
        : l,
    )

  // A refusal every action shares: gone (dropped, said neutrally), the root
  // moved (followed, the sheet closes); false for any other
  const shared = (err: unknown, id?: string) => {
    if (!(err instanceof RequestError)) return false
    if (err.status === 409 && err.root) {
      onDismiss()
      onRootChanged(err.root)
      return true
    }
    if (err.code === 'not_in_trash' && id) {
      drop(id)
      notify(t('files.trash.gone'), { variant: 'info' })
      return true
    }
    return false
  }

  const restore = async (entry: TrashEntry) => {
    const name = visibleUnsafe(splitPath(entry.path)[1])
    setRunning(true)
    try {
      const res = await restoreFile(
        { paneId, place },
        { root, trashId: entry.trashId, reveal: !!entry.sensitive },
      )
      drop(entry.trashId)
      onRestored(entry, res.path)
      notify(t('files.trash.restored', { name }), { variant: 'success' })
    } catch (err) {
      const fail = restoreFailure(err, name, entry.path, t)
      if (fail.root) {
        onDismiss()
        onRootChanged(fail.root)
      }
      if (fail.gone) drop(entry.trashId)
      notify(fail.gone ? t('files.trash.gone') : fail.message, {
        variant: fail.variant,
      })
    } finally {
      setRunning(false)
    }
  }

  const remove = async (entry: TrashEntry) => {
    const name = visibleUnsafe(splitPath(entry.path)[1])
    setRunning(true)
    try {
      await deleteTrashEntry(
        { paneId, place },
        { root, trashId: entry.trashId },
      )
      drop(entry.trashId)
      notify(t('files.trash.deleted', { name }))
    } catch (err) {
      if (!shared(err, entry.trashId))
        notify(t('files.trash.deleteFailed', { name }), { variant: 'danger' })
    } finally {
      setRunning(false)
    }
  }

  const empty = async (ids: string[]) => {
    setRunning(true)
    try {
      const res = await emptyTrash({ paneId, place }, { root, trashIds: ids })
      notify(
        res.failed > 0
          ? t('files.trash.emptyFailed', { count: res.failed })
          : t('files.trash.emptied', { count: res.removed }),
        { variant: res.failed > 0 ? 'warning' : 'info' },
      )
    } catch (err) {
      if (!shared(err))
        notify(t('files.trash.emptyError'), { variant: 'danger' })
    } finally {
      setRunning(false)
      // What is left, and any older entry the 500 shown left out
      setLoads((n) => n + 1)
    }
  }

  const confirm = () => {
    const a = askingRef.current
    setAsking(undefined)
    if (!a) return
    if (a.kind === 'restore') void restore(a.entry)
    else if (a.kind === 'delete') void remove(a.entry)
    else void empty(a.ids)
  }

  const shown = listing.status === 'ok' ? listing.entries : []
  const now = Date.now()
  const askingName =
    asking && asking.kind !== 'empty'
      ? visibleUnsafe(splitPath(asking.entry.path)[1])
      : ''
  return (
    <>
      <Sheet isOpen={isOpen} onClose={onDismiss} title={t('files.trash')}>
        <div className="flex flex-col gap-2 pb-2">
          <p className="px-4 text-[12px] text-fg-subtle">
            {t('files.trash.scope')}
          </p>
          {listing.status === 'loading' && (
            <SkeletonLines
              label={t('files.trash.loading')}
              lines={4}
              icon
              className="px-4"
            />
          )}
          {listing.status === 'error' && (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-fg-muted">
              {t('files.trash.unreadable')}
              <Button size="sm" onClick={() => setLoads((n) => n + 1)}>
                {t('files.trash.retry')}
              </Button>
            </div>
          )}
          {listing.status === 'ok' && shown.length === 0 && (
            <p className="px-4 py-3 text-sm text-fg-muted">
              {t('files.trash.empty')}
            </p>
          )}
          {listing.status === 'ok' && listing.truncated && (
            <p className="px-4 text-[12px] text-fg-subtle">
              {t('files.trash.truncated')}
            </p>
          )}
          {shown.length > 0 && (
            <ul aria-label={t('files.trash.list')}>
              {shown.map((e) => {
                const [dir, base] = splitPath(e.path)
                const name = visibleUnsafe(base)
                return (
                  <li
                    key={e.trashId}
                    className="flex items-center gap-1 py-1.5 pr-2 pl-4"
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg">
                        <span className="truncate">{name}</span>
                        {e.sensitive && (
                          <Lock
                            size={12}
                            aria-label={t('files.trash.sensitive')}
                            className="shrink-0 text-fg-subtle"
                          />
                        )}
                      </span>
                      {dir && (
                        <span className="truncate text-[12px] text-fg-subtle">
                          {visibleUnsafe(dir)}
                        </span>
                      )}
                      <span className="text-[12px] text-fg-subtle">
                        {t(`files.trash.kind.${e.kind}`)} ·{' '}
                        {formatRelative(Date.parse(e.deletedAt), locale, now)}
                        {e.kind !== 'dir' && ` · ${formatSize(e.size, locale)}`}{' '}
                        ·{' '}
                        {t('files.trash.removedBy', {
                          date: formatDate(Date.parse(e.expiresAt), locale),
                        })}
                      </span>
                      {e.kind === 'discard' && (
                        <span className="text-[12px] text-fg-subtle">
                          {t('files.trash.discardNote')}
                        </span>
                      )}
                    </div>
                    <IconButton
                      size="sm"
                      disabled={running}
                      onClick={() =>
                        e.sensitive
                          ? setAsking({ kind: 'restore', entry: e })
                          : void restore(e)
                      }
                      aria-label={
                        e.kind === 'discard'
                          ? t('files.trash.restoreDiscardName', { name })
                          : t('files.trash.restoreName', { name })
                      }
                      title={
                        e.kind === 'discard'
                          ? t('files.trash.restoreDiscard')
                          : t('files.trash.restore')
                      }
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      disabled={running}
                      onClick={() => setAsking({ kind: 'delete', entry: e })}
                      aria-label={t('files.trash.deleteForGoodName', { name })}
                      title={t('files.trash.deleteForGood')}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </IconButton>
                  </li>
                )
              })}
            </ul>
          )}
          {shown.length > 0 && (
            <div className="flex justify-end px-4 pt-1">
              <Button
                size="sm"
                variant="danger"
                disabled={running}
                onClick={() =>
                  setAsking({
                    kind: 'empty',
                    ids: shown.map((e) => e.trashId),
                    truncated: listing.status === 'ok' && listing.truncated,
                  })
                }
              >
                {t('files.trash.emptyTrash')}
              </Button>
            </div>
          )}
        </div>
      </Sheet>
      <ConfirmDialog
        isOpen={!!asking}
        title={
          asking?.kind === 'restore'
            ? t('files.trash.askSensitive')
            : asking?.kind === 'delete'
              ? t('files.trash.askDelete')
              : t('files.trash.askEmpty')
        }
        confirmLabel={
          asking?.kind === 'restore'
            ? t('files.trash.restore')
            : asking?.kind === 'delete'
              ? t('files.trash.deleteForGood')
              : t('files.trash.emptyTrash')
        }
        destructive={asking?.kind !== 'restore'}
        defaultAction="cancel"
        onConfirm={confirm}
        onCancel={() => setAsking(undefined)}
      >
        {asking?.kind === 'restore' &&
          t('files.trash.askSensitiveBody', { name: askingName })}
        {asking?.kind === 'delete' &&
          t('files.trash.askDeleteBody', { name: askingName })}
        {asking?.kind === 'empty' &&
          (asking.truncated
            ? t('files.trash.askEmptyNewest', { count: asking.ids.length })
            : t('files.trash.askEmptyBody', { count: asking.ids.length }))}
      </ConfirmDialog>
    </>
  )
}
