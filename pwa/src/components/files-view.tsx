import {
  ChevronRight,
  Ellipsis,
  File,
  FilePlus,
  FileSymlink,
  Folder,
  FolderOpen,
  Lock,
  Trash2,
} from 'lucide-react'
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ViewProps } from '../app-views'
import {
  type FilesError,
  type FilesState,
  FOLLOW_NOTICES,
  isDir,
  isOpenable,
  joinPath,
  useFileDraft,
  useFiles,
} from '../hooks/use-files'
import { type FileEntry, RequestError, restoreFile } from '../hooks/use-mux-api'
import type { LinkPath } from '../utils/markdown-links'
import { DeleteFileDialog, type DeleteOutcome } from './delete-file-dialog'
import { FileSearch } from './file-search'
import { FileViewer } from './file-viewer'
import { NewFileDialog } from './new-file-dialog'
import { PaneDirHeader, ViewMessage } from './pane-dir-header'
import { FOCUS_RING, IconButton } from './ui/button'
import { Menu, MenuItem } from './ui/menu'

const ERRORS: Record<FilesError, string> = {
  unsupported: 'Not supported by this backend',
  'not-found': 'Directory not found',
  'not-allowed': "This directory can't be shown",
  unavailable: 'Could not load the directory',
}

type Row =
  | {
      kind: 'entry'
      path: string
      entry: FileEntry
      level: number
      parent: string
    }
  | { kind: 'note'; path: string; level: number; text: string }

type EntryRow = Extract<Row, { kind: 'entry' }>

// The rows on screen: each open directory's entries under it, or why they
// are not there.
// A directory is in dirs from the moment it opens: toggle starts its read in
// the same event.
function visibleRows(s: FilesState, dir = '', level = 1): Row[] {
  const d = s.dirs[dir]
  const rows: Row[] = []
  if (!d.entries) {
    const text = d.error ? ERRORS[d.error] : 'Loading…'
    return [{ kind: 'note', path: `${dir}/…`, level, text }]
  }
  for (const entry of d.entries) {
    const path = joinPath(dir, entry.name)
    rows.push({ kind: 'entry', path, entry, level, parent: dir })
    if (isDir(entry) && s.expanded[path])
      rows.push(...visibleRows(s, path, level + 1))
  }
  if (d.truncated) {
    rows.push({
      kind: 'note',
      path: `${dir}/+`,
      level,
      text: 'Only the first 5000 entries are shown',
    })
  }
  if (dir && d.entries?.length === 0) {
    rows.push({ kind: 'note', path: `${dir}/0`, level, text: 'Empty' })
  }
  return rows
}

// The directory a new file starts in, with its /: the focused one, or the
// focused file's
function focusedDir(s: FilesState, focused?: string): string {
  if (!focused) return ''
  const at = focused.lastIndexOf('/')
  const parent = at < 0 ? '' : focused.slice(0, at)
  const name = focused.slice(at + 1)
  const entry = s.dirs[parent]?.entries?.find((e) => e.name === name)
  const dir = entry && isDir(entry) ? focused : parent
  return dir ? `${dir}/` : ''
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// Files: the pane's root as a tree, read one directory at a time, and the
// file chosen from it. The same component is the mobile view and the desktop
// panel.
export function FilesView({
  session,
  isMobile,
  notify,
  readOnly,
  mux,
}: ViewProps) {
  // Before the first snapshot there is no pane to read
  if (!session.paneId) return <ViewMessage>Loading…</ViewMessage>
  return (
    <PaneFiles
      paneId={session.paneId}
      isMobile={isMobile}
      notify={notify}
      readOnly={readOnly}
      // A view-only client is kept from deleting here only: the server has
      // no roles yet
      canDelete={!readOnly && !!mux.caps.trash}
    />
  )
}

// What the Delete box is open for
interface Deleting {
  root: string
  path: string
  kind: 'file' | 'dir'
  sensitive: boolean
  hash?: string
}

function PaneFiles({
  paneId,
  isMobile,
  notify,
  readOnly,
  canDelete,
}: { paneId: string; canDelete: boolean } & Pick<
  ViewProps,
  'isMobile' | 'notify' | 'readOnly'
>) {
  const f = useFiles(paneId)
  const { load, rootChanges, follow } = f
  const [draft, setDraft] = useFileDraft(paneId)
  // The tree's focused item, which a new file starts next to
  const [focused, setFocused] = useState<string>()
  // The root the New file box was opened under, while it is open
  const [creating, setCreating] = useState<string>()
  const [deleting, setDeleting] = useState<Deleting>()
  // The search box's text: kept while a result is open, so Back returns
  // to the results
  const [query, setQuery] = useState('')
  const [refreshTick, setRefreshTick] = useState(0)

  const onFollow = useCallback(
    async (target: LinkPath, scrollTop: number) => {
      const notice = FOLLOW_NOTICES[await follow(target, scrollTop)]
      if (notice) notify(notice)
    },
    [follow, notify],
  )

  useEffect(() => load(), [load])

  // One notice per move of the root, not one per view that saw it
  const seenChanges = useRef(rootChanges)
  useEffect(() => {
    if (rootChanges > seenChanges.current)
      notify("The pane's directory changed")
    seenChanges.current = rootChanges
  }, [rootChanges, notify])

  const refresh = () => {
    f.refresh()
    if (query.trim()) setRefreshTick((n) => n + 1)
  }

  // An entry of the tree to delete: a folder only once it is known empty
  const askDelete = async (path: string, entry: FileEntry) => {
    // The tree shows only once the root is read
    const root = f.root as string
    if (!isDir(entry)) {
      setDeleting({ root, path, kind: 'file', sensitive: entry.sensitive })
      return
    }
    // A folder only once it is known to be empty: read now unless it was
    const dir = f.dirs[path]?.entries ? f.dirs[path] : await f.list(path)
    if (!dir.entries) notify("This folder can't be read")
    else if (dir.entries.length > 0) notify('The folder is not empty')
    else setDeleting({ root, path, kind: 'dir', sensitive: false })
  }

  const undo = async (d: Deleting, trashId: string) => {
    const name = baseName(d.path)
    try {
      const res = await restoreFile(paneId, {
        root: d.root,
        trashId,
        reveal: d.sensitive,
      })
      await f.restored(res.path)
      notify(`Restored ${name}`, { variant: 'success' })
    } catch (err) {
      if (err instanceof RequestError && err.status === 409 && err.root) {
        f.rootChanged(err.root)
        notify(`The pane's directory changed; ${name} was not restored`, {
          variant: 'warning',
        })
      } else if (err instanceof RequestError && err.code === 'exists') {
        notify(`A file now exists at ${err.path ?? d.path}; not restored`, {
          variant: 'warning',
        })
      } else {
        notify(`Could not restore ${name}`, { variant: 'danger' })
      }
    }
  }

  const onDeleted = (d: Deleting, o: DeleteOutcome) => {
    const name = baseName(o.path)
    if (o.swapped) {
      // Only ever told with the id it stayed in the trash under
      const id = o.trashId as string
      notify(`${name} changed; the file that was there is in the trash`, {
        variant: 'warning',
        action: { label: 'Undo', onClick: () => undo(d, id) },
      })
      return
    }
    // Its unsaved changes go with it: the user asked to delete it
    if (draft?.path === o.path) setDraft(undefined)
    f.deleted(o.path)
    if (o.permanent || !o.trashId) {
      notify(`Deleted ${name} permanently`)
      return
    }
    const id = o.trashId
    notify(`Deleted ${name}`, {
      action: { label: 'Undo', onClick: () => undo(d, id) },
    })
  }

  const root = f.dirs['']
  // Once the root is read, from the tree only. A view-only client is kept
  // from creating here only: the server has no roles yet
  const newFileRoot =
    !readOnly && !f.openPath && root?.entries ? f.root : undefined
  // The file this view just created opens into editing
  const intent =
    f.openIntent?.path === f.openPath && f.openIntent?.root === f.root
      ? f.openIntent
      : undefined
  const openPath = f.openPath
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneDirHeader
        root={f.root}
        onRefresh={refresh}
        refreshing={root?.loading}
      >
        {newFileRoot !== undefined && (
          <IconButton
            size="sm"
            variant="ghost"
            onClick={() => setCreating(newFileRoot)}
            aria-label="New file"
            title="New file"
          >
            <FilePlus size={15} aria-hidden="true" />
          </IconButton>
        )}
      </PaneDirHeader>
      {creating !== undefined && (
        <NewFileDialog
          paneId={paneId}
          root={creating}
          initialPath={focusedDir(f, focused)}
          onClose={() => setCreating(undefined)}
          onCreated={f.created}
          onRootChanged={f.rootChanged}
          onRefresh={f.refresh}
        />
      )}
      {deleting && (
        <DeleteFileDialog
          paneId={paneId}
          root={deleting.root}
          path={deleting.path}
          kind={deleting.kind}
          sensitive={deleting.sensitive}
          hash={deleting.hash}
          onClose={() => setDeleting(undefined)}
          onDeleted={(o) => onDeleted(deleting, o)}
          onRootChanged={f.rootChanged}
          onRefresh={f.refresh}
        />
      )}
      {openPath ? (
        <FileViewer
          // A new root or path starts unrevealed: a Show never carries over
          key={`${f.root}\u0000${openPath}`}
          paneId={paneId}
          root={f.root}
          path={openPath}
          wrapByDefault={isMobile}
          anchor={f.openAnchor}
          scrollTop={f.openScroll}
          backTo={f.history[f.history.length - 1]?.path}
          onClose={f.back}
          onFollow={onFollow}
          onRootChanged={f.rootChanged}
          notify={notify}
          // A view-only client is kept from editing here only: the server
          // has no roles yet
          canEdit={!readOnly}
          startEditing={!!intent}
          initialReveal={intent?.reveal}
          onDelete={
            canDelete
              ? ({ hash, sensitive }) =>
                  setDeleting({
                    // A file opens once the root is read
                    root: f.root as string,
                    path: openPath,
                    kind: 'file',
                    sensitive,
                    hash,
                  })
              : undefined
          }
        />
      ) : root?.error ? (
        <ViewMessage>{ERRORS[root.error]}</ViewMessage>
      ) : !root?.entries ? (
        <ViewMessage>Loading…</ViewMessage>
      ) : (
        <FileSearch
          paneId={paneId}
          root={f.root}
          isRepo={f.isRepo}
          query={query}
          onQuery={setQuery}
          refreshTick={refreshTick}
          onPick={(p) => f.reveal(p)}
          onRootChanged={f.rootChanged}
        >
          {root.entries.length === 0 ? (
            <ViewMessage>This directory is empty</ViewMessage>
          ) : (
            <FileTree
              state={f}
              focused={focused}
              onFocus={setFocused}
              onToggle={f.toggle}
              onOpen={f.open}
              onDelete={canDelete ? askDelete : undefined}
            />
          )}
        </FileSearch>
      )}
    </div>
  )
}

function FileTree({
  state,
  focused,
  onFocus: setFocused,
  onToggle,
  onOpen,
  onDelete,
}: {
  state: FilesState
  focused?: string
  onFocus: (path: string) => void
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  // Offered on each row (its menu, the Delete key) when deleting is allowed
  onDelete?: (path: string, entry: FileEntry) => void
}) {
  const rows = visibleRows(state)
  const entries = rows.filter((r) => r.kind === 'entry')
  const current = entries.find((r) => r.path === focused) ?? entries[0]
  const items = useRef(new Map<string, HTMLElement>())

  const focus = (path: string) => {
    setFocused(path)
    items.current.get(path)?.focus()
  }

  const activate = (r: EntryRow) => {
    if (isDir(r.entry)) onToggle(r.path)
    else if (isOpenable(r.entry)) onOpen(r.path)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const at = entries.indexOf(current)
    const open = isDir(current.entry) && !!state.expanded[current.path]
    let next: string | undefined
    // Cmd+Backspace on a Mac keyboard, which has no Delete key
    const key = e.key === 'Backspace' && e.metaKey ? 'Delete' : e.key
    switch (key) {
      case 'ArrowDown':
        next = entries[at + 1]?.path
        break
      case 'ArrowUp':
        next = entries[at - 1]?.path
        break
      case 'Home':
        next = entries[0].path
        break
      case 'End':
        next = entries[entries.length - 1].path
        break
      case 'ArrowRight':
        if (!isDir(current.entry)) break
        if (open)
          next =
            entries[at + 1]?.parent === current.path
              ? entries[at + 1].path
              : undefined
        else onToggle(current.path)
        break
      case 'ArrowLeft':
        if (open) onToggle(current.path)
        else if (current.parent) next = current.parent
        break
      case 'Enter':
      case ' ':
        activate(current)
        break
      case 'Delete':
        // Always through the dialog: never a delete without asking
        if (!onDelete) return
        onDelete(current.path, current.entry)
        break
      default:
        return
    }
    e.preventDefault()
    if (next) focus(next)
  }

  return (
    <div
      role="tree"
      aria-label="Files"
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-y-auto py-1"
    >
      {rows.map((r) =>
        r.kind === 'note' ? (
          <div
            key={r.path}
            className="py-1.5 pr-3 text-[12px] text-fg-subtle"
            style={{ paddingLeft: `${r.level * 16 + 12}px` }}
          >
            {r.text}
          </div>
        ) : (
          <TreeItem
            key={r.path}
            row={r}
            expanded={isDir(r.entry) ? !!state.expanded[r.path] : undefined}
            tabbable={r === current}
            // A folder read and found to hold something cannot go
            notEmpty={!!state.dirs[r.path]?.entries?.length}
            itemRef={(el) => {
              if (el) items.current.set(r.path, el)
              else items.current.delete(r.path)
            }}
            onClick={() => {
              setFocused(r.path)
              activate(r)
            }}
            onDelete={onDelete && (() => onDelete(r.path, r.entry))}
          />
        ),
      )}
    </div>
  )
}

function TreeItem({
  row,
  expanded,
  tabbable,
  notEmpty,
  itemRef,
  onClick,
  onDelete,
}: {
  row: EntryRow
  expanded?: boolean
  tabbable: boolean
  notEmpty: boolean
  itemRef: (el: HTMLElement | null) => void
  onClick: () => void
  onDelete?: () => void
}) {
  const { entry, level } = row
  const dir = isDir(entry)
  const can = isOpenable(entry)
  const Icon = dir
    ? expanded
      ? FolderOpen
      : Folder
    : entry.type === 'symlink'
      ? FileSymlink
      : File
  return (
    // The tree handles the keys of its focused item
    <div
      ref={itemRef}
      role="treeitem"
      aria-level={level}
      aria-expanded={expanded}
      aria-disabled={can ? undefined : true}
      tabIndex={tabbable ? 0 : -1}
      onClick={onClick}
      className={`group flex min-h-9 cursor-default items-center gap-1.5 pr-1 text-[13px] hover:bg-surface pointer-coarse:min-h-touch ${FOCUS_RING} focus-visible:-outline-offset-2 ${can ? 'text-fg' : 'text-fg-subtle'}`}
      style={{ paddingLeft: `${(level - 1) * 16 + 8}px` }}
    >
      <ChevronRight
        size={14}
        aria-hidden="true"
        className={`shrink-0 text-fg-subtle transition-transform duration-(--duration-fast) ${dir ? '' : 'invisible'} ${expanded ? 'rotate-90' : ''}`}
      />
      <Icon
        size={15}
        aria-hidden="true"
        className={`shrink-0 ${dir ? 'text-accent' : 'text-fg-muted'}`}
      />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.sensitive && (
        <span
          className="flex shrink-0 items-center gap-1 text-[11px] text-warning"
          title="May contain secrets"
        >
          <Lock size={12} aria-hidden="true" />
          <span className="sr-only">Sensitive</span>
        </span>
      )}
      {onDelete && (
        // Its own clicks and keys never reach the row (open, toggle, the
        // tree's keys). Shown on hover or focus with a mouse, always on a
        // touch screen.
        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
        >
          <Menu
            label={`Actions for ${entry.name}`}
            trigger={<Ellipsis size={14} aria-hidden="true" />}
            triggerTabIndex={-1}
            triggerSize="sm"
          >
            <MenuItem
              icon={<Trash2 size={16} />}
              danger
              disabled={dir && notEmpty}
              onSelect={onDelete}
            >
              {dir && notEmpty ? 'Delete (not empty)' : 'Delete'}
            </MenuItem>
          </Menu>
        </div>
      )}
    </div>
  )
}

export default FilesView
