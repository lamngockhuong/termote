import {
  ChevronRight,
  File,
  FileSymlink,
  Folder,
  FolderOpen,
  Lock,
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
  useFiles,
} from '../hooks/use-files'
import type { FileEntry } from '../hooks/use-mux-api'
import type { LinkPath } from '../utils/markdown-links'
import { FileViewer } from './file-viewer'
import { PaneDirHeader, ViewMessage } from './pane-dir-header'
import { FOCUS_RING } from './ui/button'

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

// Files: the pane's root as a tree, read one directory at a time, and the
// file chosen from it. The same component is the mobile view and the desktop
// panel.
export function FilesView({ session, isMobile, notify, readOnly }: ViewProps) {
  // Before the first snapshot there is no pane to read
  if (!session.paneId) return <ViewMessage>Loading…</ViewMessage>
  return (
    <PaneFiles
      paneId={session.paneId}
      isMobile={isMobile}
      notify={notify}
      readOnly={readOnly}
    />
  )
}

function PaneFiles({
  paneId,
  isMobile,
  notify,
  readOnly,
}: { paneId: string } & Pick<ViewProps, 'isMobile' | 'notify' | 'readOnly'>) {
  const f = useFiles(paneId)
  const { load, rootChanges, follow } = f

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

  const root = f.dirs['']
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneDirHeader
        root={f.root}
        onRefresh={f.refresh}
        refreshing={root?.loading}
      />
      {f.openPath ? (
        <FileViewer
          // A new root or path starts unrevealed: a Show never carries over
          key={`${f.root}\u0000${f.openPath}`}
          paneId={paneId}
          root={f.root}
          path={f.openPath}
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
        />
      ) : root?.error ? (
        <ViewMessage>{ERRORS[root.error]}</ViewMessage>
      ) : !root?.entries ? (
        <ViewMessage>Loading…</ViewMessage>
      ) : root.entries.length === 0 ? (
        <ViewMessage>This directory is empty</ViewMessage>
      ) : (
        <FileTree state={f} onToggle={f.toggle} onOpen={f.open} />
      )}
    </div>
  )
}

function FileTree({
  state,
  onToggle,
  onOpen,
}: {
  state: FilesState
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const rows = visibleRows(state)
  const entries = rows.filter((r) => r.kind === 'entry')
  const [focused, setFocused] = useState<string>()
  const current = entries.find((r) => r.path === focused) ?? entries[0]
  const items = useRef(new Map<string, HTMLElement>())

  const focus = (path: string) => {
    setFocused(path)
    items.current.get(path)?.focus()
  }

  const activate = (r: Extract<Row, { kind: 'entry' }>) => {
    if (isDir(r.entry)) onToggle(r.path)
    else if (isOpenable(r.entry)) onOpen(r.path)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const at = entries.indexOf(current)
    const open = isDir(current.entry) && !!state.expanded[current.path]
    let next: string | undefined
    switch (e.key) {
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
            itemRef={(el) => {
              if (el) items.current.set(r.path, el)
              else items.current.delete(r.path)
            }}
            onClick={() => {
              setFocused(r.path)
              activate(r)
            }}
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
  itemRef,
  onClick,
}: {
  row: Extract<Row, { kind: 'entry' }>
  expanded?: boolean
  tabbable: boolean
  itemRef: (el: HTMLElement | null) => void
  onClick: () => void
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
      className={`flex min-h-9 cursor-default items-center gap-1.5 pr-3 text-[13px] hover:bg-surface pointer-coarse:min-h-touch ${FOCUS_RING} focus-visible:-outline-offset-2 ${can ? 'text-fg' : 'text-fg-subtle'}`}
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
    </div>
  )
}

export default FilesView
