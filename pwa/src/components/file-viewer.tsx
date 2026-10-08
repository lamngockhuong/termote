import {
  ArrowLeft,
  Check,
  Copy,
  Eye,
  Image as ImageIcon,
  Lock,
  Pencil,
  Trash2,
  WrapText,
  X,
} from 'lucide-react'
import {
  type ComponentProps,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  type FileDraft,
  type FilesError,
  filesError,
  useFileDraft,
} from '../hooks/use-files'
import { imageErrorCode, useImageBlob } from '../hooks/use-image-blob'
import {
  type FileContent,
  fetchFileContent,
  RequestError,
  saveFileContent,
} from '../hooks/use-mux-api'
import { useSettings } from '../hooks/use-settings'
import type { Reapplied, Skipped, TableOp } from '../utils/csv-edits'
import {
  DELIMITER_NAMES,
  type Delimiter,
  delimiterFor,
  isTablePath,
} from '../utils/csv-parse'
import { CsvClient } from '../utils/csv-parse-client'
import { formatSize, keepOrder, TRUNCATE_START } from '../utils/files-format'
import { HIGHLIGHT_MAX_BYTES } from '../utils/highlight'
import { isImagePath, isSvgPath } from '../utils/image-path'
import { isMarkdownPath, type LinkPath } from '../utils/markdown-links'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { CodeBlock } from './code-block'
import {
  FileEditor,
  SaveBanner,
  type SaveError,
  saveErrorOf,
} from './file-editor'
import { ImagePreview } from './image-preview'
import { ViewMessage } from './pane-dir-header'
import type { TableState } from './table-preview'
import { Banner } from './ui/banner'
import { Button, IconButton } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'

// The markdown renderer: loaded the first time a Markdown file is previewed
const MarkdownPreview = lazy(() => import('./markdown-preview'))

export function LazyMarkdownPreview(
  props: ComponentProps<typeof MarkdownPreview>,
) {
  return (
    <Suspense fallback={<ViewMessage>Loading…</ViewMessage>}>
      <MarkdownPreview {...props} />
    </Suspense>
  )
}

// The table view of a CSV/TSV file: loaded the first time one is shown
const TablePreview = lazy(() => import('./table-preview'))

export function LazyTablePreview(props: ComponentProps<typeof TablePreview>) {
  return (
    <Suspense fallback={<ViewMessage>Loading…</ViewMessage>}>
      <TablePreview {...props} />
    </Suspense>
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
      editable: boolean
    }
  | { kind: 'unpreviewable'; size: number }
  | { kind: 'sensitive' }
  | { kind: 'error'; error: FilesError }

type TextLoaded = Extract<Loaded, { kind: 'text' }>

function loaded(c: FileContent): Loaded {
  if ('sensitive' in c) return { kind: 'sensitive' }
  if ('previewable' in c) return { kind: 'unpreviewable', size: c.size }
  return {
    kind: 'text',
    root: c.root,
    text: c.text,
    size: c.size,
    hash: c.hash,
    editable: c.editable,
  }
}

// A draft of file: its text as read, with "\n" line breaks (a textarea turns
// every one into "\n": compared, and sent, so). With a delimiter it is edited
// in the table view, from edits already made on that text.
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
    text: edits?.text ?? base,
    reveal,
    cells: delimiter && { delimiter, ops: edits?.ops ?? [], redo: [] },
  }
}

// A draft that changed while its save ran (another view of the pane edited
// it): the text saved becomes its base. Its table edits stay only when they
// began with the ones saved; else it goes on as text, since edits applied
// again after a conflict must turn the base into the text.
export function rebaseDraft(
  now: FileDraft,
  saved: FileDraft,
  saveRoot: string,
  saveHash: string,
): FileDraft {
  const done = saved.cells?.ops ?? []
  const ops = now.cells?.ops
  const follows = !!ops && done.every((op, i) => ops[i] === op)
  return {
    ...now,
    root: saveRoot,
    baseHash: saveHash,
    base: saved.text,
    cells:
      now.cells && follows
        ? { ...now.cells, ops: now.cells.ops.slice(done.length) }
        : undefined,
  }
}

const separated = (d: Delimiter) =>
  `${DELIMITER_NAMES[d].toLowerCase()}-separated`

const SKIP_REASONS: Record<Skipped['reason'], string> = {
  missing: 'its row is no longer in the file',
  many: 'more than one row matches it',
  depends: 'it follows a row change that was not applied',
  unreadable: 'the file can no longer be edited as a table',
}

function describeOp(op: TableOp): string {
  if (op.kind === 'cell') {
    return `Row ${op.row + 1}, column ${visibleUnsafe(op.name)}`
  }
  if (op.kind === 'insert') {
    return op.after < 0
      ? 'The row added at the top'
      : `The row added after row ${op.after + 1}`
  }
  return `Deleting row ${op.row + 1}`
}

// The edits a reload could not apply again, and why; a cell's value can be
// copied, to set it again by hand
function SkippedEdits(props: {
  skipped: Skipped[]
  onCopy: (value: string) => void
}) {
  return (
    <Banner variant="warning">
      Not applied to the new file:
      <ul className="m-0 mt-1 list-none p-0">
        {props.skipped.map(({ op, reason }, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole
          <li key={i} className="flex flex-wrap items-center gap-1.5 py-0.5">
            <bdi>{describeOp(op)}</bdi>: {SKIP_REASONS[reason]}
            {op.kind === 'cell' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => props.onCopy(op.after)}
              >
                Copy value
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Banner>
  )
}

const ERRORS: Record<FilesError, string> = {
  'not-allowed': "This file can't be shown",
  'not-found': 'File not found',
  unsupported: 'Not supported by this backend',
  unavailable: 'Could not load the file',
}

interface Props {
  paneId: string
  root?: string
  path: string
  // Wrap long lines at first (mobile)
  wrapByDefault: boolean
  // Where a Markdown preview starts: a heading, else an offset to restore
  anchor?: string
  scrollTop?: number
  // The file a link was followed from, which Back returns to
  backTo?: string
  // What Back is called instead (the Changes view's diff)
  backLabel?: string
  // Back: to backTo, else to the tree
  onClose: () => void
  // A link of the preview to another file or a directory
  onFollow: (target: LinkPath, scrollTop: number) => void
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
}

// One file of the tree: its text with line numbers, or why it cannot be
// shown. A file that usually holds secrets is shown only after the user says
// so, every time it is opened: the caller keys this by root and path, so
// another file (or the same path under a new root) never inherits a reveal.
// Edit turns the text into a textarea; the draft is the pane's
// (useFileDraft), so a remount opens it again where it was.
export function FileViewer({
  paneId,
  root,
  path,
  wrapByDefault,
  anchor,
  scrollTop,
  backTo,
  backLabel,
  onClose,
  onFollow,
  onRootChanged,
  notify,
  canEdit = false,
  startEditing = false,
  initialReveal = false,
  onSaved,
  onDelete,
}: Props) {
  const [state, setState] = useState<Loaded>({ kind: 'loading' })
  const [draft, setDraft] = useFileDraft(paneId)
  // The pane's draft, when it is this file's
  const mine = draft?.path === path ? draft : undefined
  const [reveal, setReveal] = useState(initialReveal || !!mine?.reveal)
  const [saving, setSaving] = useState(false)
  // What a confirmed Discard goes on to do
  const [discarding, setDiscarding] = useState<'cancel' | 'back'>()
  // A pane keeps one draft: unsaved changes to another file are dropped
  // only once the user says so
  const other =
    draft && draft.path !== path && draft.text !== draft.base
      ? draft
      : undefined
  // The file to edit once the other draft is discarded, that draft's path,
  // and the delimiter of the table it is edited in, if it is
  const [replacing, setReplacing] = useState<{
    file: TextLoaded
    other: string
    delimiter?: Delimiter
  }>()
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
  // Markdown that can be previewed: the choice (remembered on this device)
  // says how it shows
  const markdown = isMarkdownPath(path)
  const tooLarge = state.kind === 'text' && state.size > PREVIEW_MAX_BYTES
  const canPreview = markdown && state.kind === 'text' && !tooLarge
  const preview = canPreview && settings.markdownPreview
  // Where the preview started (the link's heading, the offset Back restored)
  // is used up once the user leaves it: Source then Preview starts at the top
  const [leftPreview, setLeftPreview] = useState(false)
  // A CSV/TSV file is a table, whatever its size (up to the 1 MiB a read
  // returns), unless the user chose its source
  const canTable = isTablePath(path) && state.kind === 'text'
  const tableView = canTable && settings.tablePreview
  const togglePreview = () => {
    if (canTable) {
      updateSetting('tablePreview', !tableView)
      return
    }
    if (preview) setLeftPreview(true)
    updateSetting('markdownPreview', !preview)
  }
  const previewOn = preview || tableView
  // An image (or an SVG the user wants as one) is read through files/raw
  const svg = isSvgPath(path)
  const asImage = isImagePath(path) || (svg && settings.svgPreview)
  const [retry, setRetry] = useState(0)
  const image = useImageBlob(
    paneId,
    asImage ? { path, root, reveal } : null,
    String(retry),
    onRootChanged,
  )
  const sensitive = asImage
    ? imageErrorCode(image) === 'sensitive'
    : state.kind === 'sensitive'
  const size = asImage
    ? image.status === 'ready'
      ? image.size
      : undefined
    : 'size' in state
      ? state.size
      : undefined
  const back =
    backLabel ??
    (backTo
      ? `Back to ${backTo.slice(backTo.lastIndexOf('/') + 1)}`
      : 'Back to files')
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
    canEdit && !asImage && state.kind === 'text' && state.editable
      ? state
      : undefined

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload reads the file again
  useEffect(() => {
    if (asImage) return
    let live = true
    setState({ kind: 'loading' })
    fetchFileContent(paneId, path, { root, reveal }).then(
      (c) => live && setState(loaded(c)),
      (err) => {
        if (!live) return
        if (err instanceof RequestError && err.status === 409 && err.root) {
          // The root prop follows and the file is read again from it
          onRootChanged(err.root)
          return
        }
        setState({ kind: 'error', error: filesError(err) })
      },
    )
    return () => {
      live = false
    }
  }, [paneId, root, path, reveal, asImage, onRootChanged, reload])

  const beginEdit = (file: TextLoaded, delimiter?: Delimiter) => {
    setSaveError(undefined)
    setSkipped([])
    setDraft(draftOf(file, path, reveal, delimiter))
  }

  // Into the table editor with delimiter, after asking when the file reads
  // as another one: edits written with the wrong one shift the columns
  const editWith = (file: TextLoaded, delimiter?: Delimiter) => {
    const detected = delimiter && delimiterFor(path, file.text)
    if (delimiter && detected !== delimiter) {
      setAsking({ file, delimiter, detected: detected as Delimiter })
    } else beginEdit(file, delimiter)
  }

  // With a delimiter, the table being viewed is edited; else the text
  const requestEdit = (file: TextLoaded, delimiter?: Delimiter) =>
    other
      ? setReplacing({ file, other: other.path, delimiter })
      : editWith(file, delimiter)

  // Changes view: into editing once, as soon as the file can be; not again
  // after the draft found at mount is discarded
  const started = useRef(!!mine)
  useEffect(() => {
    if (!startEditing || started.current || mine || !editable) return
    started.current = true
    requestEdit(editable)
  })

  const discard = () => {
    setDraft(undefined)
    setSaveError(undefined)
    setSkipped([])
    // The save saw the root move: now the file is read from the new one
    if (saveError?.kind === 'root' && saveError.root)
      onRootChanged(saveError.root)
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

  // Called only while no save runs (Save and Ctrl+S are off meanwhile)
  const save = async (edit: FileDraft) => {
    setSaving(true)
    setSaveError(undefined)
    try {
      const res = await saveFileContent(paneId, {
        root: edit.root,
        path,
        baseHash: edit.baseHash,
        text: edit.text,
        reveal: edit.reveal,
      })
      setState({
        kind: 'text',
        root: res.root,
        text: edit.crlf ? edit.text.replace(/\n/g, '\r\n') : edit.text,
        size: res.size,
        hash: res.hash,
        editable: true,
      })
      // Only the draft sent is dropped: one changed meanwhile stays
      setDraft((now) =>
        now === edit
          ? undefined
          : now?.path === path
            ? rebaseDraft(now, edit, res.root, res.hash)
            : now,
      )
      setSkipped([])
      notify('Saved')
      onSaved?.()
    } catch (err) {
      setSaveError(saveErrorOf(err))
    } finally {
      setSaving(false)
    }
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
        await fetchFileContent(paneId, path, {
          root: edit.root,
          reveal: edit.reveal,
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
        notify('Your changes are already in the file')
      }
    } catch (err) {
      if (err instanceof RequestError && err.status === 409 && err.root) {
        setSaveError({ kind: 'root', root: err.root })
      } else notify('Could not read the file again')
    } finally {
      setSaving(false)
    }
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify('Text copied')
    } catch {
      notify('Could not copy the text')
    }
  }

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path)
      notify('Path copied')
    } catch {
      notify('Could not copy the path')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
            <span className="text-[11px] text-fg-muted">
              {formatSize(size)}
            </span>
          )}
        </div>
        {mine && (
          <>
            <IconButton
              size="sm"
              onClick={cancel}
              disabled={saving}
              aria-label="Cancel editing"
              title="Cancel editing"
            >
              <X size={16} aria-hidden="true" />
            </IconButton>
            <IconButton
              size="sm"
              onClick={() => save(mine)}
              disabled={!dirty || saving || rootMoved || stuck}
              aria-label="Save"
              title="Save (Ctrl+S)"
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
              requestEdit(
                editable,
                tableView && tableState?.ok ? tableState.delimiter : undefined,
              )
            }
            aria-label="Edit"
            title="Edit"
          >
            <Pencil size={15} aria-hidden="true" />
          </IconButton>
        )}
        {!mine && onDelete && (
          <IconButton
            size="sm"
            onClick={() =>
              onDelete({
                // The text shown: its bytes are what a delete must match
                hash: state.kind === 'text' ? state.hash : undefined,
                sensitive: sensitive || reveal,
              })
            }
            aria-label="Delete"
            title="Delete"
          >
            <Trash2 size={15} aria-hidden="true" />
          </IconButton>
        )}
        {!mine && (
          <IconButton
            size="sm"
            onClick={copyPath}
            aria-label="Copy path"
            title="Copy path"
          >
            <Copy size={15} aria-hidden="true" />
          </IconButton>
        )}
        {!mine && (canPreview || canTable) && (
          <IconButton
            size="sm"
            onClick={togglePreview}
            aria-label="Preview"
            aria-pressed={previewOn}
            title={previewOn ? 'Show the source' : 'Show the preview'}
            className={previewOn ? 'text-accent' : ''}
          >
            <Eye size={15} aria-hidden="true" />
          </IconButton>
        )}
        {!mine && svg && (
          <IconButton
            size="sm"
            onClick={() => updateSetting('svgPreview', !asImage)}
            aria-label="Image"
            aria-pressed={asImage}
            title={asImage ? 'Show the source' : 'Show as an image'}
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
      </div>
      {mine && !cells && (
        <FileEditor
          path={path}
          text={mine.text}
          onChange={(text) => setDraft({ ...mine, text })}
          wrap={wrap}
          saving={saving}
          error={saveError}
          rootMoved={rootMoved}
          dirty={dirty}
          onSave={() => save(mine)}
          onReload={() => {
            discard()
            setReload((n) => n + 1)
          }}
          onCopy={() => copyText(mine.text)}
        />
      )}
      {!mine && asImage && !sensitive && (
        <div className="min-h-0 flex-1 overflow-auto">
          <ImagePreview
            state={image}
            alt={path}
            onRetry={() => setRetry((n) => n + 1)}
          />
        </div>
      )}
      {!mine && !asImage && state.kind === 'text' && preview && (
        <LazyMarkdownPreview
          text={state.text}
          path={path}
          wrap={wrap}
          anchor={leftPreview ? undefined : anchor}
          scrollTop={leftPreview ? undefined : scrollTop}
          onFollow={onFollow}
          notify={notify}
        />
      )}
      {cells && (
        <SaveBanner
          error={saveError}
          rootMoved={rootMoved}
          reloadLabel="Reload and reapply"
          onReload={() => reapplyEdits(mine, cells)}
          onCopy={() => copyText(mine.text)}
        />
      )}
      {cells && skipped.length > 0 && (
        <SkippedEdits skipped={skipped} onCopy={copyText} />
      )}
      {/* One element for viewing and editing, so entering edits keeps the
          view's sort, filter and header row */}
      {(cells || (!mine && !asImage && tableView)) && (
        <LazyTablePreview
          text={cells ? mine.text : (state as TextLoaded).text}
          path={path}
          wrap={wrap}
          notify={notify}
          onTableState={setTableState}
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
      {!mine && !asImage && state.kind === 'text' && !previewOn && (
        <>
          {markdown && tooLarge && (
            <Banner>Too large to preview: shown as source</Banner>
          )}
          <CodeBlock text={state.text} path={path} wrap={wrap} />
        </>
      )}
      {!mine && !asImage && state.kind === 'loading' && (
        <ViewMessage>Loading…</ViewMessage>
      )}
      {!mine && !asImage && state.kind === 'unpreviewable' && (
        <ViewMessage>
          Not previewable (binary, special file or larger than 1 MiB)
        </ViewMessage>
      )}
      {!mine && !asImage && state.kind === 'error' && (
        <ViewMessage>{ERRORS[state.error]}</ViewMessage>
      )}
      {!mine && sensitive && (
        <ViewMessage>
          <Lock size={20} aria-hidden="true" />
          This file may contain secrets
        </ViewMessage>
      )}
      <SensitiveConfirm
        isOpen={!mine && sensitive}
        onConfirm={() => setReveal(true)}
        onCancel={onClose}
      />
      <ConfirmDialog
        isOpen={!!discarding}
        title="Discard changes?"
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          const then = discarding
          setDiscarding(undefined)
          discard()
          if (then === 'back') onClose()
        }}
        onCancel={() => setDiscarding(undefined)}
      >
        Your changes to this file will be lost.
      </ConfirmDialog>
      {replacing && (
        <ConfirmDialog
          isOpen
          title="Discard other changes?"
          confirmLabel="Discard"
          destructive
          onConfirm={() => {
            setReplacing(undefined)
            editWith(replacing.file, replacing.delimiter)
          }}
          onCancel={() => setReplacing(undefined)}
        >
          Your unsaved changes to {replacing.other} will be lost.
        </ConfirmDialog>
      )}
      {asking && (
        <ConfirmDialog
          isOpen
          title="Edit with another delimiter?"
          confirmLabel="Edit anyway"
          onConfirm={() => {
            setAsking(undefined)
            beginEdit(asking.file, asking.delimiter)
          }}
          onCancel={() => setAsking(undefined)}
        >
          This file looks {separated(asking.detected)}, and you are viewing it
          as {separated(asking.delimiter)}. Edits are written with that
          delimiter, which can shift its columns.
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
  return (
    <ConfirmDialog title="Show this file?" confirmLabel="Show" {...props}>
      This file may contain secrets. Show its contents?
    </ConfirmDialog>
  )
}
