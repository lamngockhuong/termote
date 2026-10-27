import {
  type KeyboardEvent,
  type RefObject,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'
import { useMediaQuery } from '../hooks/use-media-query'
import { type FileEncoding, RequestError } from '../hooks/use-mux-api'
import type { SyncSide } from '../hooks/use-scroll-sync'
import { encodingLabel } from '../utils/file-encoding'
import { lazyRetry } from '../utils/lazy-retry'
import { selectedLines, type TextLines } from '../utils/line-range'
import type { PasteEdit } from '../utils/markdown-image-paste'
import { imageFromClipboard } from '../utils/upload-image'
import type { EditorAt } from './code-editor'
import { LazyBoundary } from './lazy-boundary'
import { ViewMessage } from './pane-dir-header'
import { Banner } from './ui/banner'
import { Button } from './ui/button'

// Why a save did not go through, as the editor shows it
export type SaveError =
  // The file changed on the host since it was read: never overwritten
  | { kind: 'changed' }
  // The pane's root moved: the file now read is another one
  | { kind: 'root'; root?: string }
  // Timed out or the connection dropped: it may have been written
  | { kind: 'unsure' }
  | { kind: 'refused'; message: string }

const REFUSED: Record<string, string> = {
  sensitive: 'Show the file before saving it',
  permission: "The server can't write this file",
  not_editable: "This file can't be edited here",
  not_text: 'Only text without NUL characters can be saved',
  too_large: 'The file would be larger than 1 MiB',
  busy: 'Too many saves at once. Try again',
  storage_full: "The host's disk or quota is full",
  read_only: 'The file system there is read-only',
}

// encoding: what the save wrote the text in, to name it when a character
// does not fit
export function saveErrorOf(
  err: unknown,
  encoding: FileEncoding = 'utf-8',
): SaveError {
  if (!(err instanceof RequestError)) return { kind: 'unsure' }
  if (err.status === 409 && err.root) return { kind: 'root', root: err.root }
  if (err.code === 'changed') return { kind: 'changed' }
  if (err.code === 'unencodable')
    return {
      kind: 'refused',
      message: `Line ${err.line} has "${err.char}", which ${encodingLabel(encoding)} can't hold. Change it or save as UTF-8`,
    }
  // A draft kept from before encodings, of a file no longer UTF-8
  if (err.code === 'not_editable' && err.reason === 'encoding-required')
    return { kind: 'refused', message: 'Reload the app to save this file' }
  const message =
    REFUSED[err.code] ??
    (err.status === 404
      ? 'File not found on the host'
      : err.status === 403
        ? "This file can't be written"
        : 'Could not save the file')
  return { kind: 'refused', message }
}

interface Props {
  path: string
  text: string
  onChange: (text: string) => void
  wrap: boolean
  saving: boolean
  // The draft was read under another root than the pane's now (or a save
  // was told so): it cannot be saved
  rootMoved: boolean
  // There is something to save
  dirty: boolean
  onSave: () => void
  notify: (message: string) => void
  // A sensitive file the user chose to show
  reveal?: boolean
  // Text the user selected (not for a sensitive file shown)
  onSelectText?: (text: string) => void
  // Where it starts scrolled to (a tab shown again)
  scrollTop?: number
  // Where the desktop editor puts the cursor (a search result, a diff's
  // change); the textarea opens where it was, never moving the focus there
  // (a phone's keyboard would come up)
  at?: EditorAt
  // Set to what reads the whole lines selected, for a review comment
  linesRef?: RefObject<(() => TextLines) | null>
  // Out of sight for now (a Markdown file's preview shows alone), kept
  // mounted: the desktop editor measures itself again once it shows
  hidden?: boolean
  // The desktop editor's line at its top, for a preview that scrolls with
  // it (the textarea has none)
  onSyncSide?: (side: SyncSide | null) => void
  // An image pasted alone: edit puts text where the cursor is, then
  // replaces it
  onPasteImage?: (file: File, edit: PasteEdit) => void
}

// Why the last save of a draft failed, and what the user can do about it:
// the same for the textarea and the table view
export function SaveBanner({
  error,
  rootMoved,
  reloadLabel = 'Reload',
  onReload,
  onCopy,
}: {
  error?: SaveError
  rootMoved: boolean
  reloadLabel?: string
  onReload: () => void
  onCopy: () => void
}) {
  const copy = (
    <Button size="sm" variant="secondary" onClick={onCopy}>
      Copy my text
    </Button>
  )
  return rootMoved ? (
    <Banner variant="warning" action={copy}>
      This pane's folder changed. Copy your text, then discard it to open the
      file again.
    </Banner>
  ) : error?.kind === 'changed' ? (
    <Banner
      variant="warning"
      action={
        <span className="flex gap-1.5">
          <Button size="sm" variant="secondary" onClick={onReload}>
            {reloadLabel}
          </Button>
          {copy}
        </span>
      }
    >
      The file changed on the host since you opened it
    </Banner>
  ) : error?.kind === 'unsure' ? (
    <Banner variant="warning">
      Not sure the file was saved. Saving again is safe.
    </Banner>
  ) : error?.kind === 'refused' ? (
    <Banner variant="danger">{error.message}</Banner>
  ) : null
}

// The editor of a device with a fine pointer: loaded the first time a file
// is edited there
const CodeEditor = lazyRetry(() => import('./code-editor'), 'CodeEditor')

// The text of a file being edited: CodeMirror where the main pointer is fine
// (a mouse), else a plain textarea (phones and touch tablets). The draft
// lives with the pane (useFileDraft): this only shows it. Why the last save
// failed shows above it, in the viewer (SaveBanner).
export function FileEditor(props: Props) {
  const { rootMoved } = props
  const fine = useMediaQuery('(pointer: fine)')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {fine ? (
        <LazyBoundary
          onRetry={CodeEditor.retry}
          // Its chunk could not load: the text is still edited and saved,
          // in the textarea
          fallback={(retry) => (
            <>
              <Banner
                variant="warning"
                action={
                  <Button size="sm" variant="secondary" onClick={retry}>
                    Retry
                  </Button>
                }
              >
                Could not load the editor
              </Banner>
              <PlainEditor {...props} />
            </>
          )}
        >
          <Suspense fallback={<ViewMessage>Loading…</ViewMessage>}>
            <CodeEditor
              path={props.path}
              text={props.text}
              onChange={props.onChange}
              wrap={props.wrap}
              saving={props.saving}
              canSave={props.dirty && !props.saving && !rootMoved}
              onSave={props.onSave}
              notify={props.notify}
              reveal={props.reveal}
              onSelectText={props.onSelectText}
              scrollTop={props.scrollTop}
              at={props.at}
              linesRef={props.linesRef}
              hidden={props.hidden}
              onSyncSide={props.onSyncSide}
              onPasteImage={props.onPasteImage}
            />
          </Suspense>
        </LazyBoundary>
      ) : (
        <PlainEditor {...props} />
      )}
    </div>
  )
}

// The text in a plain textarea
function PlainEditor({
  path,
  text,
  onChange,
  wrap,
  saving,
  rootMoved,
  dirty,
  onSave,
  onSelectText,
  scrollTop,
  linesRef,
  hidden = false,
  onPasteImage,
}: Props) {
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!linesRef) return
    linesRef.current = () => {
      const el = area.current as HTMLTextAreaElement
      return selectedLines(el.value, el.selectionStart, el.selectionEnd)
    }
    return () => {
      linesRef.current = null
    }
  }, [linesRef])
  // Where the cursor goes once text inserted for the user (an image's
  // placeholder) is shown
  const caret = useRef<number>(undefined)
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the text with it shows
  useLayoutEffect(() => {
    if (caret.current === undefined) return
    const el = area.current as HTMLTextAreaElement
    el.setSelectionRange(caret.current, caret.current)
    caret.current = undefined
  }, [text])
  // Where it opens, once it shows: hidden, it has no height to scroll
  const pending = useRef(scrollTop)
  useLayoutEffect(() => {
    if (hidden || !pending.current) return
    ;(area.current as HTMLTextAreaElement).scrollTop = pending.current
    pending.current = undefined
  }, [hidden])

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (dirty && !saving && !rootMoved) onSave()
    }
  }

  return (
    <textarea
      ref={area}
      data-scroll-restore
      aria-label={`Text of ${path}`}
      value={text}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={(e) => {
        const file = onPasteImage && imageFromClipboard(e.clipboardData)
        if (!onPasteImage || !file) return
        e.preventDefault()
        const el = e.currentTarget
        // Through onChange, never the element's value: React would not know
        // of the change, and could miss the next one. The cursor stays by
        // the text it was next to.
        onPasteImage(file, {
          insert: (text) => {
            const { selectionStart: from, selectionEnd: to, value } = el
            caret.current = from + text.length
            onChange(value.slice(0, from) + text + value.slice(to))
          },
          replace: (find, with_) => {
            const at = el.isConnected ? el.value.indexOf(find) : -1
            if (at < 0) return false
            const pos = el.selectionStart
            const shift = with_.length - find.length
            caret.current =
              pos >= at + find.length
                ? pos + shift
                : Math.min(pos, at + with_.length)
            onChange(
              el.value.slice(0, at) + with_ + el.value.slice(at + find.length),
            )
            return true
          },
        })
      }}
      onSelect={(e) => {
        const el = e.currentTarget
        if (el.selectionStart !== el.selectionEnd)
          onSelectText?.(el.value.slice(el.selectionStart, el.selectionEnd))
      }}
      readOnly={saving}
      aria-busy={saving}
      wrap={wrap ? 'soft' : 'off'}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      className="min-h-0 w-full flex-1 resize-none bg-bg p-3 font-term text-[13px] leading-relaxed text-fg focus-visible:outline-none pointer-coarse:text-[16px]"
    />
  )
}
