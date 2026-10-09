import {
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
import {
  type ChangeEntry,
  type DiffLine,
  type FileDiff,
  fetchFileContent,
  fetchFileDiff,
  RequestError,
} from '../hooks/use-mux-api'
import { useSettings } from '../hooks/use-settings'
import { isTablePath } from '../utils/csv-parse'
import { keepOrder, TRUNCATE_START } from '../utils/files-format'
import { isImagePath, isSvgPath } from '../utils/image-path'
import { isMarkdownPath, type LinkPath } from '../utils/markdown-links'
import { CODE_FRAME, codeText, GUTTER } from './code-block'
import {
  LazyMarkdownPreview,
  LazyTablePreview,
  PREVIEW_MAX_BYTES,
  SensitiveConfirm,
} from './file-viewer'
import { ImageCompare } from './image-compare'
import { ViewMessage } from './pane-dir-header'
import { Banner } from './ui/banner'
import { IconButton } from './ui/button'

type Loaded =
  | { kind: 'loading' }
  | { kind: 'diff'; diff: FileDiff }
  | { kind: 'sensitive' }
  | { kind: 'error'; text: string }

const ERRORS: Record<FilesError, string> = {
  'not-allowed': "This file can't be shown",
  // Answered as gone instead: not listed by git status any more, or the
  // untracked file was removed
  'not-found': 'No longer changed',
  unsupported: 'Not supported by this backend',
  unavailable: 'Could not load the diff',
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
  // Edits the working tree's file; absent for a view-only client
  onEdit?: () => void
  // Not showing the sensitive file after all (Back when not given)
  onCancelReveal?: () => void
  // Where the diff starts scrolled to (its tab shown again), and where it
  // was scrolled to (its tab keeps it)
  scrollTop?: number
  onScroll?: (top: number) => void
  // More buttons at the end of the header
  headerExtra?: ReactNode
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
  onEdit,
  onCancelReveal,
  scrollTop,
  onScroll,
  headerExtra,
}: Props) {
  const [state, setState] = useState<Loaded>({ kind: 'loading' })
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
  const editLabel = staged ? 'Edit working copy' : 'Edit'
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path)
      notify('Path copied')
    } catch {
      notify('Could not copy the path')
    }
  }
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
          aria-label="Back to changes"
          title="Back to changes"
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
            {staged ? 'Staged' : 'Not staged'}
          </span>
        </div>
        {editable && (
          <IconButton
            size="sm"
            onClick={onEdit}
            aria-label={editLabel}
            title={editLabel}
          >
            <Pencil size={15} aria-hidden="true" />
          </IconButton>
        )}
        <IconButton
          size="sm"
          onClick={copyPath}
          aria-label="Copy path"
          title="Copy path"
        >
          <Copy size={15} aria-hidden="true" />
        </IconButton>
        {canPreview && (
          <IconButton
            size="sm"
            onClick={() => setPreview((v) => !v)}
            aria-label="Preview"
            aria-pressed={previewing}
            title={previewing ? 'Show the diff' : 'Show the current version'}
            className={previewing ? 'text-accent' : ''}
          >
            <Eye size={15} aria-hidden="true" />
          </IconButton>
        )}
        {svg && (
          <IconButton
            size="sm"
            onClick={() => updateSetting('svgPreview', !asImage)}
            aria-label="Image"
            aria-pressed={asImage}
            title={asImage ? 'Show the diff' : 'Show as images'}
            className={asImage ? 'text-accent' : ''}
          >
            <ImageIcon size={15} aria-hidden="true" />
          </IconButton>
        )}
        {!asImage && (
          <IconButton
            size="sm"
            onClick={() => setWrap((w) => !w)}
            aria-label="Wrap lines"
            aria-pressed={wrap}
            title="Wrap lines"
            className={wrap ? 'text-accent' : ''}
          >
            <WrapText size={15} aria-hidden="true" />
          </IconButton>
        )}
        {headerExtra}
      </div>
      {shown.kind === 'loading' && !previewing && (
        <ViewMessage>Loading…</ViewMessage>
      )}
      {shown.kind === 'gone' && <ViewMessage>No longer changed</ViewMessage>}
      {shown.kind === 'error' && <ViewMessage>{shown.text}</ViewMessage>}
      {shown.kind === 'sensitive' && (
        <ViewMessage>
          <Lock size={20} aria-hidden="true" />
          This file may contain secrets
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
        />
      )}
      <SensitiveConfirm
        isOpen={shown.kind === 'sensitive'}
        onConfirm={setReveal}
        onCancel={onCancelReveal ?? onClose}
      />
    </div>
  )
}

type Content =
  | { kind: 'loading' }
  | { kind: 'text'; text: string }
  | { kind: 'message'; text: string }

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
  const [content, setContent] = useState<Content>({ kind: 'loading' })

  // biome-ignore lint/correctness/useExhaustiveDependencies: version re-reads the file
  useEffect(() => {
    let live = true
    fetchFileContent(paneId, path, { root, reveal }).then(
      (c) => {
        if (!live) return
        if ('sensitive' in c)
          setContent({ kind: 'message', text: 'This file may contain secrets' })
        else if ('previewable' in c)
          setContent({
            kind: 'message',
            text: 'Not previewable (binary, special file or larger than 1 MiB)',
          })
        // A table shows whatever its size (up to the 1 MiB a read returns)
        else if (!isTablePath(path) && c.size > PREVIEW_MAX_BYTES)
          setContent({ kind: 'message', text: 'Too large to preview' })
        else setContent({ kind: 'text', text: c.text })
      },
      (err) =>
        live &&
        setContent({
          kind: 'message',
          text:
            filesError(err) === 'not-found'
              ? 'File not found'
              : 'Could not load the file',
        }),
    )
    return () => {
      live = false
    }
  }, [paneId, root, path, reveal, version])

  if (content.kind === 'loading') return <ViewMessage>Loading…</ViewMessage>
  if (content.kind === 'message')
    return <ViewMessage>{content.text}</ViewMessage>
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

function DiffBody({
  diff,
  wrap,
  oneColumn,
  scrollTop,
}: {
  diff: FileDiff
  wrap: boolean
  oneColumn: boolean
  // Where it starts scrolled to
  scrollTop?: number
}) {
  const hunks = diff.hunks ?? []
  const frame = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only where it opens
  useLayoutEffect(() => {
    if (scrollTop && frame.current) frame.current.scrollTop = scrollTop
  }, [])
  return (
    <>
      {diff.conflict && (
        <Banner variant="warning">
          Unresolved conflict: the file as it is now
        </Banner>
      )}
      {diff.truncated && (
        <Banner variant="warning">Diff truncated at 1 MiB</Banner>
      )}
      {diff.binary ? (
        <ViewMessage>Binary file changed</ViewMessage>
      ) : diff.reason ? (
        <ViewMessage>
          Not previewable (special file or larger than 1 MiB)
        </ViewMessage>
      ) : hunks.length === 0 ? (
        <ViewMessage>No content changes</ViewMessage>
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
                <div className="bg-surface px-2 py-0.5 text-fg-muted">
                  {h.header}
                </div>
                {h.lines.map((l) => (
                  <div
                    // One hunk numbers each line once on its side
                    key={`${l.kind}${l.old ?? ''}:${l.new ?? ''}`}
                    className={`flex ${ROW[l.kind]}`}
                    data-kind={l.kind}
                  >
                    {/* Narrow screens keep one number: the old one on a deleted line */}
                    {!oneColumn && <Num n={l.old} />}
                    <Num n={oneColumn && l.kind === 'del' ? l.old : l.new} />
                    <span className="w-4 shrink-0 select-none text-center text-fg-muted">
                      {SIGN[l.kind]}
                    </span>
                    <code className={codeText(wrap)}>
                      {l.text || ' '}
                      {l.noNewline && (
                        <span className="text-fg-muted">
                          {' '}
                          (no newline at end of file)
                        </span>
                      )}
                    </code>
                  </div>
                ))}
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function Num({ n }: { n?: number }) {
  return (
    <span aria-hidden="true" className={`${GUTTER} min-w-[5ch] text-fg-muted`}>
      {n ?? ''}
    </span>
  )
}
