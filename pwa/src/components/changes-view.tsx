import { GitCommitHorizontal, Minus, Plus, Undo2 } from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ViewProps } from '../app-views'
import {
  FOLLOW_NOTICES,
  followInFiles,
  openInFiles,
  useDirtyCheck,
} from '../hooks/use-files'
import {
  type ChangeSide,
  type ChangesError,
  type ChangeTab,
  changeKey,
  findEntry,
  openChangeFromLink,
  useGitChanges,
} from '../hooks/use-git-changes'
import {
  type AppliedChange,
  applyChange,
  type ChangeAction,
  type ChangeEntry,
  type DiffHunk,
  type FileDiff,
  RequestError,
  restoreFile,
} from '../hooks/use-mux-api'
import { useReviewComposer } from '../hooks/use-review-composer'
import { useSettings } from '../hooks/use-settings'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { Trans } from '../i18n/trans'
import type { Translate } from '../i18n/translate'
import type { Session } from '../types/session'
import { splitPath } from '../utils/files-format'
import { isFocusWindow } from '../utils/focus-mode'
import type { LinkPath } from '../utils/markdown-links'
import { restoreFailure } from '../utils/restore-failure'
import {
  commentedDiffLines,
  commentedFileLines,
  type ReviewComment,
} from '../utils/review-draft'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { FILES_VIEW_ID } from '../view-ids'
import { ChangeRowButton } from './change-status'
import { CommitView } from './commit-view'
import { type DiffLineAt, DiffViewer } from './diff-viewer'
import {
  APPLY_REFUSED,
  APPLY_STALE,
  DiscardChangeDialog,
} from './discard-change-dialog'
import { FileTabBar, type TabListProps, tabElementId } from './file-tab-bar'
import { FileViewer } from './file-viewer'
import { OpenFilesButton, OpenFilesSheet } from './open-files-sheet'
import { PaneDirHeader, ViewMessage } from './pane-dir-header'
import { ReviewCommentSheet } from './review-comment-sheet'
import { ReviewControl } from './review-panel'
import { DiscardTabDialog, RootCloseDialog } from './tab-close-dialogs'
import { Banner } from './ui/banner'
import { Button, IconButton } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'

const ERRORS: Record<ChangesError, MessageKey> = {
  unsupported: 'files.changes.unsupported',
  'not-found': 'files.changes.notFound',
  'not-allowed': 'files.changes.notAllowed',
  'view-only': 'files.changes.viewOnly',
  timeout: 'files.changes.timeout',
  unavailable: 'files.changes.unavailable',
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
function tabLabel(tab: ChangeTab, t: Translate<MessageKey>) {
  const [dir, name] = splitPath(tab.path)
  const side = t(
    tab.staged ? 'files.changes.staged' : 'files.changes.notStaged',
  )
  const path = `${tab.orig ? `${tab.orig} → ` : ''}${tab.path}`
  return {
    name: tab.staged ? t('files.changes.stagedTab', { name }) : name,
    title: t('files.changes.tabTitle', { path, side }),
    detail: dir ? `${dir} · ${side}` : side,
  }
}

interface Item {
  entry: ChangeEntry
  staged: boolean
  code: string
}

const ACTION_ICON = { stage: Plus, unstage: Minus, discard: Undo2 }

// What a side's buttons act on: the whole file, one of its hunks (from 1),
// or the file of a row, named
type ActionTarget = 'file' | number | { name: string }

const ACTION_LABELS: Record<
  ChangeAction,
  { file: MessageKey; hunk: MessageKey; name: MessageKey }
> = {
  stage: {
    file: 'files.changes.stageFile',
    hunk: 'files.changes.stageHunk',
    name: 'files.changes.stageName',
  },
  unstage: {
    file: 'files.changes.unstageFile',
    hunk: 'files.changes.unstageHunk',
    name: 'files.changes.unstageName',
  },
  discard: {
    file: 'files.changes.discardFile',
    hunk: 'files.changes.discardHunk',
    name: 'files.changes.discardName',
  },
}

// A stage or unstage asked about first, and what failed
const ASK: Record<
  AskedAction,
  { title: MessageKey; confirm: MessageKey; failed: MessageKey }
> = {
  stage: {
    title: 'files.changes.askStage',
    confirm: 'files.changes.stage',
    failed: 'files.changes.stageFailed',
  },
  unstage: {
    title: 'files.changes.askUnstage',
    confirm: 'files.changes.unstage',
    failed: 'files.changes.unstageFailed',
  },
}

// The buttons of a side's actions; what names what they act on for a
// screen reader ("Stage a.ts", "Discard change 2")
function ChangeActions({
  actions,
  what,
  disabled,
  onAction,
}: {
  actions: ChangeAction[]
  what: ActionTarget
  disabled: boolean
  onAction: (a: ChangeAction) => void
}) {
  const { t } = useT()
  return actions.map((a) => {
    const Icon = ACTION_ICON[a]
    const keys = ACTION_LABELS[a]
    const label =
      what === 'file'
        ? t(keys.file)
        : typeof what === 'number'
          ? t(keys.hunk, { n: what })
          : t(keys.name, { name: what.name })
    return (
      <IconButton
        key={a}
        size="sm"
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => onAction(a)}
        className={a === 'discard' ? 'hover:text-danger' : ''}
      >
        <Icon size={15} aria-hidden="true" />
      </IconButton>
    )
  })
}

// A Discard box open for a side, or one hunk of it
interface Discarding {
  root: string
  entry: ChangeEntry
  hunk?: DiffHunk
  // The hash of the file the diff shown was read against
  hash?: string
}

// A stage or unstage of a sensitive file, asked about first
type AskedAction = Exclude<ChangeAction, 'discard'>
interface Asking {
  action: AskedAction
  entry: ChangeEntry
  staged: boolean
  hunk?: DiffHunk
}

// Staged and unstaged changes of one file show in both groups, each opening
// its own side's diff.
function groups(entries: ChangeEntry[]): [MessageKey, Item[]][] {
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
  const all: [MessageKey, Item[]][] = [
    ['files.changes.group.conflicts', conflicts],
    ['files.changes.group.staged', staged],
    ['files.changes.group.changes', changes],
    ['files.changes.group.untracked', untracked],
  ]
  return all.filter(([, items]) => items.length > 0)
}

// Changes: what git status reports under the pane's root, grouped, and the
// diffs opened from it, one tab each (a tab bar on a desktop, a sheet of open
// files on a phone). The same component is the mobile view and the desktop
// panel.
// A review comment's diff line asked for from another view, per pane: shown
// once the Changes view shows that diff
const pendingDiffLines = new Map<string, DiffLineWanted>()

interface DiffLineWanted {
  key: string
  at: DiffLineAt
  // Its diff was shown: leaving it drops the line
  shown?: boolean
  // git no longer lists its diff: never shown, even once it is changed again
  gone?: boolean
}

// Where a review comment is in its diff
function commentLine(c: ReviewComment): DiffLineWanted {
  const side = { path: c.path, orig: c.orig, staged: c.source === 'staged' }
  const at =
    c.removedOnly && c.removed
      ? { n: c.removed.start, old: true, jump: Date.now() }
      : { n: c.start, jump: Date.now() }
  return { key: changeKey(side), at }
}

// Opens the diff of review comment c in paneId's Changes view, telling when
// git no longer lists it; returns where the comment is in it
function openCommentDiff(
  paneId: string,
  c: ReviewComment,
  notify: ViewProps['notify'],
  t: Translate<MessageKey>,
): DiffLineWanted {
  const wanted = commentLine(c)
  void openChangeFromLink(paneId, {
    path: c.path,
    orig: c.orig,
    staged: c.source === 'staged',
  }).then((shown) => {
    if (shown !== false) return
    wanted.gone = true
    notify(t('files.changes.noChangesFor'), { variant: 'warning' })
  })
  return wanted
}

// The same from another view, which then shows Changes: the line is shown
// once the view is
export function openCommentInChanges(
  paneId: string,
  c: ReviewComment,
  notify: ViewProps['notify'],
  t: Translate<MessageKey>,
) {
  pendingDiffLines.set(paneId, openCommentDiff(paneId, c, notify, t))
}

export function ChangesView({
  session,
  isMobile,
  notify,
  showView,
  readOnly,
  openWindow,
  mux,
  sessions,
  openTab,
}: ViewProps) {
  const { t } = useT()
  if (!session.paneId) return <ViewMessage>{t('files.loading')}</ViewMessage>
  return (
    <PaneChanges
      session={session}
      sessions={sessions ?? []}
      openTab={openTab}
      canSendToAgent={!!mux.caps.agentChat}
      paneId={session.paneId}
      isMobile={isMobile}
      notify={notify}
      showView={showView}
      readOnly={readOnly}
      openWindow={openWindow}
      // The server refuses a view-only client's discards as well, and any
      // discard without a trash to keep the file in
      canDiscard={!readOnly && !!mux.caps.trash}
    />
  )
}

function PaneChanges({
  paneId,
  isMobile,
  notify,
  showView,
  readOnly,
  openWindow,
  canDiscard,
  session,
  sessions,
  openTab,
  canSendToAgent,
}: {
  paneId: string
  canDiscard: boolean
  sessions: Session[]
  canSendToAgent: boolean
} & Pick<
  ViewProps,
  | 'isMobile'
  | 'notify'
  | 'showView'
  | 'readOnly'
  | 'openWindow'
  | 'session'
  | 'openTab'
>) {
  const c = useGitChanges(paneId)
  const { settings } = useSettings()
  const { t } = useT()
  const isDirty = useDirtyCheck(paneId)
  const tab = c.active
  // Review comments: never for a view-only client (it cannot send them) or
  // in a window of its own (it keeps nothing on the device)
  const commenting = !readOnly && !isFocusWindow()
  const review = useReviewComposer(paneId, c.root, notify)
  const commented = useMemo(
    () =>
      tab && !tab.editing
        ? commentedDiffLines(
            review.comments,
            c.root,
            tab.path,
            tab.staged ? 'staged' : 'unstaged',
          )
        : undefined,
    [review.comments, c.root, tab],
  )
  // A comment's line to show in its diff, until another diff shows
  const [diffLine, setDiffLine] = useState(() => {
    const wanted = pendingDiffLines.get(paneId)
    pendingDiffLines.delete(paneId)
    return wanted
  })
  const tabKey = tab && !tab.editing ? changeKey(tab) : undefined
  if (diffLine?.gone && !diffLine.shown) setDiffLine(undefined)
  else if (diffLine) {
    const here = tabKey === diffLine.key
    if (here && !diffLine.shown) setDiffLine({ ...diffLine, shown: true })
    else if (!here && diffLine.shown) setDiffLine(undefined)
  }
  const openComment = (cm: ReviewComment) => {
    if (cm.root !== c.root) {
      notify(t('files.changes.otherFolder'), { variant: 'warning' })
      return
    }
    if (cm.source === 'file') {
      openInFiles(paneId, cm.root, cm.path, { line: cm.start })
      showView(FILES_VIEW_ID)
      return
    }
    setDiffLine(openCommentDiff(paneId, cm, notify, t))
  }
  const commentedInEditor = useMemo(
    () =>
      tab?.editing
        ? commentedFileLines(review.comments, c.root, tab.path)
        : undefined,
    [review.comments, c.root, tab],
  )
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
          ? t('files.changes.noneLeftIn', { name: names[0] })
          : t('files.changes.noneLeftMany', { count: names.length }),
      )
    }
    seenGone.current = c.gone.count
  }, [c.gone, notify, t])

  const seenChanges = useRef(c.rootChanges)
  useEffect(() => {
    if (c.rootChanges > seenChanges.current)
      notify(t('files.changes.rootChanged'))
    seenChanges.current = c.rootChanges
  }, [c.rootChanges, notify, t])

  // A link of a previewed file opens in the Files view
  const follow = useCallback(
    async (target: LinkPath) => {
      const result = await followInFiles(paneId, target)
      if (result === 'opened') showView(FILES_VIEW_ID)
      const notice = FOLLOW_NOTICES[result]
      if (notice) notify(t(notice))
    },
    [paneId, showView, notify, t],
  )

  const refresh = () => {
    c.refresh()
    setReload((n) => n + 1)
  }

  // A stage, unstage or discard running: one at a time per pane
  const [running, setRunning] = useState(false)
  const [discarding, setDiscarding] = useState<Discarding>()
  const [asking, setAsking] = useState<Asking>()
  const busy = running || !!discarding
  // What a side offers: only what the server takes for its letter (no
  // conflict, type change or intent to add), nothing to a view-only client
  const actionsOf = (entry: ChangeEntry, staged: boolean): ChangeAction[] => {
    if (readOnly || entry.conflict) return []
    if (staged) return 'MADRC'.includes(entry.staged) ? ['unstage'] : []
    if (!'MD?'.includes(entry.unstaged)) return []
    return canDiscard ? ['stage', 'discard'] : ['stage']
  }
  // Done: the side acted on may be gone, which is no news to tell
  const applied = (entry: ChangeEntry, staged: boolean) => {
    c.expectGone([changeKey({ path: entry.path, orig: entry.orig, staged })])
    refresh()
  }
  const run = async (
    action: ChangeAction,
    entry: ChangeEntry,
    staged: boolean,
    opts: { hunk?: DiffHunk; hash?: string; revealed?: boolean } = {},
  ) => {
    // The list shows only once the root is read
    const root = c.root as string
    if (action === 'discard') {
      setDiscarding({ root, entry, hunk: opts.hunk, hash: opts.hash })
      return
    }
    if (entry.sensitive && !opts.revealed) {
      setAsking({ action, entry, staged, hunk: opts.hunk })
      return
    }
    const name = visibleUnsafe(splitPath(entry.path)[1])
    setRunning(true)
    try {
      await applyChange(paneId, {
        root,
        action,
        path: entry.path,
        orig: entry.orig,
        hunk: opts.hunk?.id,
        reveal: entry.sensitive,
      })
      applied(entry, staged)
    } catch (err) {
      if (err instanceof RequestError && err.status === 409 && err.root) {
        c.rootChanged(err.root)
        return
      }
      const code = err instanceof RequestError ? err.code : ''
      // No answer (a timeout): it may have been applied all the same
      if (!code || APPLY_STALE.has(code)) refresh()
      notify(
        APPLY_REFUSED[code]
          ? t(APPLY_REFUSED[code])
          : t(ASK[action].failed, { name }),
        { variant: 'danger' },
      )
    } finally {
      setRunning(false)
    }
  }

  const undo = async (d: Discarding, trashId: string) => {
    const name = visibleUnsafe(splitPath(d.entry.path)[1])
    try {
      await restoreFile(
        { paneId },
        {
          root: d.root,
          trashId,
          reveal: d.entry.sensitive,
        },
      )
      refresh()
      notify(t('files.changes.restored', { name }), { variant: 'success' })
    } catch (err) {
      const fail = restoreFailure(err, name, undefined, t)
      if (fail.root) c.rootChanged(fail.root)
      notify(fail.message, { variant: fail.variant })
    }
  }

  const discarded = (d: Discarding, res: AppliedChange) => {
    applied(d.entry, false)
    const name = visibleUnsafe(splitPath(d.entry.path)[1])
    const untracked = d.entry.unstaged === '?'
    if (res.permanent) notify(t('files.changes.deletedForGood', { name }))
    else if (!res.trashId) notify(t('files.changes.restored', { name }))
    else {
      const id = res.trashId
      notify(
        t(untracked ? 'files.changes.deleted' : 'files.changes.discarded', {
          name,
        }),
        { action: { label: t('files.undo'), onClick: () => undo(d, id) } },
      )
    }
  }

  // Only an editor holds unsaved changes
  const tabDirty = (tab: ChangeTab) =>
    tab.editing && isDirty(tab.root, tab.path)
  // A tab with unsaved changes closes only once the user says so, unless
  // another tab edits the same file: the changes stay there
  const requestClose = (id: string) => {
    const closed = c.tabs.find((x) => x.id === id)
    const shared = c.tabs.some(
      (x) => x !== closed && x.editing && x.path === closed?.path,
    )
    if (closed && tabDirty(closed) && !shared) setClosing(id)
    else c.close(id)
  }

  // What the tab bar's tabs show (desktop)
  const panelId = useId()
  const tabBar = !isMobile && c.tabs.length > 0
  const tabList: TabListProps = {
    tabs: c.tabs.map((tab) => ({
      id: tab.id,
      ...tabLabel(tab, t),
      pinned: tab.pinned,
      dirty: tabDirty(tab),
    })),
    activeId: c.activeId,
    homeLabel: t('common.changes'),
    onActivate: c.activate,
    onClose: requestClose,
    onPin: c.pin,
    panelId,
  }
  // A phone has a sheet of the open diffs in place of the tab bar
  const [listing, setListing] = useState(false)
  // The last commit, asked for from an empty list; a diff opened (from a
  // review comment) closes it
  const [showCommit, setShowCommit] = useState(false)
  useEffect(() => {
    if (tab) setShowCommit(false)
  }, [tab])
  const openFiles = isMobile && c.tabs.length > 0 && (
    <OpenFilesButton count={c.tabs.length} onClick={() => setListing(true)} />
  )
  const closingTab = c.tabs.find((x) => x.id === closing)

  let body: ReactNode
  if (showCommit && !tab) {
    body = (
      <CommitView
        paneId={paneId}
        root={c.root}
        isMobile={isMobile}
        canReveal={!readOnly}
        onBack={() => setShowCommit(false)}
        onRootChanged={c.rootChanged}
      />
    )
  } else if (tab?.editing) {
    body = (
      <FileViewer
        key={`${tab.id}\u0000${c.root}\u0000${tab.path}`}
        paneId={paneId}
        root={c.root}
        draftRoot={tab.root}
        path={tab.path}
        wrapByDefault={isMobile || settings.editorWrap}
        compact={isMobile}
        backLabel={t('files.changes.backToDiff')}
        onClose={() => c.setEditing(tab.id, false)}
        onFollow={follow}
        onRootChanged={c.rootChanged}
        notify={notify}
        canEdit
        startEditing
        initialReveal={tab.revealed}
        onRevealed={() => c.setReveal(tab.id)}
        scrollTop={tab.editScrollTop}
        // At the diff's first change, unless it was scrolled since
        editAt={
          tab.editLine && tab.editScrollTop === undefined
            ? { line: tab.editLine, jump: 0 }
            : undefined
        }
        onScroll={(top) => c.setScroll(tab.id, top)}
        headerExtra={openFiles}
        onSaved={() => {
          // Back to the diff of what is not staged, read again
          c.saved(tab.id)
          refresh()
        }}
        onLineComment={
          commenting ? (r) => review.open(tab.path, 'file', r) : undefined
        }
        commentedLines={commentedInEditor}
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
        // A diff of a root the pane has left closes: the side is under the
        // root a link names
        onOpenWindow={
          openWindow &&
          ((e) =>
            openWindow(
              {
                view: 'changes',
                file: tab.path,
                staged: tab.staged,
                orig: tab.orig,
              },
              e,
            ))
        }
        // The server refuses a view-only client both as well
        canReveal={!readOnly}
        onEdit={
          readOnly ? undefined : (line) => c.setEditing(tab.id, true, line)
        }
        renderActions={(entry: ChangeEntry, diff?: FileDiff) => (
          <ChangeActions
            actions={actionsOf(entry, tab.staged)}
            what="file"
            disabled={busy}
            onAction={(a) =>
              run(a, entry, tab.staged, {
                hash: diff?.worktreeHash,
                revealed: tab.revealed,
              })
            }
          />
        )}
        renderHunkActions={(entry: ChangeEntry, hunk: DiffHunk, i: number) => (
          <ChangeActions
            actions={actionsOf(entry, tab.staged)}
            what={i + 1}
            disabled={busy}
            onAction={(a) =>
              run(a, entry, tab.staged, { hunk, revealed: tab.revealed })
            }
          />
        )}
        onLineComment={
          commenting
            ? (r) =>
                review.open(
                  tab.path,
                  tab.staged ? 'staged' : 'unstaged',
                  r,
                  tab.orig,
                )
            : undefined
        }
        commentedLines={commented}
        line={diffLine?.key === tabKey ? diffLine?.at : undefined}
      />
    )
  } else if (!c.loaded) {
    body = <ViewMessage>{t('files.loading')}</ViewMessage>
  } else if (c.error && c.entries.length === 0) {
    body = <ViewMessage>{t(ERRORS[c.error])}</ViewMessage>
  } else if (!c.isRepo) {
    body = (
      <ViewMessage>
        {t('files.changes.notRepo', { root: c.root as string })}
      </ViewMessage>
    )
  } else if (c.entries.length === 0) {
    body = (
      <ViewMessage>
        {t('files.changes.clean')}
        <Button size="sm" onClick={() => setShowCommit(true)}>
          <GitCommitHorizontal size={15} aria-hidden="true" />
          {t('files.changes.showLastCommit')}
        </Button>
      </ViewMessage>
    )
  } else {
    const filtering = c.entries.length > CHANGES_FILTER_MIN
    const shown = groups(
      filtering ? filterEntries(c.entries, filter) : c.entries,
    )
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {c.error && <Banner variant="warning">{t(ERRORS[c.error])}</Banner>}
        {c.truncated && <Banner>{t('files.changes.truncated')}</Banner>}
        {filtering && (
          <div className="sticky top-0 z-10 border-b border-border bg-bg px-2 py-1.5">
            <input
              type="search"
              aria-label={t('files.changes.filter')}
              placeholder={t('files.changes.filterPlaceholder')}
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
            {t('files.changes.noMatch')}
          </p>
        )}
        {shown.map(([title, items]) => (
          <section key={title} aria-label={t(title)}>
            <h3 className="px-3 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted ui-terminal:font-label">
              {t(title)} <span className="text-fg-subtle">{items.length}</span>
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
                    actions={
                      <ChangeActions
                        actions={actionsOf(it.entry, it.staged)}
                        what={{ name: splitPath(it.entry.path)[1] }}
                        disabled={busy}
                        onAction={(a) => run(a, it.entry, it.staged)}
                      />
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
      <ReviewCommentSheet
        target={review.target}
        onSave={review.save}
        onClose={review.close}
      />
      {discarding && (
        <DiscardChangeDialog
          paneId={paneId}
          root={discarding.root}
          entry={discarding.entry}
          hunk={discarding.hunk}
          hash={discarding.hash}
          onClose={() => setDiscarding(undefined)}
          onDiscarded={(res) => discarded(discarding, res)}
          onRootChanged={c.rootChanged}
          onRefresh={refresh}
        />
      )}
      {asking && (
        <ConfirmDialog
          isOpen
          title={t(ASK[asking.action].title)}
          confirmLabel={t(ASK[asking.action].confirm)}
          onConfirm={() => {
            setAsking(undefined)
            run(asking.action, asking.entry, asking.staged, {
              hunk: asking.hunk,
              revealed: true,
            })
          }}
          onCancel={() => setAsking(undefined)}
        >
          <Trans
            k="files.changes.askSensitiveBody"
            tags={{ name: () => visibleUnsafe(asking.entry.path) }}
          />
        </ConfirmDialog>
      )}
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

// A side in the list: a button that opens its diff, and its actions,
// shown on hover or focus (always on a touch screen)
function ChangeRow({
  item,
  onOpen,
  actions,
}: {
  item: Item
  onOpen: () => void
  actions: ReactNode
}) {
  const { entry, code } = item
  return (
    <div className="group flex items-center hover:bg-surface">
      <ChangeRowButton
        code={code}
        path={entry.path}
        orig={entry.orig}
        sensitive={entry.sensitive}
        onOpen={onOpen}
        className="flex-1"
      />
      <span className="flex shrink-0 items-center pr-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        {actions}
      </span>
    </div>
  )
}

export default ChangesView
