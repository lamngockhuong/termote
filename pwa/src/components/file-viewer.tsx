import {
  AppWindow,
  ArrowLeft,
  Check,
  Code,
  Columns2,
  Copy,
  Download,
  Ellipsis,
  Eye,
  Image as ImageIcon,
  Lock,
  MessageSquarePlus,
  Pencil,
  Pin,
  TextCursorInput,
  Trash2,
  WrapText,
  X,
} from 'lucide-react'
import {
  type ComponentProps,
  type ReactNode,
  Suspense,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useDebouncedValue } from '../hooks/use-debounced-value'
import {
  documentErrorCode,
  useDocumentBytes,
} from '../hooks/use-document-bytes'
import { useDomSelection } from '../hooks/use-dom-selection'
import { useElementWidth } from '../hooks/use-element-width'
import {
  type FileDraft,
  type FilesError,
  filesError,
  useFileDraft,
} from '../hooks/use-files'
import { imageErrorCode, useImageBlob } from '../hooks/use-image-blob'
import { useMediaQuery } from '../hooks/use-media-query'
import {
  type FileContent,
  type FileEncoding,
  fetchFileContent,
  RequestError,
  saveFileContent,
} from '../hooks/use-mux-api'
import { type SyncSide, useScrollSync } from '../hooks/use-scroll-sync'
import {
  type MarkdownEditLayout as EditLayout,
  useSettings,
} from '../hooks/use-settings'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import type { Reapplied, Skipped, TableOp } from '../utils/csv-edits'
import {
  DELIMITER_SEPARATED,
  type Delimiter,
  delimiterFor,
  isTablePath,
} from '../utils/csv-parse'
import { CsvClient } from '../utils/csv-parse-client'
import { isDocumentPath } from '../utils/document-path'
import { formatSize, keepOrder, TRUNCATE_START } from '../utils/files-format'
import { HIGHLIGHT_MAX_BYTES } from '../utils/highlight'
import { isImagePath, isSvgPath } from '../utils/image-path'
import { lazyRetry } from '../utils/lazy-retry'
import type { LineRange, TextLines } from '../utils/line-range'
import {
  dirOf,
  imageLink,
  type PasteEdit,
  pasteToken,
  placeholder,
  replacePlaceholder,
} from '../utils/markdown-image-paste'
import { isMarkdownPath, type LinkPath } from '../utils/markdown-links'
import type { OpenWindowEvent } from '../utils/open-window'
import { recordSelection } from '../utils/pane-selection'
import { quoteLines } from '../utils/review-message'
import type { TableLayout } from '../utils/table-columns'
import { visibleUnsafe } from '../utils/unsafe-chars'
import {
  fileImageErrorMessage,
  imageRefusal,
  uploadFileImage,
} from '../utils/upload-image'
import { CodeBlock } from './code-block'
import type { EditorAt } from './code-editor'
import {
  FileEditor,
  SaveBanner,
  type SaveError,
  saveErrorOf,
} from './file-editor'
import { FileEncodingMenu } from './file-encoding-menu'
import { ImagePreview } from './image-preview'
import { LazyBoundary, LoadFailed } from './lazy-boundary'
import { MarkdownEditLayout } from './markdown-edit-layout'
import { ViewMessage } from './pane-dir-header'
import type { TableState } from './table-preview'
import { Banner } from './ui/banner'
import { Button, IconButton } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuItemCheckbox,
  MenuItemRadio,
  MenuSeparator,
} from './ui/menu'
import { SkeletonLines } from './ui/skeleton'

// A preview whose chunk failed to load: said in its place, with a way to retry
function PreviewBoundary({
  retry,
  children,
}: {
  retry: () => void
  children: ReactNode
}) {
  const { t } = useT()
  return (
    <LazyBoundary
      onRetry={retry}
      fallback={(again) => (
        <LoadFailed message={t('files.viewer.previewFailed')} retry={again} />
      )}
    >
      {children}
    </LazyBoundary>
  )
}

// A preview's chunk on its way
function Loading() {
  const { t } = useT()
  return <SkeletonLines label={t('files.loading')} code className="flex-1" />
}

// The markdown renderer: loaded the first time a Markdown file is previewed
const MarkdownPreview = lazyRetry(
  () => import('./markdown-preview'),
  'MarkdownPreview',
)

export function LazyMarkdownPreview(
  props: ComponentProps<typeof MarkdownPreview>,
) {
  return (
    <PreviewBoundary retry={MarkdownPreview.retry}>
      <Suspense fallback={<Loading />}>
        <MarkdownPreview {...props} />
      </Suspense>
    </PreviewBoundary>
  )
}

// Narrower than this (a side panel, a phone), a Markdown draft and its
// preview do not show side by side
const SPLIT_MIN_WIDTH = 768

// A draft over this many characters is rendered less often while typed
const LONG_DRAFT = 64 * 1024

// The preview of a Markdown draft, a step behind the typing: rendered once
// the text has stayed the same for a moment, at a lower priority than the
// keys, so a long file or a diagram never holds up the editor. The same
// element until the text shown changes: each key renders the viewer again,
// which must not parse the Markdown again.
function DraftPreview(props: ComponentProps<typeof MarkdownPreview>) {
  const settled = useDebouncedValue(
    props.text,
    props.text.length > LONG_DRAFT ? 600 : 250,
  )
  const text = useDeferredValue(settled)
  const latest = useRef(props)
  latest.current = props
  const { path, wrap } = props
  return useMemo(
    () => (
      <LazyMarkdownPreview
        text={text}
        path={path}
        wrap={wrap}
        editing
        onFollow={(...a) => latest.current.onFollow(...a)}
        notify={(message) => latest.current.notify(message)}
        // Always given by the viewer
        followScrollTop={() =>
          (latest.current.followScrollTop as () => number)()
        }
        onSyncSide={(side) =>
          (latest.current.onSyncSide as (s: SyncSide | null) => void)(side)
        }
      />
    ),
    [text, path, wrap],
  )
}

const LAYOUT_LABELS: Record<EditLayout, MessageKey> = {
  source: 'files.viewer.layout.source',
  split: 'files.viewer.layout.split',
  preview: 'files.viewer.layout.preview',
}

// The layout a click switches to, as the button's tooltip names it
const LAYOUT_NEXT: Record<EditLayout, MessageKey> = {
  source: 'files.viewer.layoutNext.source',
  split: 'files.viewer.layoutNext.split',
  preview: 'files.viewer.layoutNext.preview',
}

// The layout a click switches to, as the button names it
const LAYOUT_SWITCH: Record<EditLayout, MessageKey> = {
  source: 'files.viewer.switchTo.source',
  split: 'files.viewer.switchTo.split',
  preview: 'files.viewer.switchTo.preview',
}

const LAYOUT_ICONS: Record<EditLayout, ReactNode> = {
  source: <Code size={15} />,
  split: <Columns2 size={15} />,
  preview: <Eye size={15} />,
}

// The table view of a CSV/TSV file: loaded the first time one is shown
const TablePreview = lazyRetry(() => import('./table-preview'), 'TablePreview')

export function LazyTablePreview(props: ComponentProps<typeof TablePreview>) {
  return (
    <PreviewBoundary retry={TablePreview.retry}>
      <Suspense fallback={<Loading />}>
        <TablePreview {...props} />
      </Suspense>
    </PreviewBoundary>
  )
}

// A PDF, .xlsx or .docx: its viewers load the first time one is opened
const DocumentPreview = lazyRetry(
  () => import('./document-preview'),
  'DocumentPreview',
)

function LazyDocumentPreview(props: ComponentProps<typeof DocumentPreview>) {
  return (
    <PreviewBoundary retry={DocumentPreview.retry}>
      <Suspense fallback={<Loading />}>
        <DocumentPreview {...props} />
      </Suspense>
    </PreviewBoundary>
  )
}

// Beyond this a Markdown file is shown as its source
export const PREVIEW_MAX_BYTES = HIGHLIGHT_MAX_BYTES

type Loaded =
  | { kind: 'loading' }
  | {
      kind: 'text'
      root: string
      text: string
      size: number
      hash: string
      encoding: FileEncoding
      bom?: boolean
      editable: boolean
      notEditable?: string
    }
  | {
      kind: 'unpreviewable'
      size: number
      reason: 'binary' | 'too-large' | 'not-regular'
    }
  | { kind: 'sensitive' }
  | { kind: 'error'; error: FilesError }

type TextLoaded = Extract<Loaded, { kind: 'text' }>

function loaded(c: FileContent): Loaded {
  if ('sensitive' in c) return { kind: 'sensitive' }
  if ('previewable' in c)
    return { kind: 'unpreviewable', size: c.size, reason: c.reason }
  return {
    kind: 'text',
    root: c.root,
    text: c.text,
    size: c.size,
    hash: c.hash,
    encoding: c.encoding,
    bom: c.bom,
    editable: c.editable,
    notEditable: c.notEditable,
  }
}

// A draft of file: its text as read, with "\n" line breaks (a textarea turns
// every one into "\n": compared, and sent, so), and the encoding it was read
// as, which its save sends. With a delimiter it is edited in the table view,
// from edits already made on that text.
function draftOf(
  file: TextLoaded,
  path: string,
  reveal: boolean,
  delimiter?: Delimiter,
  edits?: { text: string; ops: TableOp[] },
): FileDraft {
  const base = file.text.replace(/\r\n/g, '\n')
  return {
    root: file.root,
    path,
    baseHash: file.hash,
    base,
    crlf: base !== file.text,
    encoding: file.encoding,
    text: edits?.text ?? base,
    reveal,
    cells: delimiter && { delimiter, ops: edits?.ops ?? [], redo: [] },
  }
}

// A draft that changed while its save ran (another view of the pane edited
// it): the text saved becomes its base, in the encoding it was saved in.
// Its table edits stay only when they began with the ones saved; else it
// goes on as text, since edits applied again after a conflict must turn the
// base into the text.
export function rebaseDraft(
  now: FileDraft,
  saved: FileDraft,
  saveRoot: string,
  saveHash: string,
  encoding: FileEncoding,
): FileDraft {
  const done = saved.cells?.ops ?? []
  const ops = now.cells?.ops
  const follows = !!ops && done.every((op, i) => ops[i] === op)
  return {
    ...now,
    root: saveRoot,
    baseHash: saveHash,
    base: saved.text,
    encoding,
    cells:
      now.cells && follows
        ? { ...now.cells, ops: now.cells.ops.slice(done.length) }
        : undefined,
  }
}

const SKIP_REASONS: Record<Skipped['reason'], MessageKey> = {
  missing: 'files.skipped.missing',
  many: 'files.skipped.many',
  column: 'files.skipped.column',
  columns: 'files.skipped.columns',
  depends: 'files.skipped.depends',
  unreadable: 'files.skipped.unreadable',
}

export function describeOp(op: TableOp, t: Translate<MessageKey>): string {
  if (op.kind === 'cell') {
    return t('files.op.cell', {
      row: op.row + 1,
      column: visibleUnsafe(op.name),
    })
  }
  if (op.kind === 'insert') {
    return op.after < 0
      ? t('files.op.insertTop')
      : t('files.op.insert', { row: op.after + 1 })
  }
  if (op.kind === 'delete') return t('files.op.delete', { row: op.row + 1 })
  if (op.kind === 'cells') {
    const n =
      op.rows.reduce((sum, r) => sum + r.cells.length, 0) +
      op.added.reduce((sum, r) => sum + r.length, 0)
    return t('files.op.cells', { count: n })
  }
  const column =
    op.name === null ? String(op.col + 1) : `"${visibleUnsafe(op.name)}"`
  if (op.kind === 'delete-col') return t('files.op.deleteCol', { column })
  return t(
    op.side === 'left' ? 'files.op.insertColBefore' : 'files.op.insertColAfter',
    { column },
  )
}

// The edits a reload could not apply again, and why; a cell's value can be
// copied, to set it again by hand
function SkippedEdits(props: {
  skipped: Skipped[]
  onCopy: (value: string) => void
}) {
  const { t } = useT()
  return (
    <Banner variant="warning">
      {t('files.skipped')}
      <ul className="m-0 mt-1 list-none p-0">
        {props.skipped.map(({ op, reason }, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole
          <li key={i} className="flex flex-wrap items-center gap-1.5 py-0.5">
            <bdi>{describeOp(op, t)}</bdi>: {t(SKIP_REASONS[reason])}
            {op.kind === 'cell' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => props.onCopy(op.after)}
              >
                {t('files.skipped.copyValue')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Banner>
  )
}

const ERRORS: Record<FilesError, MessageKey> = {
  'not-allowed': 'files.viewer.notAllowed',
  'view-only': 'files.find.viewOnly',
  'not-found': 'files.delete.fileNotFound',
  unsupported: 'files.find.unsupported',
  unavailable: 'files.viewer.failed',
}

interface Props {
  paneId: string
  // The Place the file is under (Files only; absent: the pane's folder)
  place?: string
  root?: string
  // The root the tab was opened under, whose draft it shows: a tab kept
  // with unsaved changes while the root moved (default: root)
  draftRoot?: string
  path: string
  // Wrap long lines at first (mobile)
  wrapByDefault: boolean
  // Where a Markdown preview starts: a heading, else an offset to restore
  anchor?: string
  scrollTop?: number
  // A search result's line to open at, each time jump changes: this tab
  // shows the source (not the Markdown, table or SVG image preview) there.
  // col: where on the line (UTF-16), for the desktop editor's cursor
  line?: number
  col?: number
  jump?: number
  // Where the desktop editor opens when editing starts here (Changes: the
  // first changed line), without forcing the source view like line does
  editAt?: EditorAt
  // A CSV/TSV table's widths and wrapped columns this tab kept, and where
  // to keep them when they change
  tableLayout?: TableLayout
  onTableLayout?: (layout: TableLayout) => void
  // The file a link was followed from, which Back returns to
  backTo?: string
  // What Back is called instead (the Changes view's diff)
  backLabel?: string
  // Back: to backTo, else to the tree
  onClose: () => void
  // A link of the preview to another file or a directory; newTab for
  // Ctrl/Cmd+click, a middle click or a long press
  onFollow: (
    target: LinkPath,
    scrollTop: number,
    opts: { newTab: boolean },
  ) => void
  onRootChanged: (root: string) => void
  notify: (message: string) => void
  // The file may be edited (not a view-only client)
  canEdit?: boolean
  // Opens straight into editing once the file is read (Changes view)
  startEditing?: boolean
  // The file was already shown once (a sensitive one): no second ask
  initialReveal?: boolean
  // A save went through
  onSaved?: () => void
  // Offers Delete (not while editing, so a draft is never lost unasked):
  // the hash of the text shown, when it is shown, and whether the file
  // usually holds secrets
  onDelete?: (file: { hash?: string; sensitive: boolean }) => void
  // Offered in the header's menu when renaming is allowed (revealed: the
  // user chose to show this sensitive file)
  onRename?: (file: { revealed: boolean }) => void
  // Offered in the header's menu when downloading is allowed, for any file
  // but a sensitive one not shown (revealed: the user chose to show it)
  onDownload?: (file: { revealed: boolean }) => void
  // Offered in the header's menu on a desktop: the file in a window of its
  // own (Shift: a popup)
  onOpenWindow?: (e: OpenWindowEvent) => void
  // The file's tab is the preview one: Keep open (and editing) pins it
  pinned?: boolean
  onPin?: () => void
  // The user chose to show the sensitive file
  onRevealed?: () => void
  // Each read of the file: true when it was not found (deleted or renamed
  // outside Termote), false when it was read; other errors say nothing
  onMissingChange?: (missing: boolean) => void
  // Off for a view-only client: the server never shows it a sensitive file
  canReveal?: boolean
  // Not showing the sensitive file after all (Back when not given)
  onCancelReveal?: () => void
  // The file was scrolled to top (its tab keeps it)
  onScroll?: (top: number) => void
  // Closes the file's tab: offered when the file is gone
  onCloseTab?: () => void
  // More buttons at the end of the header
  headerExtra?: ReactNode
  // A narrow screen: the header keeps Back, the name and the main buttons,
  // the others go in a menu
  compact?: boolean
  // Lines may be picked (or selected in the editor) for a review comment:
  // the range, without its lines for a sensitive file shown
  onLineComment?: (range: LineRange) => void
  // The lines a comment is on
  commentedLines?: Set<number>
}

// A header button after the main ones: pressed is set for an on/off one
export interface HeaderAction {
  label: string
  title?: string
  icon: ReactNode
  pressed?: boolean
  danger?: boolean
  onClick: (e: OpenWindowEvent) => void
}

// The header's buttons after the main ones: icons, or on a phone a menu of
// them, where the file's name needs the room
export function HeaderActions({
  actions,
  compact,
  menuStart,
}: {
  actions: HeaderAction[]
  compact: boolean
  // At the top of the phone's menu (a Markdown draft's layouts)
  menuStart?: ReactNode
}) {
  const { t } = useT()
  if (!compact)
    return actions.map((a) => (
      <IconButton
        key={a.label}
        size="sm"
        onClick={(e) => a.onClick({ shiftKey: e.shiftKey })}
        aria-label={a.label}
        aria-pressed={a.pressed}
        title={a.title ?? a.label}
        className={a.pressed ? 'text-accent' : ''}
      >
        {a.icon}
      </IconButton>
    ))
  if (actions.length === 0) return null
  return (
    <Menu
      label={t('files.viewer.moreActions')}
      trigger={<Ellipsis size={16} aria-hidden="true" />}
      triggerSize="sm"
      align="end"
    >
      {menuStart}
      {actions.map((a) =>
        a.pressed === undefined ? (
          <MenuItem
            key={a.label}
            icon={a.icon}
            danger={a.danger}
            onSelect={a.onClick}
          >
            {a.label}
          </MenuItem>
        ) : (
          <MenuItemCheckbox
            key={a.label}
            icon={a.icon}
            checked={a.pressed}
            onSelect={a.onClick}
          >
            {a.label}
          </MenuItemCheckbox>
        ),
      )}
    </Menu>
  )
}

// One file of the tree: its text with line numbers, or why it cannot be
// shown. A file that usually holds secrets is shown only after the user says
// so, every time it is opened: the caller keys this by root and path, so
// another file (or the same path under a new root) never inherits a reveal.
// Edit turns the text into a textarea; the draft is the file's
// (useFileDraft), so a remount opens it again where it was.
export function FileViewer({
  paneId,
  place,
  root,
  draftRoot,
  path,
  wrapByDefault,
  anchor,
  scrollTop,
  line,
  col,
  jump,
  editAt,
  tableLayout,
  onTableLayout,
  backTo,
  backLabel,
  onClose,
  onFollow,
  onRootChanged,
  notify,
  canEdit = false,
  canReveal = true,
  startEditing = false,
  initialReveal = false,
  onSaved,
  onDelete,
  onRename,
  onDownload,
  onOpenWindow,
  pinned = true,
  onPin,
  onRevealed,
  onMissingChange,
  onCancelReveal,
  onScroll,
  onCloseTab,
  headerExtra,
  compact = false,
  onLineComment,
  commentedLines,
}: Props) {
  const { t, locale } = useT()
  const [state, setState] = useState<Loaded>({ kind: 'loading' })
  const [mine, setDraft] = useFileDraft(paneId, draftRoot ?? root ?? '', path)
  const target = { paneId, place }
  const [reveal, setReveal] = useState(initialReveal || !!mine?.reveal)
  // The encoding the user chose to read the file as (this tab only); a
  // draft found at mount was read as its own, which its save sends
  const [override, setOverride] = useState(mine?.encoding)
  const [saving, setSaving] = useState(false)
  // What a confirmed Discard goes on to do
  const [discarding, setDiscarding] = useState<'cancel' | 'back' | 'reload'>()
  // The draft as it is now, for a read that answers after it changed
  const mineRef = useRef(mine)
  mineRef.current = mine
  // Where the text is scrolled to: the next view of it (source, editor)
  // starts there
  const scrolled = useRef(scrollTop)
  // Likewise the table's widths and wraps: a table made again here (Source
  // and back, a reload) starts with the last ones
  const tableKept = useRef(tableLayout)
  // A table edit asked with another delimiter than the file's own
  const [asking, setAsking] = useState<{
    file: TextLoaded
    delimiter: Delimiter
    detected: Delimiter
  }>()
  // The last table the view read: the delimiter an edit is written with
  const [tableState, setTableState] = useState<TableState>()
  // Table edits a reload could not apply again
  const [skipped, setSkipped] = useState<Skipped[]>([])
  const [reload, setReload] = useState(0)
  const [wrap, setWrap] = useState(wrapByDefault)
  const { settings, updateSetting } = useSettings()
  // The search result picked last in this tab: its line shows in the
  // source whatever the preview settings say (they are left as they are),
  // until the user turns a preview on here
  const asked = line && jump !== undefined ? { line, col, jump } : undefined
  const [pick, setPick] = useState(asked)
  const [seenJump, setSeenJump] = useState(jump)
  // The pick was made while the file was being edited: the editor moves
  // there. One made before Edit only scrolled the source, and the editor
  // opens where that was left.
  const [pickInEditor, setPickInEditor] = useState(!!asked && !!mine)
  if (jump !== seenJump) {
    setSeenJump(jump)
    setPick(asked)
    setPickInEditor(!!mine)
  }
  const forceSource = !!pick
  // Markdown that can be previewed: the choice (remembered on this device)
  // says how it shows
  const markdown = isMarkdownPath(path)
  const tooLarge = state.kind === 'text' && state.size > PREVIEW_MAX_BYTES
  const canPreview = markdown && state.kind === 'text' && !tooLarge
  const preview = canPreview && settings.markdownPreview && !forceSource
  // Where the preview started (the link's heading, the offset Back restored)
  // is used up once the user leaves it: Source then Preview starts at the top
  const [leftPreview, setLeftPreview] = useState(false)
  // A CSV/TSV file is a table, whatever its size (up to the 1 MiB a read
  // returns), unless the user chose its source
  const canTable = isTablePath(path) && state.kind === 'text'
  const tableView = canTable && settings.tablePreview && !forceSource
  const togglePreview = () => {
    if (forceSource) {
      setPick(undefined)
      scrolled.current = undefined
      // The setting shows the preview: back to it, the setting unchanged
      if (canTable ? settings.tablePreview : settings.markdownPreview) return
    }
    if (canTable) {
      scrolled.current = undefined
      updateSetting('tablePreview', !tableView)
      return
    }
    if (preview) setLeftPreview(true)
    // The other view of the file is laid out otherwise: from the top
    scrolled.current = undefined
    updateSetting('markdownPreview', !preview)
  }
  const previewOn = preview || tableView
  // An image (or an SVG the user wants as one) is read through files/raw
  const svg = isSvgPath(path)
  const asImage =
    isImagePath(path) || (svg && settings.svgPreview && !forceSource)
  const [retry, setRetry] = useState(0)
  const image = useImageBlob(
    paneId,
    asImage ? { path, root, reveal, place } : null,
    String(retry),
    onRootChanged,
  )
  // A PDF, .xlsx or .docx is read through files/document, for its viewer
  const docKind = isDocumentPath(path)
  const asDocument = docKind !== undefined
  // Neither is read as text: no Wrap, no Edit, no files/content
  const binaryView = asImage || asDocument
  const doc = useDocumentBytes(
    paneId,
    asDocument ? { path, root, reveal, place } : null,
    String(retry),
    onRootChanged,
  )
  const sensitive = asImage
    ? imageErrorCode(image) === 'sensitive'
    : asDocument
      ? documentErrorCode(doc) === 'sensitive'
      : state.kind === 'sensitive'
  // Text selected in the file, for a template's {{selection}}: never from a
  // sensitive file the user chose to show
  const selectionPane = reveal || mine?.reveal ? undefined : paneId
  const rootRef = useRef<HTMLDivElement>(null)
  useDomSelection(rootRef, selectionPane, path)
  // What reads the editor's selected lines, for a review comment
  const editorLines = useRef<(() => TextLines) | null>(null)
  // A review comment never quotes a sensitive file shown
  const lineRange = (t: TextLines, unsaved: boolean): LineRange => ({
    start: t.from,
    end: t.to,
    ...(reveal || mine?.reveal
      ? { sensitive: true }
      : { quote: quoteLines(t.lines) }),
    ...(unsaved && { unsaved }),
  })
  const size = asImage
    ? image.status === 'ready'
      ? image.size
      : undefined
    : asDocument
      ? doc.status === 'ready'
        ? doc.size
        : undefined
      : 'size' in state
        ? state.size
        : undefined
  const back =
    backLabel ??
    (backTo
      ? t('files.viewer.backTo', {
          name: backTo.slice(backTo.lastIndexOf('/') + 1),
        })
      : t('files.viewer.backToFiles'))
  // Kept while the pane's root moves: the text is the old root's file
  const [saveError, setSaveError] = useState<SaveError>()
  const rootMoved =
    (!!mine && root !== undefined && mine.root !== root) ||
    saveError?.kind === 'root'
  const dirty = !!mine && mine.text !== mine.base
  // The file read again is no table to apply the edits to: Save is off
  const stuck = skipped.some((s) => s.reason === 'unreadable')
  const cells = mine?.cells
  // The file as read, when a save of it would be taken
  const editable =
    canEdit && !binaryView && state.kind === 'text' && state.editable
      ? state
      : undefined

  // A Markdown draft shows as the layout chosen on this device. Side by side
  // only with a mouse and room for both in the viewer itself (a side panel
  // is narrow): a touch screen edits in a textarea and, like a narrow viewer,
  // switches between the source and the preview, the choice kept.
  const fine = useMediaQuery('(pointer: fine)')
  const viewerWidth = useElementWidth(rootRef)
  const wide = fine && viewerWidth >= SPLIT_MIN_WIDTH
  const layouts: EditLayout[] = wide
    ? ['source', 'split', 'preview']
    : ['source', 'preview']
  const draftTooLarge =
    markdown && !!mine && mine.text.length > PREVIEW_MAX_BYTES
  const canPreviewDraft = markdown && !!mine && !cells && !draftTooLarge
  const chosen = settings.markdownEditLayout
  const editLayout: EditLayout =
    canPreviewDraft && layouts.includes(chosen) ? chosen : 'source'
  const nextLayout = layouts[(layouts.indexOf(editLayout) + 1) % layouts.length]
  // For the listener below, which lives as long as the preview shows (a
  // text draft: no table edits to be stuck on)
  const saveDraft = () => {
    // Something to save is a draft
    if (dirty && !saving && !rootMoved) save(mine as FileDraft)
  }
  // Side by side, the editor and the preview scroll together
  const [editorSide, setEditorSide] = useState<SyncSide | null>(null)
  const [previewSide, setPreviewSide] = useState<SyncSide | null>(null)
  // Coming from the preview alone, where the user was reading: it leads
  const shownBefore = useRef(editLayout)
  const fromPreview = shownBefore.current === 'preview'
  useEffect(() => {
    shownBefore.current = editLayout
  })
  useScrollSync(
    editLayout === 'split' ? editorSide : null,
    previewSide,
    fromPreview ? 'preview' : 'editor',
  )
  const saveKey = useRef(saveDraft)
  saveKey.current = saveDraft
  // Ctrl/Cmd+S while the preview shows: the focus may be in it or on the
  // page (the editor hidden), where no editor's own binding sees the key
  useEffect(() => {
    if (editLayout === 'source') return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() !== 's') return
      const t = e.target as Node
      if (t !== document.body && !rootRef.current?.contains(t)) return
      e.preventDefault()
      saveKey.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [editLayout])

  // A line picked in a file being edited: the text shown is the draft,
  // whose lines may no longer be the file's
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per pick
  useEffect(() => {
    const d = mineRef.current
    if (pick && d && d.text !== d.base)
      notify(t('files.viewer.lineMoved', { line: pick.line }))
  }, [pick?.jump])

  // Read by the load below without being one of its dependencies
  const missingRef = useRef(onMissingChange)
  missingRef.current = onMissingChange
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload reads the file again
  useEffect(() => {
    if (binaryView) return
    let live = true
    setState({ kind: 'loading' })
    fetchFileContent(target, path, { root, reveal, encoding: override }).then(
      (c) => {
        if (!live) return
        const file = loaded(c)
        setState(file)
        checkDraft(file)
        missingRef.current?.(false)
      },
      (err) => {
        if (!live) return
        if (err instanceof RequestError && err.status === 409 && err.root) {
          // The root prop follows and the file is read again from it
          onRootChanged(err.root)
          return
        }
        const error = filesError(err)
        setState({ kind: 'error', error })
        if (error === 'not-found') missingRef.current?.(true)
      },
    )
    return () => {
      live = false
    }
  }, [
    paneId,
    place,
    root,
    path,
    reveal,
    override,
    binaryView,
    onRootChanged,
    reload,
  ])

  // A draft found when the file is read (one kept from before the app
  // closed, or from before a remount) is checked against the file: one the
  // file already holds is done with; one of a file that changed since it
  // was read is told so (Save never overwrites it); one of a file now shown
  // as sensitive goes, its gate shows.
  const checkDraft = (file: Loaded) => {
    const d = mineRef.current
    if (!d) return
    // Another view of the pane may have replaced it since the last render:
    // then that one stays (a guard; the read answers between renders)
    /* v8 ignore next */
    const done = () => setDraft((now) => (now === d ? undefined : now))
    if (file.kind === 'sensitive' && !d.reveal) {
      done()
      return
    }
    if (file.kind !== 'text' || file.root !== d.root) return
    // A draft from before encodings kept a UTF-8 file's BOM in its text
    const bom = !d.encoding && file.encoding === 'utf-8' && file.bom
    const text = (bom ? '\uFEFF' : '') + file.text.replace(/\r\n/g, '\n')
    if (d.text !== d.base && text === d.text) {
      done()
      return
    }
    if (file.hash !== d.baseHash) setSaveError({ kind: 'changed' })
  }

  const beginEdit = (file: TextLoaded, delimiter?: Delimiter) => {
    setSaveError(undefined)
    setSkipped([])
    setDraft(draftOf(file, path, reveal, delimiter))
    // Edited: no longer a preview tab
    onPin?.()
  }

  // Into the table editor with delimiter, after asking when the file reads
  // as another one: edits written with the wrong one shift the columns.
  // True when editing started now, not asked about.
  const editWith = (file: TextLoaded, delimiter?: Delimiter) => {
    const detected = delimiter && delimiterFor(path, file.text)
    if (delimiter && detected !== delimiter) {
      setAsking({ file, delimiter, detected: detected as Delimiter })
      return false
    }
    beginEdit(file, delimiter)
    return true
  }

  // Changes view: into editing once, as soon as the file can be; not again
  // after the draft found at mount is discarded
  const started = useRef(!!mine)
  useEffect(() => {
    if (!startEditing || started.current || mine || !editable) return
    started.current = true
    editWith(editable)
  })

  const discard = () => {
    setDraft(undefined)
    setSaveError(undefined)
    setSkipped([])
    // The save saw the root move: now the file is read from the new one
    if (saveError?.kind === 'root' && saveError.root)
      onRootChanged(saveError.root)
  }

  // The draft dropped for the file as it is on the host now, read in the
  // encoding the server finds
  const reloadFile = () => {
    discard()
    setOverride(undefined)
    setReload((n) => n + 1)
  }

  // The file read again as encoding: offered only while the draft, if any,
  // has no changes
  const reopen = (encoding: FileEncoding) => {
    if (mine) discard()
    setOverride(encoding)
  }

  const cancel = () => (dirty ? setDiscarding('cancel') : discard())
  const close = () => {
    if (!mine) onClose()
    else if (dirty) setDiscarding('back')
    else {
      discard()
      onClose()
    }
  }

  // Called only while no save runs (Save and Ctrl+S are off meanwhile).
  // saveAs 'utf-8' writes the file as UTF-8 without a BOM.
  const save = async (edit: FileDraft, saveAs?: 'utf-8') => {
    setSaving(true)
    setSaveError(undefined)
    try {
      const res = await saveFileContent(target, {
        root: edit.root,
        path,
        baseHash: edit.baseHash,
        text: edit.text,
        reveal: edit.reveal,
        encoding: edit.encoding,
        saveAs,
      })
      // A draft from before encodings kept a UTF-8 file's BOM in its text,
      // which the file read now leaves out
      const noBom = (t: string) =>
        !edit.encoding && res.bom && t.startsWith('\uFEFF') ? t.slice(1) : t
      const saved = { ...edit, text: noBom(edit.text) }
      // The file as saved: a save went through, so it can be edited again
      // (one that would lose bytes is never saved but as UTF-8)
      setState({
        kind: 'text',
        root: res.root,
        text: saved.crlf ? saved.text.replace(/\n/g, '\r\n') : saved.text,
        size: res.size,
        hash: res.hash,
        encoding: res.encoding,
        bom: res.bom,
        editable: true,
      })
      // An image still uploading whose placeholder this wrote: its link
      // can only go in a draft
      for (const m of edit.text.matchAll(/!\[Uploading [0-9a-f]{8}…\]\(\)/g))
        savedPlaceholders.current.add(m[0])
      // Now UTF-8: a choice of another encoding no longer applies
      if (saveAs) setOverride(undefined)
      // Only the draft sent is dropped: one changed meanwhile stays
      setDraft((now) =>
        now === edit
          ? undefined
          : now &&
            rebaseDraft(
              { ...now, text: noBom(now.text) },
              saved,
              res.root,
              res.hash,
              res.encoding,
            ),
      )
      setSkipped([])
      notify(t('files.viewer.saved'))
      onSaved?.()
    } catch (err) {
      setSaveError(saveErrorOf(err, t, saveAs ?? edit.encoding))
    } finally {
      setSaving(false)
    }
  }

  // Saves the file as UTF-8: the draft, or the text shown, through a draft
  // that stays when the save is refused
  const saveAsUtf8 = (file: TextLoaded) => {
    let edit = mine
    if (!edit) {
      edit = draftOf(file, path, reveal)
      setDraft(edit)
      onPin?.()
    }
    void save(edit, 'utf-8')
  }
  // The file changed on the host: read it again and apply the table edits
  // to it, each found by its row's values. The draft becomes the new file's,
  // so the next save never sends the old hash; what was not applied is
  // listed. Nothing is saved here.
  const reapplyEdits = async (
    edit: FileDraft,
    { delimiter, ops }: NonNullable<FileDraft['cells']>,
  ) => {
    if (saving) return
    setSaving(true)
    try {
      const file = loaded(
        await fetchFileContent(target, path, {
          root: edit.root,
          reveal: edit.reveal,
          encoding: edit.encoding,
        }),
      )
      let res: Reapplied = { ok: false }
      if (file.kind === 'text' && file.editable) {
        const base = file.text.replace(/\r\n/g, '\n')
        // The last save went through after all (it timed out)
        if (base === edit.text) {
          res = { ok: true, text: base, ops: [], skipped: [] }
        } else {
          const client = new CsvClient()
          res = await client.reapply(base, delimiter, ops)
          client.terminate()
        }
      }
      if (file.kind !== 'text' || !res.ok) {
        setSkipped(ops.map((op) => ({ op, reason: 'unreadable' })))
        return
      }
      // Another view of the pane may have replaced the draft meanwhile:
      // then it is left as it is, with its own conflict
      let replaced = false
      setDraft((now) => {
        if (now !== edit) return now
        replaced = true
        return draftOf(file, path, edit.reveal, delimiter, res)
      })
      if (!replaced) return
      setState(file)
      setSaveError(undefined)
      setSkipped(res.skipped)
      if (!res.ops.length && !res.skipped.length) {
        notify(t('files.viewer.alreadyIn'))
      }
    } catch (err) {
      if (err instanceof RequestError && err.status === 409 && err.root) {
        setSaveError({ kind: 'root', root: err.root })
      } else notify(t('files.viewer.rereadFailed'))
    } finally {
      setSaving(false)
    }
  }

  // Images pasted into the Markdown file, saved one after another next to
  // it. Each one's placeholder goes in at the cursor at once, and is swapped
  // for the link in the editor while it is there (an undoable change), else
  // in the draft: the editor may be gone by then. A draft discarded
  // meanwhile, or a placeholder undone, gets no link; the image stays on the
  // host, and the user is told where.
  const pastes = useRef(Promise.resolve())
  // Placeholders of images still uploading that a save wrote to the file
  const savedPlaceholders = useRef(new Set<string>())
  const pasteImage = (file: File, edit: PasteEdit) => {
    // Refused at once: never a placeholder waiting behind another upload
    const refused = imageRefusal(file)
    if (refused) {
      notify(fileImageErrorMessage(refused, t))
      return
    }
    const d = mineRef.current as FileDraft
    const token = pasteToken()
    const ph = placeholder(token)
    edit.insert(ph)
    const put = (link: string) => {
      if (edit.replace(ph, link)) return true
      let found = false
      setDraft((now) => {
        if (!now) return now
        const next = replacePlaceholder(now.text, token, link)
        found = next.found
        return next.found ? { ...now, text: next.text } : now
      })
      return found
    }
    pastes.current = pastes.current.then(async () => {
      try {
        const res = await uploadFileImage(
          target,
          { root: d.root, dir: dirOf(path), reveal: d.reveal },
          file,
        )
        if (!res.ok) {
          put('')
          if (res.reason === 'root_changed')
            setSaveError({ kind: 'root', root: res.root })
          notify(fileImageErrorMessage(res.reason, t))
        } else if (!put(imageLink(path, res.path))) {
          notify(
            savedPlaceholders.current.has(ph)
              ? t('files.viewer.imageSavedPlaceholder', { path: res.path })
              : t('files.viewer.imageSaved', { path: res.path }),
          )
        }
      } catch {
        put('')
        notify(t('files.viewer.imageFailed'))
      } finally {
        savedPlaceholders.current.delete(ph)
      }
    })
  }
  // The text shown, whose encoding the header names; a binary file gets a
  // way to open it as text instead
  const shown = !binaryView && state.kind === 'text' ? state : undefined
  // Saved as UTF-8 from here: a file not in plain UTF-8 that a save would
  // take, or that only loses bytes in its own encoding
  const convertible =
    canEdit &&
    shown &&
    (shown.encoding !== 'utf-8' || shown.bom) &&
    (shown.editable || shown.notEditable === 'lossy-encoding') &&
    (!mine || mine.encoding) &&
    !saving &&
    !rootMoved
  const encodingMenu =
    shown ||
    (!binaryView &&
      state.kind === 'unpreviewable' &&
      state.reason === 'binary') ? (
      <FileEncodingMenu
        encoding={shown?.encoding}
        bom={shown?.bom}
        dirty={dirty}
        notEditable={shown?.notEditable}
        onReopen={reopen}
        onSaveAsUtf8={convertible ? () => saveAsUtf8(shown) : undefined}
      />
    ) : undefined

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify(t('files.viewer.textCopied'))
    } catch {
      notify(t('files.viewer.textCopyFailed'))
    }
  }

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path)
      notify(t('files.viewer.pathCopied'))
    } catch {
      notify(t('files.viewer.pathCopyFailed'))
    }
  }

  // The header's buttons after the main ones (Edit, or Cancel and Save):
  // icons in the header, or a menu of them on a phone, where the file's
  // name needs the room
  const extras: HeaderAction[] = []
  if (!pinned && onPin)
    extras.push({
      label: t('files.tabs.keep'),
      icon: <Pin size={15} />,
      onClick: onPin,
    })
  if (!mine && onRename)
    extras.push({
      label: t('files.rename.title'),
      icon: <TextCursorInput size={15} />,
      onClick: () => onRename({ revealed: reveal }),
    })
  // Binary, too large to show or not a regular file alike: the server
  // says when it cannot send one
  if (!mine && onDownload && !sensitive)
    extras.push({
      label: t('files.download'),
      icon: <Download size={15} />,
      onClick: () => onDownload({ revealed: reveal }),
    })
  if (!mine && onDelete)
    extras.push({
      label: t('files.delete'),
      icon: <Trash2 size={15} />,
      danger: true,
      onClick: () =>
        onDelete({
          // The text shown: its bytes are what a delete must match
          hash: state.kind === 'text' ? state.hash : undefined,
          sensitive: sensitive || reveal,
        }),
    })
  if (!mine)
    extras.push({
      label: t('files.viewer.copyPath'),
      icon: <Copy size={15} />,
      onClick: copyPath,
    })
  if (!mine && onOpenWindow)
    extras.push({
      label: t('files.viewer.newWindow'),
      title: t('files.viewer.newWindowTitle'),
      icon: <AppWindow size={15} />,
      onClick: onOpenWindow,
    })
  if (!mine && (canPreview || canTable))
    extras.push({
      label: t('files.viewer.preview'),
      title: previewOn
        ? t('files.viewer.showSource')
        : t('files.viewer.showPreview'),
      icon: <Eye size={15} />,
      pressed: previewOn,
      onClick: togglePreview,
    })
  if (!mine && svg)
    extras.push({
      label: t('files.viewer.image'),
      title: asImage
        ? t('files.viewer.showSource')
        : t('files.viewer.showImage'),
      icon: <ImageIcon size={15} />,
      pressed: asImage,
      onClick: () => {
        if (forceSource) {
          setPick(undefined)
          if (settings.svgPreview) return
        }
        updateSetting('svgPreview', !asImage)
      },
    })
  if (mine && !cells && onLineComment)
    extras.push({
      label: t('files.viewer.comment'),
      title: t('files.viewer.commentTitle'),
      icon: <MessageSquarePlus size={15} />,
      onClick: () => {
        const lines = editorLines.current?.()
        if (lines) onLineComment(lineRange(lines, dirty))
      },
    })
  if (!binaryView)
    extras.push({
      label: t('files.viewer.wrap'),
      icon: <WrapText size={15} />,
      pressed: wrap,
      onClick: () => setWrap((w) => !w),
    })

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col"
      // Each view of the text marks the element it scrolls
      onScrollCapture={(e) => {
        const el = e.target as HTMLElement
        if (el.dataset?.scrollRestore === undefined) return
        scrolled.current = el.scrollTop
        onScroll?.(el.scrollTop)
      }}
    >
      <div className="sticky top-0 z-10 flex shrink-0 items-center gap-1 border-b border-border bg-surface px-1 py-1 ui-terminal:bg-bg">
        <IconButton
          size="sm"
          onClick={close}
          disabled={saving}
          aria-label={back}
          title={back}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </IconButton>
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className={`${TRUNCATE_START} font-term text-[12px]`}
            title={path}
          >
            {keepOrder(path)}
          </span>
          {size !== undefined && (
            <span className="flex items-center gap-1 whitespace-nowrap text-[11px] text-fg-muted">
              {formatSize(size, locale)}
              {encodingMenu && (
                <>
                  <span aria-hidden="true">·</span>
                  {/* One line, the encoding cut short in a narrow header:
                      wrapped, the line makes the header taller; overflowing,
                      it covers the buttons beside it */}
                  <span className="min-w-0">{encodingMenu}</span>
                </>
              )}
            </span>
          )}
        </div>
        {mine && (
          <>
            <IconButton
              size="sm"
              onClick={cancel}
              disabled={saving}
              aria-label={t('files.viewer.cancelEdit')}
              title={t('files.viewer.cancelEdit')}
            >
              <X size={16} aria-hidden="true" />
            </IconButton>
            <IconButton
              size="sm"
              onClick={() => save(mine)}
              disabled={!dirty || saving || rootMoved || stuck}
              aria-label={t('files.viewer.save')}
              title={t('files.viewer.saveTitle')}
              className="text-accent"
            >
              <Check size={16} aria-hidden="true" />
            </IconButton>
          </>
        )}
        {!mine && editable && (
          <IconButton
            size="sm"
            onClick={() =>
              editWith(
                editable,
                tableView && tableState?.ok ? tableState.delimiter : undefined,
              )
            }
            aria-label={t('files.viewer.edit')}
            title={t('files.viewer.edit')}
          >
            <Pencil size={15} aria-hidden="true" />
          </IconButton>
        )}
        {!compact && canPreviewDraft && (
          <IconButton
            size="sm"
            onClick={() => updateSetting('markdownEditLayout', nextLayout)}
            // Not "Show source": a diagram's own button is named so
            aria-label={t(LAYOUT_SWITCH[nextLayout])}
            title={t('files.viewer.layoutTitle', {
              layout: t(LAYOUT_LABELS[editLayout]),
              next: t(LAYOUT_NEXT[nextLayout]),
            })}
          >
            {LAYOUT_ICONS[editLayout]}
          </IconButton>
        )}
        <HeaderActions
          actions={extras}
          compact={compact}
          menuStart={
            canPreviewDraft && (
              <>
                <MenuGroup label={t('files.viewer.show')}>
                  {layouts.map((l) => (
                    <MenuItemRadio
                      key={l}
                      icon={LAYOUT_ICONS[l]}
                      checked={l === editLayout}
                      onSelect={() => updateSetting('markdownEditLayout', l)}
                    >
                      {t(LAYOUT_LABELS[l])}
                    </MenuItemRadio>
                  ))}
                </MenuGroup>
                {/* Wrap lines is always among them */}
                <MenuSeparator />
              </>
            )
          }
        />
        {headerExtra}
      </div>
      {mine &&
        !binaryView &&
        state.kind === 'error' &&
        state.error === 'not-found' && (
          // The file of a draft is gone from the host (deleted or renamed
          // elsewhere while the app was closed): the text can still be copied
          <Banner
            variant="warning"
            action={
              <span className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => copyText(mine.text)}
                >
                  {t('files.viewer.copyMine')}
                </Button>
                <Button size="sm" variant="secondary" onClick={cancel}>
                  {t('files.viewer.discard')}
                </Button>
              </span>
            }
          >
            {t('files.viewer.gone')}
          </Banner>
        )}
      {mine && !cells && (
        <SaveBanner
          error={saveError}
          rootMoved={rootMoved}
          onReload={() => (dirty ? setDiscarding('reload') : reloadFile())}
          onCopy={() => copyText(mine.text)}
        />
      )}
      {mine &&
        !cells &&
        draftTooLarge &&
        layouts.includes(chosen) &&
        chosen !== 'source' && (
          <Banner>{t('files.viewer.tooLargeToPreview')}</Banner>
        )}
      {mine &&
        !cells &&
        // One tree for every layout of a Markdown file, so a change of
        // layout (or the draft growing past the preview's limit) never
        // mounts the editor again
        (() => {
          const editor = (
            <FileEditor
              path={path}
              text={mine.text}
              onChange={(text) => setDraft({ ...mine, text })}
              wrap={wrap}
              saving={saving}
              rootMoved={rootMoved}
              dirty={dirty}
              onSave={() => save(mine)}
              notify={notify}
              reveal={mine.reveal}
              onSelectText={
                selectionPane === undefined
                  ? undefined
                  : (text) => recordSelection(selectionPane, text, path)
              }
              scrollTop={scrolled.current}
              at={pickInEditor ? pick : editAt}
              linesRef={onLineComment && editorLines}
              hidden={editLayout === 'preview'}
              onSyncSide={markdown ? setEditorSide : undefined}
              onPasteImage={
                markdown && canEdit && mine && !rootMoved && !saving
                  ? pasteImage
                  : undefined
              }
            />
          )
          if (!markdown) return editor
          return (
            <MarkdownEditLayout
              mode={editLayout}
              editor={editor}
              preview={
                <DraftPreview
                  text={mine.text}
                  path={path}
                  wrap={wrap}
                  // Back returns to where the editor was, not the preview
                  followScrollTop={() => scrolled.current ?? 0}
                  onSyncSide={setPreviewSide}
                  onFollow={onFollow}
                  notify={notify}
                />
              }
            />
          )
        })()}
      {!mine && asImage && !sensitive && (
        <div className="min-h-0 flex-1 overflow-auto">
          <ImagePreview
            state={image}
            alt={path}
            onRetry={() => setRetry((n) => n + 1)}
          />
        </div>
      )}
      {!mine && docKind && !sensitive && (
        <div className="flex min-h-0 flex-1 flex-col">
          <LazyDocumentPreview
            kind={docKind}
            path={path}
            state={doc}
            notify={notify}
            onRetry={() => setRetry((n) => n + 1)}
            onDownload={
              onDownload ? () => onDownload({ revealed: reveal }) : undefined
            }
          />
        </div>
      )}
      {!mine && !binaryView && state.kind === 'text' && preview && (
        <LazyMarkdownPreview
          text={state.text}
          path={path}
          wrap={wrap}
          anchor={leftPreview ? undefined : anchor}
          scrollTop={scrolled.current}
          onFollow={onFollow}
          notify={notify}
        />
      )}
      {cells && (
        <SaveBanner
          error={saveError}
          rootMoved={rootMoved}
          reloadLabel={t('files.viewer.reapply')}
          onReload={() => reapplyEdits(mine, cells)}
          onCopy={() => copyText(mine.text)}
        />
      )}
      {cells && skipped.length > 0 && (
        <SkippedEdits skipped={skipped} onCopy={copyText} />
      )}
      {/* One element for viewing and editing, so entering edits keeps the
          view's sort, filter and header row */}
      {(cells || (!mine && !binaryView && tableView)) && (
        <LazyTablePreview
          text={cells ? mine.text : (state as TextLoaded).text}
          path={path}
          wrap={wrap}
          notify={notify}
          onTableState={setTableState}
          scrollTop={scrolled.current}
          layout={tableKept.current}
          onLayout={(l) => {
            tableKept.current = l
            onTableLayout?.(l)
          }}
          // A cell clicked is on a table read: with the delimiter it was
          // read with
          onRequestEdit={
            editable && !mine
              ? () => editWith(editable, (tableState as TableState).delimiter)
              : undefined
          }
          editing={
            cells && {
              delimiter: cells.delimiter,
              ops: cells.ops,
              redo: cells.redo,
              saving,
              canSave: dirty && !saving && !rootMoved && !stuck,
              onChange: (text, ops, redo) =>
                setDraft({ ...mine, text, cells: { ...cells, ops, redo } }),
              onSave: () => save(mine),
            }
          }
        />
      )}
      {!mine && !binaryView && state.kind === 'text' && !previewOn && (
        <>
          {markdown && tooLarge && (
            <Banner>{t('files.viewer.tooLargeToPreview')}</Banner>
          )}
          <CodeBlock
            text={state.text}
            path={path}
            wrap={wrap}
            scrollTop={scrolled.current}
            line={pick?.line}
            jump={pick?.jump}
            onLineComment={
              onLineComment &&
              ((lines) => onLineComment(lineRange(lines, false)))
            }
            commentedLines={commentedLines}
          />
        </>
      )}
      {!mine && !binaryView && state.kind === 'loading' && (
        <SkeletonLines label={t('files.loading')} code className="flex-1" />
      )}
      {!mine && !binaryView && state.kind === 'unpreviewable' && (
        <ViewMessage>{t('files.viewer.unpreviewable')}</ViewMessage>
      )}
      {!mine && !binaryView && state.kind === 'error' && (
        <ViewMessage>
          {t(ERRORS[state.error])}
          {state.error === 'not-found' && onCloseTab && (
            // Gone from the host (deleted or renamed elsewhere): the tab
            // stays until the user closes it
            <Button size="sm" onClick={onCloseTab}>
              {t('files.viewer.closeTab')}
            </Button>
          )}
        </ViewMessage>
      )}
      {!mine && sensitive && (
        <ViewMessage>
          <Lock size={20} aria-hidden="true" />
          {t('files.viewer.sensitive')}
          {!canReveal && <span>{t('files.viewer.sensitiveViewOnly')}</span>}
        </ViewMessage>
      )}
      <SensitiveConfirm
        isOpen={canReveal && !mine && sensitive}
        onConfirm={() => {
          setReveal(true)
          onRevealed?.()
        }}
        onCancel={onCancelReveal ?? onClose}
      />
      <ConfirmDialog
        isOpen={!!discarding}
        title={t('files.viewer.askDiscard')}
        confirmLabel={t('files.viewer.discard')}
        destructive
        onConfirm={() => {
          const then = discarding
          setDiscarding(undefined)
          if (then === 'reload') {
            reloadFile()
            return
          }
          discard()
          if (then === 'back') onClose()
        }}
        onCancel={() => setDiscarding(undefined)}
      >
        {t('files.viewer.askDiscardBody')}
      </ConfirmDialog>
      {asking && (
        <ConfirmDialog
          isOpen
          title={t('files.viewer.askDelimiter')}
          confirmLabel={t('files.viewer.editAnyway')}
          onConfirm={() => {
            setAsking(undefined)
            beginEdit(asking.file, asking.delimiter)
          }}
          onCancel={() => setAsking(undefined)}
        >
          {t('files.viewer.askDelimiterBody', {
            detected: t(DELIMITER_SEPARATED[asking.detected]),
            delimiter: t(DELIMITER_SEPARATED[asking.delimiter]),
          })}
        </ConfirmDialog>
      )}
    </div>
  )
}

// Asks before showing a file (or diff) that usually holds secrets
export function SensitiveConfirm(props: {
  isOpen: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useT()
  return (
    <ConfirmDialog
      title={t('files.viewer.askShow')}
      confirmLabel={t('files.viewer.show')}
      {...props}
    >
      {t('files.viewer.askShowBody')}
    </ConfirmDialog>
  )
}
