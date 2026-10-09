import { Lock } from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import type { ViewProps } from '../app-views'
import {
  FOLLOW_NOTICES,
  followInFiles,
  useDirtyCheck,
} from '../hooks/use-files'
import {
  type ChangeSide,
  type ChangesError,
  type ChangeTab,
  changeKey,
  findEntry,
  useGitChanges,
} from '../hooks/use-git-changes'
import type { ChangeEntry } from '../hooks/use-mux-api'
import { splitPath } from '../utils/files-format'
import type { LinkPath } from '../utils/markdown-links'
import { FILES_VIEW_ID } from '../view-ids'
import { DiffViewer } from './diff-viewer'
import { FileTabBar, type TabListProps, tabElementId } from './file-tab-bar'
import { FileViewer } from './file-viewer'
import { OpenFilesButton, OpenFilesSheet } from './open-files-sheet'
import { PaneDirHeader, ViewMessage } from './pane-dir-header'
import { DiscardTabDialog, RootCloseDialog } from './tab-close-dialogs'
import { Banner } from './ui/banner'
import { FOCUS_RING } from './ui/button'

const ERRORS: Record<ChangesError, string> = {
  unsupported: 'Not supported by this backend',
  'not-found': 'Directory not found',
  'not-allowed': "This directory can't be shown",
  'view-only': 'View only: files show in a git repository only',
  timeout: 'git took too long; trying again',
  unavailable: 'Could not read the changes',
}

// Letters as git status writes them, and what a screen reader says
export const STATUS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflict',
  '?': 'Untracked',
}

const TONE: Record<string, string> = {
  A: 'text-success',
  '?': 'text-success',
  D: 'text-danger',
  U: 'text-warning',
}

// Past this many entries the list gets a filter box
export const CHANGES_FILTER_MIN = 15

// The entries whose path (or a rename's source) holds q, without case
function filterEntries(entries: ChangeEntry[], q: string) {
  const needle = q.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter(
    (e) =>
      e.path.toLowerCase().includes(needle) ||
      !!e.orig?.toLowerCase().includes(needle),
  )
}

// How soon after a diff opens from the list a double click still pins it
export const LIST_DOUBLE_CLICK_MS = 500

// What a tab shows of its side: the file's name (the staged side says so,
// next to the same file's other side), its path and directory
function tabLabel(t: ChangeTab) {
  const [dir, name] = splitPath(t.path)
  const side = t.staged ? 'Staged' : 'Not staged'
  return {
    name: t.staged ? `${name} (staged)` : name,
    title: `${t.orig ? `${t.orig} → ` : ''}${t.path} (${side})`,
    detail: dir ? `${dir} · ${side}` : side,
  }
}

interface Item {
  entry: ChangeEntry
  staged: boolean
  code: string
}

// Staged and unstaged changes of one file show in both groups, each opening
// its own side's diff.
function groups(entries: ChangeEntry[]): [string, Item[]][] {
  const conflicts: Item[] = []
  const staged: Item[] = []
  const changes: Item[] = []
  const untracked: Item[] = []
  for (const entry of entries) {
    if (entry.conflict) {
      conflicts.push({ entry, staged: false, code: 'U' })
      continue
    }
    if (entry.staged) staged.push({ entry, staged: true, code: entry.staged })
    if (entry.unstaged === '?')
      untracked.push({ entry, staged: false, code: '?' })
    else if (entry.unstaged)
      changes.push({ entry, staged: false, code: entry.unstaged })
  }
  const all: [string, Item[]][] = [
    ['Conflicts', conflicts],
    ['Staged', staged],
    ['Changes', changes],
    ['Untracked', untracked],
  ]
  return all.filter(([, items]) => items.length > 0)
}

// Changes: what git status reports under the pane's root, grouped, and the
// diffs opened from it, one tab each (a tab bar on a desktop, a sheet of open
// files on a phone). The same component is the mobile view and the desktop
// panel.
export function ChangesView({
  session,
  isMobile,
  notify,
  showView,
  readOnly,
}: ViewProps) {
  if (!session.paneId) return <ViewMessage>Loading…</ViewMessage>
  return (
    <PaneChanges
      paneId={session.paneId}
      isMobile={isMobile}
      notify={notify}
      showView={showView}
      readOnly={readOnly}
    />
  )
}

function PaneChanges({
  paneId,
  isMobile,
  notify,
  showView,
  readOnly,
}: { paneId: string } & Pick<
  ViewProps,
  'isMobile' | 'notify' | 'showView' | 'readOnly'
>) {
  const c = useGitChanges(paneId)
  const isDirty = useDirtyCheck(paneId)
  const tab = c.active
  const [reload, setReload] = useState(0)
  // The tab with unsaved changes the Discard box is open for
  const [closing, setClosing] = useState<string>()
  // The list's filter: local to this view, so leaving it (or the side
  // panel closing) clears it, and so does a move of the root
  const [filter, setFilter] = useState('')
  const [filterRoot, setFilterRoot] = useState(c.root)
  if (filterRoot !== c.root) {
    setFilterRoot(c.root)
    setFilter('')
  }
  // A list short enough to lose the box loses its text too
  if (filter && c.entries.length <= CHANGES_FILTER_MIN) setFilter('')
  // The side a click in the list just opened. The diff takes the list's
  // place under the pointer, so a double click's second click lands on the
  // diff: a double click that soon pins the tab.
  const listOpened = useRef<{ key: string; at: number }>(undefined)
  const openFromList = (side: ChangeSide) => {
    listOpened.current = { key: changeKey(side), at: Date.now() }
    c.open(side)
  }
  const pinIfDoubleClick = () => {
    const o = listOpened.current
    listOpened.current = undefined
    if (
      tab &&
      o?.key === changeKey(tab) &&
      Date.now() - o.at < LIST_DOUBLE_CLICK_MS
    )
      c.pin(tab.id)
  }

  // Tabs whose side git no longer lists closed: one notice per poll
  const seenGone = useRef(c.gone.count)
  useEffect(() => {
    if (c.gone.count > seenGone.current) {
      const { names } = c.gone
      notify(
        names.length === 1
          ? `No changes left in ${names[0]}`
          : `No changes left in ${names.length} files`,
      )
    }
    seenGone.current = c.gone.count
  }, [c.gone, notify])

  const seenChanges = useRef(c.rootChanges)
  useEffect(() => {
    if (c.rootChanges > seenChanges.current)
      notify("The pane's directory changed")
    seenChanges.current = c.rootChanges
  }, [c.rootChanges, notify])

  // A link of a previewed file opens in the Files view
  const follow = useCallback(
    async (target: LinkPath) => {
      const result = await followInFiles(paneId, target)
      if (result === 'opened') showView(FILES_VIEW_ID)
      const notice = FOLLOW_NOTICES[result]
      if (notice) notify(notice)
    },
    [paneId, showView, notify],
  )

  const refresh = () => {
    c.refresh()
    setReload((n) => n + 1)
  }

  // Only an editor holds unsaved changes
  const tabDirty = (t: ChangeTab) => t.editing && isDirty(t.path)
  // A tab with unsaved changes closes only once the user says so, unless
  // another tab edits the same file: the changes stay there
  const requestClose = (id: string) => {
    const t = c.tabs.find((x) => x.id === id)
    const shared = c.tabs.some(
      (x) => x !== t && x.editing && x.path === t?.path,
    )
    if (t && tabDirty(t) && !shared) setClosing(id)
    else c.close(id)
  }

  // What the tab bar's tabs show (desktop)
  const panelId = useId()
  const tabBar = !isMobile && c.tabs.length > 0
  const tabList: TabListProps = {
    tabs: c.tabs.map((t) => ({
      id: t.id,
      ...tabLabel(t),
      pinned: t.pinned,
      dirty: tabDirty(t),
    })),
    activeId: c.activeId,
    homeLabel: 'Changes',
    onActivate: c.activate,
    onClose: requestClose,
    onPin: c.pin,
    panelId,
  }
  // A phone has a sheet of the open diffs in place of the tab bar
  const [listing, setListing] = useState(false)
  const openFiles = isMobile && c.tabs.length > 0 && (
    <OpenFilesButton count={c.tabs.length} onClick={() => setListing(true)} />
  )
  const closingTab = c.tabs.find((t) => t.id === closing)

  let body: ReactNode
  if (tab?.editing) {
    body = (
      <FileViewer
        key={`${tab.id}\u0000${c.root}\u0000${tab.path}`}
        paneId={paneId}
        root={c.root}
        path={tab.path}
        wrapByDefault={isMobile}
        compact={isMobile}
        backLabel="Back to the diff"
        onClose={() => c.setEditing(tab.id, false)}
        onFollow={follow}
        onRootChanged={c.rootChanged}
        notify={notify}
        canEdit
        startEditing
        initialReveal={tab.revealed}
        onRevealed={() => c.setReveal(tab.id)}
        scrollTop={tab.editScrollTop}
        onScroll={(top) => c.setScroll(tab.id, top)}
        headerExtra={openFiles}
        onSaved={() => {
          // Back to the diff of what is not staged, read again
          c.saved(tab.id)
          refresh()
        }}
      />
    )
  } else if (tab) {
    body = (
      <DiffViewer
        // A new tab, root or side starts unrevealed unless the tab was
        // shown: a Show never carries over to another file
        key={`${tab.id}\u0000${c.root}\u0000${changeKey(tab)}`}
        paneId={paneId}
        root={c.root}
        entry={findEntry(c.entries, tab)}
        waiting={!c.loaded}
        path={tab.path}
        staged={tab.staged}
        isMobile={isMobile}
        reload={reload}
        onClose={() => c.activate(null)}
        onRootChanged={c.rootChanged}
        onFollow={follow}
        notify={notify}
        reveal={tab.revealed}
        onReveal={() => c.setReveal(tab.id)}
        // Nothing to see in this tab: it closes
        onCancelReveal={() => c.close(tab.id)}
        scrollTop={tab.scrollTop}
        onScroll={(top) => c.setScroll(tab.id, top)}
        headerExtra={openFiles}
        // The server refuses a view-only client both as well
        canReveal={!readOnly}
        onEdit={readOnly ? undefined : () => c.setEditing(tab.id, true)}
      />
    )
  } else if (!c.loaded) {
    body = <ViewMessage>Loading…</ViewMessage>
  } else if (c.error && c.entries.length === 0) {
    body = <ViewMessage>{ERRORS[c.error]}</ViewMessage>
  } else if (!c.isRepo) {
    body = <ViewMessage>Not a git repository: {c.root}</ViewMessage>
  } else if (c.entries.length === 0) {
    body = <ViewMessage>No changes</ViewMessage>
  } else {
    const filtering = c.entries.length > CHANGES_FILTER_MIN
    const shown = groups(
      filtering ? filterEntries(c.entries, filter) : c.entries,
    )
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {c.error && <Banner variant="warning">{ERRORS[c.error]}</Banner>}
        {c.truncated && <Banner>Only the first 5000 changes are shown</Banner>}
        {filtering && (
          <div className="sticky top-0 z-10 border-b border-border bg-bg px-2 py-1.5">
            <input
              type="search"
              aria-label="Filter changes"
              placeholder="Filter changes…"
              value={filter}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape' || !filter) return
                e.preventDefault()
                setFilter('')
              }}
              // 16px on a phone: iOS zooms the page into a smaller field
              className="h-8 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-base text-fg outline-none placeholder:text-fg-subtle focus:border-accent md:text-[13px] pointer-coarse:h-touch"
            />
          </div>
        )}
        {shown.length === 0 && (
          <p role="status" className="m-0 px-3 py-2 text-[12px] text-fg-subtle">
            No changes match
          </p>
        )}
        {shown.map(([title, items]) => (
          <section key={title} aria-label={title}>
            <h3 className="px-3 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted ui-terminal:font-label">
              {title} <span className="text-fg-subtle">{items.length}</span>
            </h3>
            <ul>
              {items.map((it) => (
                <li key={`${it.staged}:${it.entry.orig}:${it.entry.path}`}>
                  <ChangeRow
                    item={it}
                    onOpen={() =>
                      openFromList({
                        path: it.entry.path,
                        orig: it.entry.orig,
                        staged: it.staged,
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    )
  }

  const moved = c.pendingRootClose?.length ?? 0
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onDoubleClick={pinIfDoubleClick}
    >
      <PaneDirHeader root={c.root} branch={c.branch} onRefresh={refresh}>
        {!tab && openFiles}
      </PaneDirHeader>
      {tabBar && <FileTabBar {...tabList} />}
      <OpenFilesSheet
        {...tabList}
        isOpen={isMobile && listing}
        onDismiss={() => setListing(false)}
      />
      {closingTab && (
        <DiscardTabDialog
          name={splitPath(closingTab.path)[1]}
          onConfirm={() => {
            setClosing(undefined)
            c.close(closingTab.id)
          }}
          onCancel={() => setClosing(undefined)}
        />
      )}
      <RootCloseDialog count={moved} onResolve={c.resolveRootClose} />
      <div
        id={panelId}
        // A tab panel only below the tab bar
        {...(tabBar && {
          role: 'tabpanel',
          'aria-labelledby': tabElementId(panelId, c.activeId),
        })}
        className="flex min-h-0 flex-1 flex-col"
      >
        {body}
      </div>
    </div>
  )
}

function ChangeRow({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const { entry, code } = item
  const [dir, name] = splitPath(entry.path)
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex min-h-9 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-surface pointer-coarse:min-h-touch ${FOCUS_RING} focus-visible:-outline-offset-2`}
    >
      <span
        aria-hidden="true"
        className={`w-3 shrink-0 font-term font-semibold ${TONE[code] ?? 'text-info'}`}
      >
        {code}
      </span>
      <span className="sr-only">{STATUS[code] ?? code}: </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
        <span className="shrink-0 font-medium text-fg">{name}</span>
        <span className="truncate text-[12px] text-fg-subtle">
          {entry.orig ? `${entry.orig} → ` : ''}
          {dir}
        </span>
      </span>
      {entry.sensitive && (
        <span
          className="flex shrink-0 items-center text-warning"
          title="May contain secrets"
        >
          <Lock size={12} aria-hidden="true" />
          <span className="sr-only">Sensitive</span>
        </span>
      )}
    </button>
  )
}

export default ChangesView
