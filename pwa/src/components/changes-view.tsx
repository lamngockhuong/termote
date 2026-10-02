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
}: ViewProps) {
  if (!session.paneId) return <ViewMessage>Loading…</ViewMessage>
  return (
    <PaneChanges
      paneId={session.paneId}
      isMobile={isMobile}
      notify={notify}
      showView={showView}
    />
  )
}

function PaneChanges({
  paneId,
  isMobile,
  notify,
  showView,
}: { paneId: string } & Pick<ViewProps, 'isMobile' | 'notify' | 'showView'>) {
  const c = useGitChanges(paneId)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [reload, setReload] = useState(0)

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
  if (selected) {
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
        onClose={() => setSelected(null)}
        onRootChanged={c.rootChanged}
        onFollow={follow}
        notify={notify}
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
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {c.error && <Banner variant="warning">{ERRORS[c.error]}</Banner>}
        {c.truncated && <Banner>Only the first 5000 changes are shown</Banner>}
        {groups(c.entries).map(([title, items]) => (
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
                      setSelected({
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
