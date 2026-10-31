import {
  ChevronRight,
  Download,
  Ellipsis,
  File,
  FilePlus,
  FileSymlink,
  Folder,
  FolderOpen,
  Lock,
  TextCursorInput,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ViewProps } from '../app-views'
import {
  cancelUploads,
  confirmUpload,
  onFileUploaded,
  startUploads,
  useFileUploads,
} from '../hooks/use-file-uploads'
import {
  dropDraft,
  type FilesError,
  type FilesState,
  FOLLOW_NOTICES,
  fileRenamed,
  hasDirtyDraftAt,
  isDir,
  isOpenable,
  joinPath,
  useDirtyCheck,
  useFiles,
  useFilesFocusRequest,
  usePlaces,
} from '../hooks/use-files'
import { changesMoved, changesRefresh } from '../hooks/use-git-changes'
import { useLongPress } from '../hooks/use-long-press'
import {
  type FileEntry,
  RequestError,
  renameFile,
  restoreFile,
} from '../hooks/use-mux-api'
import { ENTER_FROM, useNewKeys } from '../hooks/use-new-keys'
import { useReviewComposer } from '../hooks/use-review-composer'
import { useSettings } from '../hooks/use-settings'
import { useShortcutKey } from '../hooks/use-shortcuts'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { Trans } from '../i18n/trans'
import type { Session } from '../types/session'
import { downloadFile } from '../utils/download-file'
import { fileNameProblem } from '../utils/file-name'
import { splitPath } from '../utils/files-format'
import { isFocusWindow } from '../utils/focus-mode'
import type { LinkPath } from '../utils/markdown-links'
import { isApplePlatform } from '../utils/platform'
import { restoreFailure } from '../utils/restore-failure'
import { commentedFileLines, type ReviewComment } from '../utils/review-draft'
import { chordFromEvent, SEARCH_CONTENT_KEY } from '../utils/shortcuts'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { droppedFiles, uploadDir } from '../utils/upload-file'
import { CHANGES_VIEW_ID } from '../view-ids'
import { openCommentInChanges } from './changes-view'
import {
  CONTENT_SEARCH_INITIAL,
  ContentSearch,
  type ContentSearchState,
  matchStart,
} from './content-search'
import { DeleteFileDialog, type DeleteOutcome } from './delete-file-dialog'
import { FileSearch } from './file-search'
import { FileTabBar, type TabListProps, tabElementId } from './file-tab-bar'
import { FileViewer } from './file-viewer'
import { NewFileDialog } from './new-file-dialog'
import { OpenFilesButton, OpenFilesSheet } from './open-files-sheet'
import { PaneDirHeader, ViewMessage } from './pane-dir-header'
import { PlacesMenu } from './places-menu'
import { RenameFileDialog } from './rename-file-dialog'
import { ReviewCommentSheet } from './review-comment-sheet'
import { ReviewControl } from './review-panel'
import { DiscardTabDialog, RootCloseDialog } from './tab-close-dialogs'
import { TrashButton, TrashSheet } from './trash-sheet'
import { Button, FOCUS_RING, IconButton } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Menu, MenuItem } from './ui/menu'
import { SegmentedControl } from './ui/segmented-control'
import { SkeletonLines } from './ui/skeleton'

const ERRORS: Record<FilesError, MessageKey> = {
  unsupported: 'files.find.unsupported',
  'not-found': 'files.find.notFound',
  'not-allowed': 'files.tree.notAllowed',
  'view-only': 'files.find.viewOnly',
  unavailable: 'files.tree.failed',
}

type Row =
  | {
      kind: 'entry'
      path: string
      entry: FileEntry
      level: number
      parent: string
    }
  | {
      kind: 'note'
      path: string
      dir: string
      level: number
      text: MessageKey
    }

type EntryRow = Extract<Row, { kind: 'entry' }>

// The rows on screen: each open directory's entries under it, or why they
// are not there.
// A directory is in dirs from the moment it opens: toggle starts its read in
// the same event.
function visibleRows(s: FilesState, dir = '', level = 1): Row[] {
  const d = s.dirs[dir]
  const rows: Row[] = []
  if (!d.entries) {
    const text = d.error ? ERRORS[d.error] : 'files.loading'
    return [{ kind: 'note', path: `${dir}/…`, dir, level, text }]
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
      dir,
      level,
      text: 'files.tree.truncated',
    })
  }
  if (dir && d.entries?.length === 0) {
    rows.push({
      kind: 'note',
      path: `${dir}/0`,
      dir,
      level,
      text: 'files.tree.empty',
    })
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
const parentOf = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf('/')))

// The tree's entry at path, where its folder was read
const entryAt = (s: FilesState, path: string) =>
  s.dirs[parentOf(path)]?.entries?.find((e) => e.name === baseName(path))

// Whether an upload may go in dir of the tree: the root, or a folder (a
// real one where the tree read it) not reached through a link, which the
// server refuses to write through
function uploadable(s: FilesState, dir: string): boolean {
  if (!dir) return true
  const entry = entryAt(s, dir)
  return (!entry || entry.type === 'dir') && !throughLink(s, dir)
}

// The folder an upload at path of the tree goes in: path when it is a
// folder that may take it, else the nearest one above (a file's, a link's).
// Worked out per event, never per row: a folder holds up to 5000 entries.
function uploadFolder(s: FilesState, path = ''): string {
  let dir = path
  while (!uploadable(s, dir)) dir = parentOf(dir)
  return dir
}

// The folder a drop on target goes in: its row's (data-path; a folder's
// note stands for that folder), or the root's below the rows
function dropFolder(s: FilesState, target: EventTarget): string {
  const row = (target as Element).closest<HTMLElement>('[data-path]')
  return uploadFolder(s, row?.dataset.path)
}

// The folder the focused row stands for, the root when that row is gone
// (deleted, or the root moved)
const focusedFolder = (s: FilesState, focused?: string) =>
  uploadFolder(s, focused && entryAt(s, focused) ? focused : '')

const carriesFiles = (e: DragEvent) =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files')

// How soon after a file opens from the tree a double click still pins it
export const TREE_DOUBLE_CLICK_MS = 500

// Files: the pane's root as a tree, read one directory at a time, and the
// files opened from it, one tab each (a tab bar on a desktop, a sheet of open
// files on a phone). The same component is the mobile view and the desktop
// panel.
export function FilesView({
  session,
  isMobile,
  notify,
  readOnly,
  mux,
  openWindow,
  showView,
  sessions,
  openTab,
}: ViewProps) {
  const { t } = useT()
  // Before the first snapshot there is no pane to read
  if (!session.paneId)
    return <SkeletonLines label={t('files.loading')} icon className="flex-1" />
  return (
    <PaneFiles
      session={session}
      sessions={sessions ?? []}
      openTab={openTab}
      showView={showView}
      canSendToAgent={!!mux.caps.agentChat}
      paneId={session.paneId}
      isMobile={isMobile}
      notify={notify}
      readOnly={readOnly}
      // The server refuses a view-only client's deletes as well
      canDelete={!readOnly && !!mux.caps.trash}
      // and its renames, which need no trash
      canRename={!readOnly}
      // and its downloads
      canDownload={!readOnly}
      // and every Place
      canPlaces={!readOnly && !!mux.caps.places}
      openWindow={openWindow}
    />
  )
}

// What the Rename box is open for
interface Renaming {
  root: string
  // The Place root is, absent for the pane's folder
  place?: string
  path: string
  // The user chose to show this sensitive file: no second ask
  revealed: boolean
}

// What the Delete box is open for
interface Deleting {
  root: string
  place?: string
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
  canRename,
  canDownload,
  canPlaces,
  openWindow,
  session,
  sessions,
  openTab,
  showView,
  canSendToAgent,
}: {
  paneId: string
  canDelete: boolean
  canRename: boolean
  canDownload: boolean
  canPlaces: boolean
  sessions: Session[]
  canSendToAgent: boolean
} & Pick<
  ViewProps,
  | 'isMobile'
  | 'notify'
  | 'readOnly'
  | 'openWindow'
  | 'session'
  | 'openTab'
  | 'showView'
>) {
  const { t } = useT()
  const f = useFiles(paneId)
  const places = usePlaces(canPlaces)
  const placeRoots = useMemo(() => places.map((p) => p.path), [places])
  const { settings } = useSettings()
  const { load, rootChanges, follow } = f
  const isDirty = useDirtyCheck(paneId)
  const tab = f.active
  // Review comments: never for a view-only client (it cannot send them) or
  // in a window of its own (it keeps nothing on the device)
  const commenting = !readOnly && !isFocusWindow()
  const review = useReviewComposer(paneId, f.root, notify)
  const commented = useMemo(
    () => tab && commentedFileLines(review.comments, f.root, tab.path),
    [review.comments, f.root, tab],
  )
  // A comment of the review opened: its file here, its diff in Changes
  const openComment = (cm: ReviewComment) => {
    // A file comment of a Place opens it there
    const ofPlace = cm.source === 'file' && placeRoots.includes(cm.root)
    // On a Place, a comment of another root is the pane's: its folder opens
    if (cm.root !== f.root && !ofPlace && !f.place) {
      notify(t('files.paneMoved'), { variant: 'warning' })
      return
    }
    if (cm.source === 'file') {
      f.openFromFind(cm.root, cm.path, { line: cm.start })
      return
    }
    openCommentInChanges(paneId, cm, notify, t)
    showView(CHANGES_VIEW_ID)
  }
  // The tab with unsaved changes the Discard box is open for
  const [closing, setClosing] = useState<string>()
  // The file a click in the tree just opened. The viewer takes the tree's
  // place under the pointer, so a double click's second click lands on the
  // viewer: a double click that soon pins the tab.
  const treeOpened = useRef<{ path: string; at: number }>(undefined)
  const openFromTree = (path: string) => {
    treeOpened.current = { path, at: Date.now() }
    f.open(path)
  }
  const pinIfDoubleClick = () => {
    const o = treeOpened.current
    treeOpened.current = undefined
    if (tab && o?.path === tab.path && Date.now() - o.at < TREE_DOUBLE_CLICK_MS)
      f.pin(tab.id)
  }
  // The tree's focused item, which a new file starts next to
  const [focused, setFocused] = useState<string>()
  // The tree's rows by path, and the row an upload just saved, focused once
  // it shows
  const treeItems = useRef(new Map<string, HTMLElement>())
  const [focusRow, setFocusRow] = useState<string>()
  useEffect(() => {
    if (!focusRow) return
    treeItems.current.get(focusRow)?.focus()
    setFocusRow(undefined)
  }, [focusRow])
  // The folder files dragged over the tree would go in
  const [dropAt, setDropAt] = useState<string>()
  const fileInput = useRef<HTMLInputElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  // A file uploaded into what this view shows becomes its focused row; it
  // takes the keyboard focus only from Files itself (never from the terminal)
  const shown = useRef({ place: f.place, root: f.root })
  shown.current = { place: f.place, root: f.root }
  useEffect(
    () =>
      onFileUploaded((u) => {
        const { place, root } = shown.current
        if (u.paneId !== paneId || u.place !== place || u.root !== root) return
        setFocused(u.path)
        const at = document.activeElement
        if (at === document.body || viewRef.current?.contains(at))
          setFocusRow(u.path)
      }),
    [paneId],
  )
  // Files into dir of the tree ("" for the root), from wherever the view
  // shows now; the upload goes on if the view goes
  const upload = (
    files: File[],
    dir: string,
    opts: { announce?: boolean; folders?: number } = {},
  ) =>
    startUploads(
      files,
      {
        target: { paneId, place: f.place },
        root: f.root as string,
        dir: uploadDir(dir),
      },
      { notify, t, ...opts },
    )
  // The root the New file box was opened under, while it is open
  const [creating, setCreating] = useState<string>()
  const [deleting, setDeleting] = useState<Deleting>()
  const [renaming, setRenaming] = useState<Renaming>()
  // The sensitive file the download confirmation is open for
  const [downloading, setDownloading] = useState<{
    root: string
    path: string
  }>()
  // The search box's text: kept while a result is open, so Back returns
  // to the results
  const [query, setQuery] = useState('')
  const [refreshTick, setRefreshTick] = useState(0)
  // Where the tree shows: the tree with the name box, or the content search,
  // whose query, results and scroll are kept here the same way
  const [pane, setPane] = useState<'files' | 'search'>('files')
  const [search, setSearch] = useState<ContentSearchState>(
    CONTENT_SEARCH_INITIAL,
  )
  const patchSearch = useCallback(
    (patch: Partial<ContentSearchState>) =>
      setSearch((s) => ({ ...s, ...patch })),
    [],
  )
  // Bumped by Ctrl/Cmd+Shift+F: the search box takes the focus
  const [focusSearch, setFocusSearch] = useState(0)

  const onFollow = useCallback(
    async (target: LinkPath, scrollTop: number, opts: { newTab: boolean }) => {
      const notice = FOLLOW_NOTICES[await follow(target, scrollTop, opts)]
      if (notice) notify(t(notice))
    },
    [follow, notify, t],
  )

  // A tab with unsaved changes closes only once the user says so
  const requestClose = (id: string) => {
    const t = f.tabs.find((x) => x.id === id)
    if (t && isDirty(t.root, t.path)) setClosing(id)
    else f.close(id)
  }

  // What the tab bar's tabs show (desktop)
  const panelId = useId()
  const tabBar = !isMobile && f.tabs.length > 0
  const tabList: TabListProps = {
    tabs: f.tabs.map((t) => {
      const [dir, name] = splitPath(t.path)
      return {
        id: t.id,
        name,
        title: t.path,
        detail: dir,
        pinned: t.pinned,
        dirty: isDirty(t.root, t.path),
        missing: t.missing,
      }
    }),
    activeId: f.activeId,
    homeLabel: t('common.files'),
    onActivate: f.activate,
    onClose: requestClose,
    onPin: f.pin,
    panelId,
  }
  // A phone has a sheet of the open files in place of the tab bar
  const [listing, setListing] = useState(false)
  // The Trash sheet, and the file a restored discard rewrote: its tab
  // reads it again
  const [trashOpen, setTrashOpen] = useState(false)
  const [rewritten, setRewritten] = useState<Record<string, number>>({})
  const openFiles = isMobile && f.tabs.length > 0 && (
    <OpenFilesButton count={f.tabs.length} onClick={() => setListing(true)} />
  )
  const closingTab = f.tabs.find((t) => t.id === closing)
  const moved = f.pendingRootClose?.length ?? 0

  useEffect(() => load(), [load])

  // One notice per move of the root, not one per view that saw it (the
  // store does not count a move to a Place the user picked)
  const seenChanges = useRef(rootChanges)
  useEffect(() => {
    if (rootChanges > seenChanges.current) notify(t('files.rootChanged'))
    seenChanges.current = rootChanges
  }, [rootChanges, notify, t])
  // The Place shown is gone (the server no longer offers it, or it leads
  // elsewhere now): back to the pane's folder, said once
  const seenLost = useRef(f.placeLost)
  useEffect(() => {
    if (f.placeLost > seenLost.current)
      notify(t('files.placeLost'), { variant: 'warning' })
    seenLost.current = f.placeLost
  }, [f.placeLost, notify, t])

  const refresh = () => {
    f.refresh()
    if (query.trim() || search.query) setRefreshTick((n) => n + 1)
  }

  const showSearch = () => {
    f.activate(null)
    setPane('search')
    setFocusSearch((n) => n + 1)
  }
  // Asked for from outside Files: the content search (its shortcut), or
  // the file just opened (the command palette)
  const panelRef = useRef<HTMLDivElement>(null)
  const [focusPanel, setFocusPanel] = useState(0)
  useFilesFocusRequest(paneId, (target) => {
    if (target === 'search') showSearch()
    else setFocusPanel((n) => n + 1)
  })
  useEffect(() => {
    if (focusPanel) panelRef.current?.focus()
  }, [focusPanel])

  // The content search's key (Ctrl/Cmd+Shift+F unless the user changed it)
  // from anywhere in Files, on every layout (never from the terminal, whose
  // keys stay the pane's, nor from a dialog): the content search, focused.
  // Handled here, so the app's shortcut dispatcher leaves it.
  const searchKey = useShortcutKey('files.searchContent', SEARCH_CONTENT_KEY)
  const isSearchKey = (e: KeyboardEvent) =>
    searchKey === SEARCH_CONTENT_KEY
      ? (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'f'
      : !!searchKey && chordFromEvent(e, isApplePlatform()) === searchKey
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isSearchKey(e)) return
    const target = e.target as HTMLElement
    if (
      target.closest?.('[role="dialog"], [role="alertdialog"], dialog, [inert]')
    )
      return
    e.preventDefault()
    showSearch()
  }

  // An entry of the tree to delete: a folder only once it is known empty
  const askDelete = async (path: string, entry: FileEntry) => {
    // The tree shows only once the root is read
    const root = f.root as string
    if (!isDir(entry)) {
      setDeleting({
        root,
        place: f.place,
        path,
        kind: 'file',
        sensitive: entry.sensitive,
      })
      return
    }
    // A folder only once it is known to be empty: read now unless it was
    const dir = f.dirs[path]?.entries ? f.dirs[path] : await f.list(path)
    if (!dir.entries) notify(t('files.tree.unreadable'))
    else if (dir.entries.length > 0) notify(t('files.delete.notEmpty'))
    else
      setDeleting({ root, place: f.place, path, kind: 'dir', sensitive: false })
  }

  const undo = async (d: Deleting, trashId: string) => {
    const name = visibleUnsafe(baseName(d.path))
    try {
      const res = await restoreFile(
        { paneId, place: d.place },
        {
          root: d.root,
          trashId,
          reveal: d.sensitive,
        },
      )
      await f.restored(res.path)
      notify(t('files.trash.restored', { name }), { variant: 'success' })
    } catch (err) {
      const fail = restoreFailure(err, name, d.path, t)
      if (fail.root) f.rootChanged(fail.root)
      notify(fail.message, { variant: fail.variant })
    }
  }

  const onDeleted = (d: Deleting, o: DeleteOutcome) => {
    const name = visibleUnsafe(baseName(o.path))
    if (o.swapped) {
      // Only ever told with the id it stayed in the trash under
      const id = o.trashId as string
      notify(t('files.deleted.swapped', { name }), {
        variant: 'warning',
        action: { label: t('files.undo'), onClick: () => undo(d, id) },
      })
      return
    }
    // Its unsaved changes go with it: the user asked to delete it
    dropDraft(paneId, d.root, o.path)
    f.deleted(o.path)
    if (o.permanent || !o.trashId) {
      notify(t('files.trash.deleted', { name }))
      return
    }
    const id = o.trashId
    notify(t('files.deleted', { name }), {
      action: { label: t('files.undo'), onClick: () => undo(d, id) },
    })
  }

  // Everything showing from under root follows it to to: the tabs and
  // drafts of every pane of the root, the Changes tabs, the search results
  const followRename = (
    root: string,
    from: string,
    to: string,
    reveal: boolean,
  ) => {
    fileRenamed(root, from, to, reveal)
    changesMoved(root, from, to, reveal)
    if (query.trim() || search.query) setRefreshTick((n) => n + 1)
  }

  // A file of the tree, or the one shown, to download. A sensitive one not
  // shown is asked about first.
  const askDownload = (path: string, sensitive: boolean, revealed: boolean) => {
    // The tree and a file show once the root is read
    const root = f.root as string
    if (sensitive && !revealed) setDownloading({ root, path })
    else download(root, path, revealed)
  }
  const download = (root: string, path: string, reveal: boolean) =>
    downloadFile(
      { paneId, place: f.place, root, path, reveal },
      notify,
      t,
      f.rootChanged,
    )

  // A file of the tree, or the one shown, to rename
  const askRename = (path: string, revealed: boolean) =>
    // The tree and a file show once the root is read
    setRenaming({ root: f.root as string, place: f.place, path, revealed })

  const undoRename = async (r: Renaming, to: string, reveal: boolean) => {
    const name = visibleUnsafe(baseName(r.path))
    if (hasDirtyDraftAt(r.root, r.path)) {
      notify(t('files.renameBack.dirty', { name }), {
        variant: 'warning',
      })
      return
    }
    try {
      const res = await renameFile(
        { paneId, place: r.place },
        {
          root: r.root,
          path: to,
          newPath: r.path,
          reveal,
        },
      )
      followRename(r.root, to, res.path, reveal)
      notify(t('files.renameBack.done', { name }), { variant: 'success' })
    } catch (err) {
      if (err instanceof RequestError && err.status === 409 && err.root) {
        f.rootChanged(err.root)
        notify(t('files.renameBack.rootChanged', { name }), {
          variant: 'warning',
        })
      } else if (err instanceof RequestError && err.code === 'exists') {
        notify(
          t('files.renameBack.exists', {
            path: visibleUnsafe(err.path ?? r.path),
          }),
          { variant: 'warning' },
        )
      } else if (
        err instanceof RequestError &&
        err.code === 'changed' &&
        err.path
      ) {
        followRename(r.root, to, err.path, reveal)
        notify(t('files.renamed.changed', { path: visibleUnsafe(err.path) }), {
          variant: 'warning',
        })
      } else {
        notify(t('files.renameBack.failed'), { variant: 'danger' })
      }
    }
  }

  const onRenamed = (
    r: Renaming,
    to: string,
    reveal: boolean,
    changed: boolean,
  ) => {
    if (to === r.path) return
    followRename(r.root, r.path, to, reveal)
    if (changed) {
      notify(t('files.renamed.changed', { path: visibleUnsafe(to) }), {
        variant: 'warning',
      })
      return
    }
    const [fromDir, fromName] = splitPath(r.path)
    const [toDir, toName] = splitPath(to)
    const text =
      fromDir === toDir
        ? t('files.renamed', {
            from: visibleUnsafe(fromName),
            to: visibleUnsafe(toName),
          })
        : toDir
          ? t('files.moved', {
              name: visibleUnsafe(toName),
              dir: visibleUnsafe(toDir.slice(0, -1)),
            })
          : t('files.movedToRoot', { name: visibleUnsafe(toName) })
    // The old name must be one the server takes as a new name
    if (fileNameProblem(fromName)) {
      notify(t('files.renamed.noUndo', { text }))
      return
    }
    notify(text, {
      action: {
        label: t('files.undo'),
        onClick: () => undoRename(r, to, reveal),
      },
    })
  }

  // Files dragged onto Files: never opened by the browser in place of the
  // app. Into the folder under the pointer, or with a file open (the tree
  // hidden) into that file's folder. Taken on the way down, so the editor
  // never inserts a dropped file's text as well.
  const onDragOver = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    // 'none' would keep the drop from firing: a view-only device is told
    e.dataTransfer.dropEffect = 'copy'
    if (!readOnly && !tab) setDropAt(dropFolder(f, e.target))
  }
  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null))
      setDropAt(undefined)
  }
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    setDropAt(undefined)
    // A dialog open over Files (Rename, an ask) is no folder
    if ((e.target as Element).closest('dialog, [role="dialog"]')) return
    if (readOnly) {
      notify(t('files.upload.viewOnly'), { variant: 'warning' })
      return
    }
    if (!f.root) return
    const { files, folders } = droppedFiles(e.dataTransfer)
    // Folders alone: no run to tell it
    if (!files.length) {
      if (folders) notify(t('files.upload.folders'), { variant: 'warning' })
      return
    }
    // A tab kept from a root the pane has left: its folder is not this one
    if (tab && tab.root !== f.root) {
      notify(t('files.upload.rootLeft'), { variant: 'warning' })
      return
    }
    const dir = tab
      ? uploadFolder(f, parentOf(tab.path))
      : dropFolder(f, e.target)
    upload(files, dir, { announce: !!tab, folders })
  }

  const root = f.dirs['']
  // Once the root is read, from the tree only. Never for a view-only client,
  // whose creates the server refuses as well
  const newFileRoot = !readOnly && !tab && root?.entries ? f.root : undefined
  // Files copied in the file manager and pasted while the tree shows; a
  // paste into a text box, or with no files, keeps its default
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files)
    const into = e.target as Element
    if (
      newFileRoot === undefined ||
      files.length === 0 ||
      into.closest(
        'input, textarea, [contenteditable]:not([contenteditable="false"])',
      )
    )
      return
    e.preventDefault()
    upload(files, focusedFolder(f, focused))
  }
  return (
    <div
      ref={viewRef}
      className="flex h-full min-h-0 flex-col"
      onDoubleClick={pinIfDoubleClick}
      onKeyDown={onKeyDown}
      onDragOverCapture={onDragOver}
      onDragLeave={onDragLeave}
      onDropCapture={onDrop}
    >
      <PaneDirHeader
        root={f.root}
        onRefresh={refresh}
        refreshing={root?.loading}
      >
        <PlacesMenu places={places} place={f.place} onPick={f.openPlace} />
        {/* Whether a file is open or not, and in a Place too */}
        {canDelete && root?.entries && (
          <TrashButton onClick={() => setTrashOpen(true)} />
        )}
        {newFileRoot !== undefined && (
          <IconButton
            size="sm"
            variant="ghost"
            onClick={() => setCreating(newFileRoot)}
            aria-label={t('files.new.title')}
            title={t('files.new.title')}
          >
            <FilePlus size={15} aria-hidden="true" />
          </IconButton>
        )}
        {newFileRoot !== undefined && (
          <>
            <IconButton
              size="sm"
              variant="ghost"
              onClick={() => fileInput.current?.click()}
              aria-label={t('files.upload')}
              title={t('files.upload')}
            >
              <Upload size={15} aria-hidden="true" />
            </IconButton>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid="upload-input"
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files as FileList)
                // The same file can be picked again
                e.currentTarget.value = ''
                upload(files, focusedFolder(f, focused))
              }}
            />
          </>
        )}
        {commenting && (
          <ReviewControl
            paneId={paneId}
            session={session}
            sessions={sessions}
            canSend={canSendToAgent}
            notify={notify}
            openTab={openTab}
            onOpenComment={openComment}
          />
        )}
        {!tab && openFiles}
      </PaneDirHeader>
      <UploadStatusRow />
      {tabBar && <FileTabBar {...tabList} />}
      <OpenFilesSheet
        {...tabList}
        isOpen={isMobile && listing}
        onDismiss={() => setListing(false)}
      />
      {canDelete && f.root && (
        <TrashSheet
          isOpen={trashOpen}
          onDismiss={() => setTrashOpen(false)}
          target={{ paneId, place: f.place }}
          root={f.root}
          notify={notify}
          onRestored={(entry, path) => {
            void f.restored(path)
            if (entry.kind !== 'discard') return
            setRewritten((r) => ({ ...r, [path]: (r[path] ?? 0) + 1 }))
            changesRefresh(f.root as string)
          }}
          onRootChanged={f.rootChanged}
        />
      )}
      {creating !== undefined && (
        <NewFileDialog
          paneId={paneId}
          place={f.place}
          root={creating}
          initialPath={focusedDir(f, focused)}
          onClose={() => setCreating(undefined)}
          onCreated={f.created}
          onRootChanged={f.rootChanged}
          onRefresh={f.refresh}
        />
      )}
      {renaming && (
        <RenameFileDialog
          paneId={paneId}
          place={renaming.place}
          root={renaming.root}
          path={renaming.path}
          reveal={renaming.revealed}
          onClose={() => setRenaming(undefined)}
          onRenamed={(to, reveal, changed) =>
            onRenamed(renaming, to, reveal, changed)
          }
          onOpen={(p) => f.open(p, { pin: true })}
          onRootChanged={f.rootChanged}
          onRefresh={f.refresh}
        />
      )}
      {downloading && (
        <ConfirmDialog
          isOpen
          title={t('files.download.askSensitive')}
          confirmLabel={t('files.download')}
          onConfirm={() => {
            setDownloading(undefined)
            download(downloading.root, downloading.path, true)
          }}
          onCancel={() => setDownloading(undefined)}
        >
          <Trans
            k="files.download.askSensitiveBody"
            tags={{ name: () => visibleUnsafe(baseName(downloading.path)) }}
          />
        </ConfirmDialog>
      )}
      {deleting && (
        <DeleteFileDialog
          paneId={paneId}
          place={deleting.place}
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
      {closingTab && (
        <DiscardTabDialog
          name={splitPath(closingTab.path)[1]}
          onConfirm={() => {
            setClosing(undefined)
            f.close(closingTab.id)
          }}
          onCancel={() => setClosing(undefined)}
        />
      )}
      <RootCloseDialog count={moved} onResolve={f.resolveRootClose} />
      <ReviewCommentSheet
        target={review.target}
        onSave={review.save}
        onClose={review.close}
      />
      <div
        ref={panelRef}
        id={panelId}
        tabIndex={-1}
        // A tab panel only below the tab bar
        {...(tabBar && {
          role: 'tabpanel',
          'aria-labelledby': tabElementId(panelId, f.activeId),
        })}
        className="flex min-h-0 flex-1 flex-col outline-none"
        onPaste={onPaste}
      >
        {tab ? (
          <FileViewer
            // A new tab, root or path starts unrevealed unless the tab was
            // shown: a Show never carries over to another file
            key={`${tab.id}\u0000${f.root}\u0000${tab.path}\u0000${rewritten[tab.path] ?? 0}`}
            paneId={paneId}
            place={f.place}
            root={f.root}
            draftRoot={tab.root}
            path={tab.path}
            wrapByDefault={isMobile || settings.editorWrap}
            compact={isMobile}
            anchor={tab.anchor}
            scrollTop={tab.scrollTop}
            line={tab.line}
            col={tab.col}
            jump={tab.jump}
            tableLayout={tab.table}
            onTableLayout={(l) => f.setTableLayout(tab.id, l)}
            backTo={tab.history[tab.history.length - 1]?.path}
            onClose={f.back}
            onFollow={onFollow}
            onRootChanged={f.rootChanged}
            notify={notify}
            // The server refuses a view-only client both as well
            canEdit={!readOnly}
            canReveal={!readOnly}
            // The file this view just created opens into editing
            startEditing={!!tab.intent && tab.root === f.root}
            initialReveal={tab.reveal}
            pinned={tab.pinned}
            onPin={() => f.pin(tab.id)}
            onRevealed={() => f.setReveal(tab.id)}
            onMissingChange={(missing) => f.setMissing(tab.id, missing)}
            // Nothing to see in this tab: it closes, unless a link led here
            onCancelReveal={tab.history.length ? f.back : () => f.close(tab.id)}
            onScroll={(top) => f.setScroll(tab.id, top)}
            onCloseTab={() => requestClose(tab.id)}
            headerExtra={openFiles}
            onRename={
              canRename
                ? ({ revealed }) => askRename(tab.path, revealed)
                : undefined
            }
            // A tab of a root the pane has left closes, unless edited, and
            // the viewer offers this only while not editing: the path is
            // under the root a link names
            onOpenWindow={
              openWindow &&
              ((e) =>
                openWindow(
                  { view: 'files', file: tab.path, place: f.place },
                  e,
                ))
            }
            // A sensitive file offers it only once shown. Never through a
            // link the tree knows of: the server refuses it
            onDownload={
              canDownload && !throughLink(f, tab.path)
                ? ({ revealed }) => askDownload(tab.path, false, revealed)
                : undefined
            }
            onDelete={
              canDelete
                ? ({ hash, sensitive }) =>
                    setDeleting({
                      // A file opens once the root is read
                      root: f.root as string,
                      place: f.place,
                      path: tab.path,
                      kind: 'file',
                      sensitive,
                      hash,
                    })
                : undefined
            }
            onLineComment={
              commenting ? (r) => review.open(tab.path, 'file', r) : undefined
            }
            commentedLines={commented}
          />
        ) : root?.error ? (
          <ViewMessage>{t(ERRORS[root.error])}</ViewMessage>
        ) : !root?.entries ? (
          <SkeletonLines label={t('files.loading')} icon className="flex-1" />
        ) : (
          <>
            <div className="flex shrink-0 justify-center border-b border-border px-2 py-1.5">
              <SegmentedControl
                label={t('files.pane')}
                value={pane}
                onChange={setPane}
                options={[
                  { value: 'files', content: t('common.files') },
                  { value: 'search', content: t('files.pane.search') },
                ]}
                className="w-full [&>button]:flex-1"
              />
            </div>
            {pane === 'search' ? (
              <ContentSearch
                paneId={paneId}
                place={f.place}
                root={f.root}
                state={search}
                onState={patchSearch}
                refreshTick={refreshTick}
                focusTick={focusSearch}
                onPick={(p, m) =>
                  f.open(p, { line: m.line, col: matchStart(m) })
                }
                onRootChanged={f.rootChanged}
              />
            ) : (
              <FileSearch
                paneId={paneId}
                place={f.place}
                root={f.root}
                isRepo={f.isRepo}
                query={query}
                onQuery={setQuery}
                refreshTick={refreshTick}
                onPick={(p) => f.reveal(p)}
                onRootChanged={f.rootChanged}
                hideIgnored={readOnly}
              >
                {root.entries.length === 0 ? (
                  <ViewMessage>{t('files.tree.dirEmpty')}</ViewMessage>
                ) : (
                  <FileTree
                    state={f}
                    items={treeItems}
                    dropAt={dropAt}
                    focused={focused}
                    onFocus={setFocused}
                    onToggle={f.toggle}
                    onOpen={openFromTree}
                    onDelete={canDelete ? askDelete : undefined}
                    onDownload={
                      canDownload
                        ? (path, entry) =>
                            askDownload(path, entry.sensitive, false)
                        : undefined
                    }
                    onRename={
                      canRename
                        ? // A sensitive name is asked about: renaming it to an
                          // ordinary one would show what it holds
                          (path) => askRename(path, false)
                        : undefined
                    }
                  />
                )}
              </FileSearch>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// The upload running, and the ask before writing where secrets may be: its
// own component, so each step of the progress re-renders only this, never
// the tree. Stays mounted so a screen reader announces each file; the
// percentage is not read out at every step. A live region, not a status
// role: the content search's result count is the panel's status.
function UploadStatusRow() {
  const { t } = useT()
  const { status: up, asking } = useFileUploads()
  return (
    <>
      <div
        aria-live="polite"
        data-testid="upload-status"
        className={up ? '' : 'sr-only'}
      >
        {up && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[12px] text-fg-muted">
            <span className="min-w-0 flex-1 truncate">
              {up.waiting
                ? t('files.upload.waiting')
                : t('files.upload.running', { name: visibleUnsafe(up.name) })}
              {up.total > 1 &&
                ` ${t('files.upload.progress', { index: up.index, total: up.total })}`}
            </span>
            {!up.waiting && (
              <span aria-hidden="true" className="shrink-0 tabular-nums">
                {up.percent} %
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={cancelUploads}
              disabled={!up.canCancel}
            >
              {t('common.cancel')}
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        isOpen={!!asking}
        title={t('files.upload.askSensitive')}
        confirmLabel={t('files.upload.confirm')}
        // Enter keeps the files away from the secrets
        defaultAction="cancel"
        onConfirm={() => confirmUpload(true)}
        onCancel={() => confirmUpload(false)}
      >
        {/* The root too: the ask may show in another pane's Files */}
        {asking &&
          t(
            asking.dir === '.'
              ? 'files.upload.askSensitiveTop'
              : 'files.upload.askSensitiveBody',
            {
              name: visibleUnsafe(asking.name),
              dir: visibleUnsafe(asking.dir),
              root: visibleUnsafe(asking.root),
            },
          )}
      </ConfirmDialog>
    </>
  )
}

// Whether a component of path is a symbolic link, as far as the tree has read
// the directories on it
function throughLink(f: FilesState, path: string): boolean {
  const parts = path.split('/')
  return parts.some((name, i) => {
    const dir = parts.slice(0, i).join('/')
    return f.dirs[dir]?.entries?.some(
      (e) => e.name === name && e.type === 'symlink',
    )
  })
}

function FileTree({
  state,
  items,
  dropAt,
  focused,
  onFocus: setFocused,
  onToggle,
  onOpen,
  onDelete,
  onRename,
  onDownload,
}: {
  state: FilesState
  // The rows by path, kept by the view: it focuses an uploaded file's
  items: { current: Map<string, HTMLElement> }
  // The folder files dragged over would go in, highlighted
  dropAt?: string
  focused?: string
  onFocus: (path: string) => void
  onToggle: (path: string) => void
  // Opens the file in the preview tab
  onOpen: (path: string) => void
  // Offered on each row (its menu, the Delete key) when deleting is allowed
  onDelete?: (path: string, entry: FileEntry) => void
  // Offered on each file's row when renaming is allowed
  onRename?: (path: string, entry: FileEntry) => void
  // Offered on each regular file's row when downloading is allowed (the
  // server refuses a symlink)
  onDownload?: (path: string, entry: FileEntry) => void
}) {
  const { t } = useT()
  const rows = visibleRows(state)
  const entries = rows.filter((r) => r.kind === 'entry')
  const current = entries.find((r) => r.path === focused) ?? entries[0]
  // A row after the first listing (a folder opened, a file made) fades in;
  // another root or Place lists afresh
  const isNew = useNewKeys(
    entries.map((r) => r.path),
    `${state.root}\0${state.place}`,
  )

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
      aria-label={t('common.files')}
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-y-auto py-1"
    >
      {rows.map((r) =>
        r.kind === 'note' ? (
          <div
            key={r.path}
            // A drop on a folder's note goes in that folder
            data-path={r.dir}
            className="py-1.5 pr-3 text-[12px] text-fg-subtle"
            style={{ paddingLeft: `${r.level * 16 + 12}px` }}
          >
            {t(r.text)}
          </div>
        ) : (
          <TreeItem
            key={r.path}
            row={r}
            expanded={isDir(r.entry) ? !!state.expanded[r.path] : undefined}
            tabbable={r === current}
            entering={isNew(r.path)}
            dropTarget={r.path === dropAt}
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
            onRename={
              onRename && r.entry.type === 'file'
                ? () => onRename(r.path, r.entry)
                : undefined
            }
            onDownload={
              onDownload && r.entry.type === 'file'
                ? () => onDownload(r.path, r.entry)
                : undefined
            }
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
  entering,
  dropTarget,
  notEmpty,
  itemRef,
  onClick,
  onDelete,
  onRename,
  onDownload,
}: {
  row: EntryRow
  expanded?: boolean
  tabbable: boolean
  entering: boolean
  dropTarget: boolean
  notEmpty: boolean
  itemRef: (el: HTMLElement | null) => void
  onClick: () => void
  onDelete?: () => void
  onRename?: () => void
  onDownload?: () => void
}) {
  const { t } = useT()
  const { entry, level } = row
  const hasMenu = !!(onDelete || onRename || onDownload)
  const [menuOpen, setMenuOpen] = useState(false)
  // A finger resting on a row with a menu opens it, as the … button does
  const press = useLongPress(() => setMenuOpen(true))
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
      // Where a drop on the row goes is worked out from it (dropFolder)
      data-path={row.path}
      onClick={onClick}
      {...(hasMenu && press)}
      className={`group flex min-h-9 [-webkit-touch-callout:none] cursor-default items-center gap-1.5 pr-1 text-[13px] hover:bg-surface pointer-coarse:min-h-touch ${entering ? `transition-[opacity,translate] duration-(--duration-base) ease-standard ${ENTER_FROM}` : ''} ${dropTarget ? 'bg-accent/10 ring-1 ring-accent ring-inset' : ''} ${FOCUS_RING} focus-visible:-outline-offset-2 ${can ? 'text-fg' : 'text-fg-subtle'}`}
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
          title={t('files.mayContainSecrets')}
        >
          <Lock size={12} aria-hidden="true" />
          <span className="sr-only">{t('files.sensitive')}</span>
        </span>
      )}
      {hasMenu && (
        // Its own clicks and keys never reach the row (open, toggle, the
        // tree's keys). Shown on hover or focus with a mouse, always on a
        // touch screen.
        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
        >
          <Menu
            label={t('files.tree.actions', { name: entry.name })}
            trigger={<Ellipsis size={14} aria-hidden="true" />}
            triggerTabIndex={-1}
            triggerSize="sm"
            open={menuOpen}
            onOpenChange={setMenuOpen}
          >
            {onDownload && (
              <MenuItem icon={<Download size={16} />} onSelect={onDownload}>
                {t('files.download')}
              </MenuItem>
            )}
            {onRename && (
              <MenuItem
                icon={<TextCursorInput size={16} />}
                onSelect={onRename}
              >
                {t('files.rename.title')}
              </MenuItem>
            )}
            {onDelete && (
              <MenuItem
                icon={<Trash2 size={16} />}
                danger
                disabled={dir && notEmpty}
                onSelect={onDelete}
              >
                {dir && notEmpty
                  ? t('files.tree.deleteNotEmpty')
                  : t('files.delete')}
              </MenuItem>
            )}
          </Menu>
        </div>
      )}
    </div>
  )
}

export default FilesView
