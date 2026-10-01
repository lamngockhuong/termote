import { ArrowLeft, Copy, Lock, WrapText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type FilesError, filesError } from '../hooks/use-files'
import {
  type FileContent,
  fetchFileContent,
  RequestError,
} from '../hooks/use-mux-api'
import { formatSize, keepOrder, TRUNCATE_START } from '../utils/files-format'
import { CodeBlock } from './code-block'
import { ViewMessage } from './pane-dir-header'
import { IconButton } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'

type Loaded =
  | { kind: 'loading' }
  | { kind: 'text'; text: string; size: number }
  | { kind: 'unpreviewable'; size: number }
  | { kind: 'sensitive' }
  | { kind: 'error'; error: FilesError }

function loaded(c: FileContent): Loaded {
  if ('sensitive' in c) return { kind: 'sensitive' }
  if ('previewable' in c) return { kind: 'unpreviewable', size: c.size }
  return { kind: 'text', text: c.text, size: c.size }
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
  onClose: () => void
  onRootChanged: (root: string) => void
  notify: (message: string) => void
}

// One file of the tree: its text with line numbers, or why it cannot be
// shown. A file that usually holds secrets is shown only after the user says
// so, every time it is opened: the caller keys this by root and path, so
// another file (or the same path under a new root) never inherits a reveal.
export function FileViewer({
  paneId,
  root,
  path,
  wrapByDefault,
  onClose,
  onRootChanged,
  notify,
}: Props) {
  const [state, setState] = useState<Loaded>({ kind: 'loading' })
  const [reveal, setReveal] = useState(false)
  const [wrap, setWrap] = useState(wrapByDefault)

  useEffect(() => {
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
  }, [paneId, root, path, reveal, onRootChanged])

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
          onClick={onClose}
          aria-label="Back to files"
          title="Back to files"
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
          {'size' in state && (
            <span className="text-[11px] text-fg-muted">
              {formatSize(state.size)}
            </span>
          )}
        </div>
        <IconButton
          size="sm"
          onClick={copyPath}
          aria-label="Copy path"
          title="Copy path"
        >
          <Copy size={15} aria-hidden="true" />
        </IconButton>
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
      </div>
      {state.kind === 'text' && (
        <CodeBlock text={state.text} path={path} wrap={wrap} />
      )}
      {state.kind === 'loading' && <ViewMessage>Loading…</ViewMessage>}
      {state.kind === 'unpreviewable' && (
        <ViewMessage>
          Not previewable (binary, special file or larger than 1 MiB)
        </ViewMessage>
      )}
      {state.kind === 'error' && (
        <ViewMessage>{ERRORS[state.error]}</ViewMessage>
      )}
      {state.kind === 'sensitive' && (
        <ViewMessage>
          <Lock size={20} aria-hidden="true" />
          This file may contain secrets
        </ViewMessage>
      )}
      <SensitiveConfirm
        isOpen={state.kind === 'sensitive'}
        onConfirm={() => setReveal(true)}
        onCancel={onClose}
      />
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
