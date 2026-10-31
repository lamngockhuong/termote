import {
  AppWindow,
  ArrowLeft,
  Copy,
  Eye,
  Image as ImageIcon,
  Lock,
  Pencil,
  WrapText,
} from 'lucide-react'
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { type FilesError, filesError } from '../hooks/use-files'
import { useLinePick } from '../hooks/use-line-pick'
import {
  type ChangeEntry,
  type DiffHunk,
  type DiffLine,
  type FileDiff,
  fetchFileContent,
  fetchFileDiff,
  RequestError,
} from '../hooks/use-mux-api'
import { useSettings } from '../hooks/use-settings'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { isTablePath } from '../utils/csv-parse'
import { keepOrder, TRUNCATE_START } from '../utils/files-format'
import { isImagePath, isSvgPath } from '../utils/image-path'
import { diffRange, inPick, type LineRange } from '../utils/line-range'
import { isMarkdownPath, type LinkPath } from '../utils/markdown-links'
import type { OpenWindowEvent } from '../utils/open-window'
import { lineText } from '../utils/review-message'
import {
  CODE_FRAME,
  capitalized,
  codeText,
  GUTTER,
  GUTTER_CELL,
} from './code-block'
import {
  type HeaderAction,
  HeaderActions,
  LazyMarkdownPreview,
  LazyTablePreview,
  PREVIEW_MAX_BYTES,
  SensitiveConfirm,
} from './file-viewer'
import { ImageCompare } from './image-compare'
import { LineCommentBar, LineGutterButton } from './line-comment-bar'
import { ViewMessage } from './pane-dir-header'
import { Banner } from './ui/banner'
import { IconButton } from './ui/button'
import { SkeletonLines } from './ui/skeleton'

type Loaded =
  | { kind: 'loading' }
  | { kind: 'diff'; diff: FileDiff }
  | { kind: 'sensitive' }
  | { kind: 'error'; text: MessageKey }

const ERRORS: Record<FilesError, MessageKey> = {
  'not-allowed': 'files.diff.fileNotAllowed',
  'view-only': 'files.changes.viewOnly',
  // Answered as gone instead: not listed by git status any more, or the
  // untracked file was removed
  'not-found': 'files.diff.gone',
  unsupported: 'files.changes.unsupported',
  unavailable: 'files.diff.unavailable',
}

const ROW: Record<DiffLine['kind'], string> = {
  ctx: 'bg-bg',
  add: 'bg-diff-add',
  del: 'bg-diff-del',
}
const SIGN: Record<DiffLine['kind'], string> = { ctx: ' ', add: '+', del: '-' }

interface Props {
  paneId: string
  root?: string
  // The entry shown, as the latest status lists it; undefined once it is no
  // longer changed
  entry?: ChangeEntry
  // The status is being read again (the root moved): entry is not known yet
  waiting: boolean
  path: string
  staged: boolean
  isMobile: boolean
  // Bumped by a manual refresh: the diff is read again
  reload: number
  onClose: () => void
  onRootChanged: (root: string) => void
  // A link of a Markdown preview to another file or a directory
  onFollow: (target: LinkPath) => void
  notify: (message: string) => void
  // A sensitive file was shown: held by the caller so editing it, then
  // coming back, asks only once. Without it the diff keeps its own.
  reveal?: boolean
  onReveal?: () => void
  // Off for a view-only client: the server never shows it a sensitive file
  canReveal?: boolean
  // Edits the working tree's file, at line when the diff has one;
  // absent for a view-only client
  onEdit?: (line?: number) => void
  // Not showing the sensitive file after all (Back when not given)
  onCancelReveal?: () => void
  // Where the diff starts scrolled to (its tab shown again), and where it
  // was scrolled to (its tab keeps it)
  scrollTop?: number
  onScroll?: (top: number) => void
  // More buttons at the end of the header
  headerExtra?: ReactNode
  // On a desktop: the diff in a window of its own (Shift: a popup)
  onOpenWindow?: (e: OpenWindowEvent) => void
  // The actions on the whole file, in the header, given the diff once read
  renderActions?: (entry: ChangeEntry, diff?: FileDiff) => ReactNode
  // The actions on one hunk, in its header; only a hunk with an id has any
  renderHunkActions?: (
    entry: ChangeEntry,
    hunk: DiffHunk,
    i: number,
  ) => ReactNode
  // Lines may be picked by their numbers for a review comment: the range,
  // without its lines for a sensitive file
  onLineComment?: (range: LineRange) => void
  // The lines a comment is on: `n:<new line>`, `o:<old line>`
  commentedLines?: Set<string>
  // A line to show in the middle and highlight, each time jump changes:
  // its new number, or its old one for a deleted line
  line?: DiffLineAt
}

export interface DiffLineAt {
  n: number
  old?: boolean
  jump: number
}

// The unified diff of one changed file, one side (staged or not), with
// line numbers. Read again whenever its status entry changes.
export function DiffViewer({
  paneId,
  root,
  entry,
  waiting,
  path,
  staged,
  isMobile,
  reload,
  onClose,
  onRootChanged,
  onFollow,
  notify,
  reveal: revealProp,
  onReveal,
  canReveal = true,
  onEdit,
  onCancelReveal,
  scrollTop,
  onScroll,
  headerExtra,
  onOpenWindow,
  renderActions,
  renderHunkActions,
  onLineComment,
  commentedLines,
  line,
}: Props) {
  const { t } = useT()
  const [state, setState] = useState<Loaded>({ kind: 'loading' })
  // The jump to line already made: a diff read again (a refresh, a stage)
  // opens where it was scrolled, not at the line again
  const jumped = useRef<number>(undefined)
  const [ownReveal, setOwnReveal] = useState(false)
  const reveal = revealProp ?? ownReveal
  const setReveal = () => {
    setOwnReveal(true)
    onReveal?.()
  }
  const [wrap, setWrap] = useState(isMobile)
  // The working tree's version of a changed Markdown or CSV/TSV file,
  // rendered
  const [preview, setPreview] = useState(false)
  // Where the diff is scrolled to: the diff read again starts there
  const scrolled = useRef(scrollTop)
  // What of the entry the diff depends on
  const version =
    entry && `${entry.staged}${entry.unstaged}${entry.conflict ?? ''}`
  const orig = entry?.orig
  // An image (or an SVG the user wants as one) shows before and after
  // through files/raw instead of a diff
  const { settings, updateSetting } = useSettings()
  const svg = isSvgPath(path)
  const asImage = isImagePath(path) || (svg && settings.svgPreview)
  // The server found the name sensitive although the status did not say so
  const [imageSensitive, setImageSensitive] = useState(false)
  const onImageSensitive = useCallback(() => setImageSensitive(true), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: version and reload re-read the diff
  useEffect(() => {
    if (!version || asImage) return
    let live = true
    setState({ kind: 'loading' })
    fetchFileDiff(paneId, { path, orig }, { staged, root, reveal }).then(
      (d) =>
        live &&
        setState(
          d.sensitive ? { kind: 'sensitive' } : { kind: 'diff', diff: d },
        ),
      (err) => {
        if (!live) return
        if (err instanceof RequestError && err.status === 409 && err.root) {
          onRootChanged(err.root)
          return
        }
        setState({ kind: 'error', text: ERRORS[filesError(err)] })
      },
    )
    return () => {
      live = false
    }
  }, [
    paneId,
    root,
    path,
    orig,
    staged,
    reveal,
    version,
    reload,
    asImage,
    onRootChanged,
  ])

  const shown = waiting
    ? { kind: 'loading' as const }
    : !version
      ? { kind: 'gone' as const }
      : !asImage
        ? state
        : (entry?.sensitive || imageSensitive) && !reveal
          ? { kind: 'sensitive' as const }
          : // version is only set with an entry
            { kind: 'image' as const, entry: entry as ChangeEntry, version }
  // Nothing to render of a file this side deletes
  const side = staged ? entry?.staged : entry?.unstaged
  // Offered once the diff shows (a sensitive file asked first), and kept
  // while the diff is read again
  const canPreview =
    (isMarkdownPath(path) || isTablePath(path)) &&
    side !== 'D' &&
    (shown.kind === 'diff' || (preview && shown.kind === 'loading'))
  const previewing = canPreview && preview
  // The file is in the working tree as text: not deleted there (nor staged
  // as deleted and gone), not a type change (a symlink), and its diff is
  // text the server read. The server still decides once it is opened.
  const inWorktree =
    !!entry &&
    entry.unstaged !== 'D' &&
    !(entry.staged === 'D' && entry.unstaged === '') &&
    entry.staged !== 'T' &&
    entry.unstaged !== 'T'
  const editable =
    !!onEdit &&
    inWorktree &&
    !asImage &&
    shown.kind === 'diff' &&
    !shown.diff.binary &&
    !shown.diff.reason
  const editLabel = t(
    staged ? 'files.diff.editWorkingCopy' : 'files.viewer.edit',
  )
  // The editor opens at the first change; the staged side's new lines are
  // the index's, not the file's
  const editLine =
    !staged && shown.kind === 'diff' ? firstChange(shown.diff.hunks) : undefined
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path)
      notify(t('files.viewer.pathCopied'))
    } catch {
      notify(t('files.viewer.pathCopyFailed'))
    }
  }
  // After Edit: icons in the header, or a menu of them on a phone, where
  // the file's name needs the room beside the stage and discard buttons
  const extras: HeaderAction[] = [
    {
      label: t('files.viewer.copyPath'),
      icon: <Copy size={15} />,
      onClick: copyPath,
    },
  ]
  if (onOpenWindow)
    extras.push({
      label: t('files.viewer.newWindow'),
      title: t('files.viewer.newWindowTitle'),
      icon: <AppWindow size={15} />,
      onClick: onOpenWindow,
    })
  if (canPreview)
    extras.push({
      label: t('files.viewer.preview'),
      title: t(previewing ? 'files.diff.showDiff' : 'files.diff.showCurrent'),
      icon: <Eye size={15} />,
      pressed: previewing,
      onClick: () => setPreview((v) => !v),
    })
  if (svg)
    extras.push({
      label: t('files.viewer.image'),
      title: t(asImage ? 'files.diff.showDiff' : 'files.diff.showImages'),
      icon: <ImageIcon size={15} />,
      pressed: asImage,
      onClick: () => updateSetting('svgPreview', !asImage),
    })
  if (!asImage)
    extras.push({
      label: t('files.viewer.wrap'),
      icon: <WrapText size={15} />,
      pressed: wrap,
      onClick: () => setWrap((w) => !w),
    })
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      // Only the diff is kept where it was scrolled to, not the preview
      onScrollCapture={(e) => {
        const el = e.target as HTMLElement
        if (previewing || el.dataset?.scrollRestore === undefined) return
        scrolled.current = el.scrollTop
        onScroll?.(el.scrollTop)
      }}
    >
      <div className="sticky top-0 z-10 flex shrink-0 items-center gap-1 border-b border-border bg-surface px-1 py-1 ui-terminal:bg-bg">
        <IconButton
          size="sm"
          onClick={onClose}
          aria-label={t('files.changes.back')}
          title={t('files.changes.back')}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </IconButton>
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className={`${TRUNCATE_START} font-term text-[12px]`}
            title={path}
          >
            {keepOrder(orig ? `${orig} → ${path}` : path)}
          </span>
          <span className="text-[11px] text-fg-muted">
            {t(staged ? 'files.changes.staged' : 'files.changes.notStaged')}
          </span>
        </div>
        {editable && onEdit && (
          <IconButton
            size="sm"
            onClick={() => onEdit(editLine)}
            aria-label={editLabel}
            title={editLabel}
          >
            <Pencil size={15} aria-hidden="true" />
          </IconButton>
        )}
        <HeaderActions actions={extras} compact={isMobile} />
        {entry &&
          renderActions?.(
            entry,
            shown.kind === 'diff' ? shown.diff : undefined,
          )}
        {headerExtra}
      </div>
      {shown.kind === 'loading' && !previewing && (
        <SkeletonLines label={t('files.loading')} code className="flex-1" />
      )}
      {shown.kind === 'gone' && (
        <ViewMessage>{t('files.diff.gone')}</ViewMessage>
      )}
      {shown.kind === 'error' && <ViewMessage>{t(shown.text)}</ViewMessage>}
      {shown.kind === 'sensitive' && (
        <ViewMessage>
          <Lock size={20} aria-hidden="true" />
          {t('files.viewer.sensitive')}
          {!canReveal && <span>{t('files.viewer.sensitiveViewOnly')}</span>}
        </ViewMessage>
      )}
      {previewing && (
        <WorkingTreePreview
          paneId={paneId}
          root={root}
          path={path}
          reveal={reveal}
          version={`${version}:${reload}`}
          wrap={wrap}
          onFollow={onFollow}
          notify={notify}
        />
      )}
      {shown.kind === 'image' && (
        <ImageCompare
          paneId={paneId}
          entry={shown.entry}
          staged={staged}
          root={root}
          reveal={reveal}
          version={shown.version}
          reload={reload}
          oneColumn={isMobile}
          onRootChanged={onRootChanged}
          onSensitive={onImageSensitive}
        />
      )}
      {shown.kind === 'diff' && !previewing && (
        <DiffBody
          diff={shown.diff}
          wrap={wrap}
          oneColumn={isMobile}
          scrollTop={scrolled.current}
          hunkActions={
            entry &&
            renderHunkActions &&
            ((h, i) => renderHunkActions(entry, h, i))
          }
          onLineComment={
            onLineComment &&
            ((r) => {
              // A sensitive file was shown: never its lines
              const { quote, ...rest } = r
              onLineComment(
                entry?.sensitive || reveal ? { ...rest, sensitive: true } : r,
              )
            })
          }
          commentedLines={commentedLines}
          line={line && line.jump !== jumped.current ? line : undefined}
          onLineShown={(jump) => {
            jumped.current = jump
          }}
        />
      )}
      <SensitiveConfirm
        isOpen={canReveal && shown.kind === 'sensitive'}
        onConfirm={setReveal}
        onCancel={onCancelReveal ?? onClose}
      />
    </div>
  )
}

type Content =
  | { kind: 'loading' }
  | { kind: 'text'; text: string }
  | { kind: 'message'; text: MessageKey }

// The file as it is now in the working tree, rendered; read again whenever
// the diff is. What shows stays until the new read answers, so a refresh
// keeps the preview where it was scrolled (the caller keys this view by
// entry, so another file never shows the previous one).
function WorkingTreePreview({
  paneId,
  root,
  path,
  reveal,
  version,
  wrap,
  onFollow,
  notify,
}: {
  paneId: string
  root?: string
  path: string
  reveal: boolean
  version: string
  wrap: boolean
  onFollow: (target: LinkPath) => void
  notify: (message: string) => void
}) {
  const { t } = useT()
  const [content, setContent] = useState<Content>({ kind: 'loading' })

  // biome-ignore lint/correctness/useExhaustiveDependencies: version re-reads the file
  useEffect(() => {
    let live = true
    // i18n-ignore: code between two objects, not text
    fetchFileContent({ paneId }, path, { root, reveal }).then(
      (c) => {
        if (!live) return
        if ('sensitive' in c)
          setContent({ kind: 'message', text: 'files.viewer.sensitive' })
        else if ('previewable' in c)
          setContent({ kind: 'message', text: 'files.viewer.unpreviewable' })
        // A table shows whatever its size (up to the 4 MiB a read returns)
        else if (!isTablePath(path) && c.size > PREVIEW_MAX_BYTES)
          setContent({ kind: 'message', text: 'files.diff.tooLarge' })
        else setContent({ kind: 'text', text: c.text })
      },
      (err) =>
        live &&
        setContent({
          kind: 'message',
          text:
            filesError(err) === 'not-found'
              ? 'files.diff.fileNotFound'
              : 'files.viewer.failed',
        }),
    )
    return () => {
      live = false
    }
  }, [paneId, root, path, reveal, version])

  if (content.kind === 'loading')
    return <SkeletonLines label={t('files.loading')} code className="flex-1" />
  if (content.kind === 'message')
    return <ViewMessage>{t(content.text)}</ViewMessage>
  if (isTablePath(path))
    return (
      <LazyTablePreview
        text={content.text}
        path={path}
        wrap={wrap}
        notify={notify}
      />
    )
  return (
    <LazyMarkdownPreview
      text={content.text}
      path={path}
      wrap={wrap}
      onFollow={onFollow}
      notify={notify}
    />
  )
}

export function DiffBody({
  diff,
  wrap,
  oneColumn,
  scrollTop,
  hunkActions,
  onLineComment,
  commentedLines,
  line,
  onLineShown,
}: {
  diff: FileDiff
  wrap: boolean
  oneColumn: boolean
  // Where it starts scrolled to
  scrollTop?: number
  hunkActions?: (h: DiffHunk, i: number) => ReactNode
  onLineComment?: (range: LineRange) => void
  commentedLines?: Set<string>
  line?: DiffLineAt
  onLineShown?: (jump: number) => void
}) {
  const { t } = useT()
  const hunks = diff.hunks ?? []
  const frame = useRef<HTMLDivElement>(null)
  // Picked by index in its hunk: a deleted line has no new number
  const { pick, press, clear } = useLinePick()
  const range =
    pick && hunks[pick.group] && diffRange(hunks[pick.group], pick.a, pick.b)
  // The line asked for last, highlighted until the next one
  const [marked, setMarked] = useState<string>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: only where it opens
  useLayoutEffect(() => {
    if (line) return
    if (scrollTop && frame.current) frame.current.scrollTop = scrollTop
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per ask
  useLayoutEffect(() => {
    if (!line) return
    setMarked(`${line.old ? 'o' : 'n'}:${line.n}`)
    frame.current
      ?.querySelector(`[data-${line.old ? 'old' : 'new'}="${line.n}"]`)
      ?.scrollIntoView?.({ block: 'center' })
    onLineShown?.(line.jump)
  }, [line?.jump])
  return (
    <>
      {diff.conflict && (
        <Banner variant="warning">{t('files.diff.conflict')}</Banner>
      )}
      {diff.truncated && (
        <Banner variant="warning">{t('files.diff.truncated')}</Banner>
      )}
      {diff.binary ? (
        <ViewMessage>{t('files.diff.binary')}</ViewMessage>
      ) : diff.reason ? (
        <ViewMessage>{t('files.diff.special')}</ViewMessage>
      ) : hunks.length === 0 ? (
        <ViewMessage>{t('files.diff.noContent')}</ViewMessage>
      ) : (
        <div
          ref={frame}
          className={CODE_FRAME}
          data-testid="diff"
          data-scroll-restore
        >
          <div className={wrap ? '' : 'w-max min-w-full'}>
            {hunks.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: hunks of one diff never move
              <Fragment key={i}>
                {h.id && hunkActions ? (
                  // The buttons stay at the left edge of the frame, however
                  // far a long line scrolls it
                  <div className="flex items-center bg-surface text-fg-muted">
                    <span className="sticky left-0 z-[1] flex shrink-0 bg-surface">
                      {hunkActions(h, i)}
                    </span>
                    <span className="px-2 py-0.5">{h.header}</span>
                  </div>
                ) : (
                  <div className="bg-surface px-2 py-0.5 text-fg-muted">
                    {h.header}
                  </div>
                )}
                {h.lines.map((l, j) => {
                  const nums = (cell: boolean) => (
                    <>
                      {/* Narrow screens keep one number: the old one on a deleted line */}
                      {!oneColumn && <Num n={l.old} cell={cell} />}
                      <Num
                        n={oneColumn && l.kind === 'del' ? l.old : l.new}
                        cell={cell}
                      />
                    </>
                  )
                  return (
                    <div
                      // One hunk numbers each line once on its side
                      key={`${l.kind}${l.old ?? ''}:${l.new ?? ''}`}
                      className={`flex ${inPick(pick, i, j) || marked === lineKey(l) ? 'bg-accent/15' : ROW[l.kind]}`}
                      data-kind={l.kind}
                      // Where a comment opens the diff
                      data-new={l.kind === 'del' ? undefined : l.new}
                      data-old={l.kind === 'del' ? l.old : undefined}
                    >
                      {onLineComment ? (
                        <LineGutterButton
                          line={(l.kind === 'del' ? l.old : l.new) as number}
                          removed={l.kind === 'del'}
                          commented={!!commentedLines?.has(lineKey(l))}
                          onPress={(shift) => press(i, j, shift)}
                        >
                          {nums(true)}
                        </LineGutterButton>
                      ) : (
                        nums(false)
                      )}
                      <span className="w-4 shrink-0 select-none text-center text-fg-muted">
                        {SIGN[l.kind]}
                      </span>
                      <code className={codeText(wrap)}>
                        {l.text || ' '}
                        {l.noNewline && (
                          <span className="text-fg-muted">
                            {' '}
                            {t('files.diff.noNewline')}
                          </span>
                        )}
                      </code>
                    </div>
                  )
                })}
              </Fragment>
            ))}
          </div>
        </div>
      )}
      {onLineComment && range && (
        <LineCommentBar
          label={capitalized(lineText(range, t))}
          onComment={() => {
            onLineComment(range)
            clear()
          }}
          onClear={clear}
        />
      )}
    </>
  )
}

// A line as commentedLines and line name it: its new number, or its old
// one when deleted
const lineKey = (l: DiffLine) =>
  l.kind === 'del' ? `o:${l.old}` : `n:${l.new}`

// The line of the file where its first change is: an added line, or where
// lines were removed
export function firstChange(hunks: DiffHunk[] | null): number | undefined {
  const hunk = hunks?.[0]
  if (!hunk) return
  // The line before the hunk, from its header (@@ -a,b +c,d @@)
  let last = Number(/\+(\d+)/.exec(hunk.header)?.[1] ?? 1) - 1
  for (const l of hunk.lines) {
    if (l.kind === 'add') return l.new
    if (l.kind === 'del') return last + 1
    last = l.new as number
  }
}

// cell: inside the gutter's button, which keeps it at the left edge
function Num({ n, cell }: { n?: number; cell: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`${cell ? GUTTER_CELL : GUTTER} min-w-[5ch] text-fg-muted`}
    >
      {n ?? ''}
    </span>
  )
}
