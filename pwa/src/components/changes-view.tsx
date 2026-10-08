import { Lock } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { ViewProps } from '../app-views'
import { FOLLOW_NOTICES, followInFiles } from '../hooks/use-files'
import { type ChangesError, useGitChanges } from '../hooks/use-git-changes'
import type { ChangeEntry } from '../hooks/use-mux-api'
import { splitPath } from '../utils/files-format'
import type { LinkPath } from '../utils/markdown-links'
import { FILES_VIEW_ID } from '../view-ids'
import { DiffViewer } from './diff-viewer'
import { FileViewer } from './file-viewer'
import { PaneDirHeader, ViewMessage } from './pane-dir-header'
import { Banner } from './ui/banner'
import { FOCUS_RING } from './ui/button'

const ERRORS: Record<ChangesError, string> = {
  unsupported: 'Not supported by this backend',
  'not-found': 'Directory not found',
  'not-allowed': "This directory can't be shown",
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

interface Selected {
  path: string
  orig?: string
  staged: boolean
}

// The entry of the side the diff was opened from, matched like the server
// does
function findEntry(entries: ChangeEntry[], s: Selected) {
  return entries.find(
    (e) =>
      e.path === s.path &&
      e.orig === s.orig &&
      (s.staged ? e.staged !== '' : e.unstaged !== '' || !!e.conflict),
  )
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
// diff of the file chosen. The same component is the mobile view and the
// desktop panel.
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
  const [selected, setSelected] = useState<Selected | null>(null)
  const [reload, setReload] = useState(0)
  // The working tree's file being edited, in place of the diff. A poll or
  // a move of the root never closes it: the draft is the pane's.
  const [editing, setEditing] = useState<string>()
  // The file (root and path) a sensitive diff was shown for, while it stays
  // open: editing it and coming back to either side asks only once
  const [revealed, setRevealed] = useState<string>()
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
  // The side a save went back to: once the status no longer lists it, the
  // file matches the index and the list shows again
  const saved = useRef<Selected | null>(null)
  // Another entry, or back to the list: a Show of the last one ends there
  const select = (s: Selected | null) => {
    saved.current = null
    setRevealed(undefined)
    setSelected(s)
  }

  useEffect(() => {
    const s = saved.current
    if (!s || !c.loaded || findEntry(c.entries, s)) return
    saved.current = null
    setSelected(null)
    notify(`No changes left in ${s.path.slice(s.path.lastIndexOf('/') + 1)}`)
  }, [c.entries, c.loaded, notify])

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

  let body: ReactNode
  const revealKey = selected ? `${c.root}\u0000${selected.path}` : undefined
  if (selected && editing) {
    body = (
      <FileViewer
        key={`${c.root}\u0000${editing}`}
        paneId={paneId}
        root={c.root}
        path={editing}
        wrapByDefault={isMobile}
        compact={isMobile}
        backLabel="Back to the diff"
        onClose={() => setEditing(undefined)}
        onFollow={follow}
        onRootChanged={c.rootChanged}
        notify={notify}
        canEdit
        startEditing
        initialReveal={revealed === revealKey}
        onSaved={() => {
          // Back to the diff of what is not staged, read again
          const s = { ...selected, staged: false }
          setSelected(s)
          saved.current = s
          setEditing(undefined)
          refresh()
        }}
      />
    )
  } else if (selected) {
    body = (
      <DiffViewer
        // A new root or entry starts unrevealed: a Show never carries over
        key={`${c.root}\u0000${selected.staged}:${selected.orig}:${selected.path}`}
        paneId={paneId}
        root={c.root}
        entry={findEntry(c.entries, selected)}
        waiting={!c.loaded}
        path={selected.path}
        staged={selected.staged}
        isMobile={isMobile}
        reload={reload}
        onClose={() => select(null)}
        onRootChanged={c.rootChanged}
        onFollow={follow}
        notify={notify}
        reveal={revealed === revealKey}
        onReveal={() => setRevealed(revealKey)}
        // A view-only client is kept from editing here only: the server
        // has no roles yet
        onEdit={readOnly ? undefined : () => setEditing(selected.path)}
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
                      select({
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneDirHeader root={c.root} branch={c.branch} onRefresh={refresh} />
      {body}
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
