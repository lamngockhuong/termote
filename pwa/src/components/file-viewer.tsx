import { ArrowLeft, Copy, Eye, Lock, WrapText } from 'lucide-react'
import { type ComponentProps, lazy, Suspense, useEffect, useState } from 'react'
import { type FilesError, filesError } from '../hooks/use-files'
import {
  type FileContent,
  fetchFileContent,
  RequestError,
} from '../hooks/use-mux-api'
import { useSettings } from '../hooks/use-settings'
import { formatSize, keepOrder, TRUNCATE_START } from '../utils/files-format'
import { HIGHLIGHT_MAX_BYTES } from '../utils/highlight'
import { isMarkdownPath, type LinkPath } from '../utils/markdown-links'
import { CodeBlock } from './code-block'
import { ViewMessage } from './pane-dir-header'
import { Banner } from './ui/banner'
import { IconButton } from './ui/button'
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

// Beyond this a Markdown file is shown as its source
export const PREVIEW_MAX_BYTES = HIGHLIGHT_MAX_BYTES

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
  // Where a Markdown preview starts: a heading, else an offset to restore
  anchor?: string
  scrollTop?: number
  // The file a link was followed from, which Back returns to
  backTo?: string
  // Back: to backTo, else to the tree
  onClose: () => void
  // A link of the preview to another file or a directory
  onFollow: (target: LinkPath, scrollTop: number) => void
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
  anchor,
  scrollTop,
  backTo,
  onClose,
  onFollow,
  onRootChanged,
  notify,
}: Props) {
  const [state, setState] = useState<Loaded>({ kind: 'loading' })
  const [reveal, setReveal] = useState(false)
  const [wrap, setWrap] = useState(wrapByDefault)
  const { settings, updateSetting } = useSettings()
  // Markdown that can be previewed: the choice (remembered on this device)
  // says how it shows
  const markdown = isMarkdownPath(path)
  const tooLarge = state.kind === 'text' && state.size > PREVIEW_MAX_BYTES
  const canPreview = markdown && state.kind === 'text' && !tooLarge
  const preview = canPreview && settings.markdownPreview
  const back = backTo
    ? `Back to ${backTo.slice(backTo.lastIndexOf('/') + 1)}`
    : 'Back to files'

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
        <IconButton size="sm" onClick={onClose} aria-label={back} title={back}>
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
        {canPreview && (
          <IconButton
            size="sm"
            onClick={() => updateSetting('markdownPreview', !preview)}
            aria-label="Preview"
            aria-pressed={preview}
            title={preview ? 'Show the source' : 'Show the preview'}
            className={preview ? 'text-accent' : ''}
          >
            <Eye size={15} aria-hidden="true" />
          </IconButton>
        )}
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
      {state.kind === 'text' && preview && (
        <LazyMarkdownPreview
          text={state.text}
          path={path}
          wrap={wrap}
          anchor={anchor}
          scrollTop={scrollTop}
          onFollow={onFollow}
          notify={notify}
        />
      )}
      {state.kind === 'text' && !preview && (
        <>
          {markdown && tooLarge && (
            <Banner>Too large to preview: shown as source</Banner>
          )}
          <CodeBlock text={state.text} path={path} wrap={wrap} />
        </>
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
