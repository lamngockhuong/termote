import type { KeyboardEvent } from 'react'
import { RequestError } from '../hooks/use-mux-api'
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
  not_text: 'Only UTF-8 text without NUL characters can be saved',
  too_large: 'The file would be larger than 1 MiB',
  busy: 'Too many saves at once. Try again',
  storage_full: "The host's disk or quota is full",
  read_only: 'The file system there is read-only',
}

export function saveErrorOf(err: unknown): SaveError {
  if (!(err instanceof RequestError)) return { kind: 'unsure' }
  if (err.status === 409 && err.root) return { kind: 'root', root: err.root }
  if (err.code === 'changed') return { kind: 'changed' }
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
  error?: SaveError
  // The draft was read under another root than the pane's now (or a save
  // was told so): it cannot be saved
  rootMoved: boolean
  // There is something to save
  dirty: boolean
  onSave: () => void
  // Drops the draft and reads the file again
  onReload: () => void
  onCopy: () => void
}

// The text of a file being edited, in a plain textarea, with why the last
// save failed above it. The draft lives with the pane (useFileDraft): this
// only shows it.
export function FileEditor({
  path,
  text,
  onChange,
  wrap,
  saving,
  error,
  rootMoved,
  dirty,
  onSave,
  onReload,
  onCopy,
}: Props) {
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (dirty && !saving && !rootMoved) onSave()
    }
  }

  const copy = (
    <Button size="sm" variant="secondary" onClick={onCopy}>
      Copy my text
    </Button>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {rootMoved ? (
        <Banner variant="warning" action={copy}>
          This pane's folder changed. Copy your text, then discard it to open
          the file again.
        </Banner>
      ) : error?.kind === 'changed' ? (
        <Banner
          variant="warning"
          action={
            <span className="flex gap-1.5">
              <Button size="sm" variant="secondary" onClick={onReload}>
                Reload
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
      ) : null}
      <textarea
        aria-label={`Text of ${path}`}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        readOnly={saving}
        aria-busy={saving}
        wrap={wrap ? 'soft' : 'off'}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        className="min-h-0 w-full flex-1 resize-none bg-bg p-3 font-term text-[13px] leading-relaxed text-fg focus-visible:outline-none pointer-coarse:text-[16px]"
      />
    </div>
  )
}
