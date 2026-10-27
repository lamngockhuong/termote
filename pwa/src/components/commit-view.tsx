import { ArrowLeft, Lock, WrapText } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { type FilesError, filesError } from '../hooks/use-files'
import {
  type CommitFile,
  type CommitInfo,
  type FileDiff,
  fetchCommitDiff,
  fetchLastCommit,
  RequestError,
} from '../hooks/use-mux-api'
import { keepOrder, TRUNCATE_START } from '../utils/files-format'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { ChangeRowButton, STATUS } from './change-status'
import { DiffBody } from './diff-viewer'
import { SensitiveConfirm } from './file-viewer'
import { ViewMessage } from './pane-dir-header'
import { Banner } from './ui/banner'
import { IconButton } from './ui/button'

type Loaded =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'none' }
  | { kind: 'commit'; commit: CommitInfo }

type FileLoaded =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'sensitive' }
  | { kind: 'diff'; diff: FileDiff }

const ERRORS: Record<FilesError, string> = {
  'not-allowed': "This file can't be shown",
  'view-only': 'View only: files show in a git repository only',
  'not-found': 'Not in the last commit',
  unsupported: 'Not supported by this backend',
  unavailable: 'Could not load the commit',
}

// The last commit of the pane's repo, read only: its message, author and
// date, the files it changed (against its first parent), and each one's
// diff. Opened from an empty Changes list; HEAD is read again whenever it
// moves under a diff asked for.
export function CommitView({
  paneId,
  root,
  isMobile,
  canReveal,
  onBack,
  onRootChanged,
}: {
  paneId: string
  // The root the Changes list was read under, if any
  root?: string
  isMobile: boolean
  // A view-only client cannot show a sensitive file
  canReveal: boolean
  onBack: () => void
  onRootChanged: (root: string) => void
}) {
  const [state, setState] = useState<Loaded>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const [file, setFile] = useState<CommitFile>()
  const headMoved = useCallback(() => {
    setFile(undefined)
    setReload((n) => n + 1)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload reads HEAD again
  useEffect(() => {
    let live = true
    setState({ kind: 'loading' })
    fetchLastCommit(paneId, root).then(
      (res) =>
        live &&
        setState(
          res.commit
            ? { kind: 'commit', commit: res.commit }
            : { kind: 'none' },
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
  }, [paneId, root, reload, onRootChanged])

  const commit = state.kind === 'commit' ? state.commit : undefined
  if (commit && file)
    return (
      <CommitFileDiff
        paneId={paneId}
        root={root}
        hash={commit.hash}
        file={file}
        isMobile={isMobile}
        canReveal={canReveal}
        onBack={() => setFile(undefined)}
        onHeadMoved={headMoved}
        onRootChanged={onRootChanged}
      />
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        title="Last commit"
        detail={commit?.hash.slice(0, 7)}
        backLabel="Back to changes"
        onBack={onBack}
      />
      {state.kind === 'loading' && <ViewMessage>Loading…</ViewMessage>}
      {state.kind === 'error' && <ViewMessage>{state.text}</ViewMessage>}
      {state.kind === 'none' && <ViewMessage>No commits yet</ViewMessage>}
      {commit && (
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <CommitMeta commit={commit} />
          {commit.truncated && (
            <Banner>Only the first 5000 files are shown</Banner>
          )}
          <section aria-label="Files">
            <h3 className="px-3 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted ui-terminal:font-label">
              Files{' '}
              <span className="text-fg-subtle">{commit.files.length}</span>
            </h3>
            {commit.files.length === 0 ? (
              <p className="m-0 px-3 py-2 text-[12px] text-fg-subtle">
                No files changed
              </p>
            ) : (
              <ul>
                {commit.files.map((f) => (
                  <li key={`${f.orig ?? ''}\u0000${f.path}`}>
                    <ChangeRowButton
                      code={f.status}
                      path={f.path}
                      orig={f.orig}
                      sensitive={f.sensitive}
                      onOpen={() => setFile(f)}
                      className="w-full hover:bg-surface"
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function Header({
  title,
  detail,
  backLabel,
  onBack,
  children,
}: {
  title: string
  detail?: string
  backLabel: string
  onBack: () => void
  children?: ReactNode
}) {
  return (
    <div className="sticky top-0 z-10 flex shrink-0 items-center gap-1 border-b border-border bg-surface px-1 py-1 ui-terminal:bg-bg">
      <IconButton
        size="sm"
        onClick={onBack}
        aria-label={backLabel}
        title={backLabel}
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </IconButton>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={`${TRUNCATE_START} font-term text-[12px]`}>
          {title}
        </span>
        {detail && (
          <span className="font-term text-[11px] text-fg-muted">{detail}</span>
        )}
      </div>
      {children}
    </div>
  )
}

// The message (subject, then body), author and date of a commit
function CommitMeta({ commit }: { commit: CommitInfo }) {
  const message = visibleUnsafe(commit.message, true)
  const cut = message.indexOf('\n')
  const subject = cut < 0 ? message : message.slice(0, cut)
  const body = cut < 0 ? '' : message.slice(cut + 1).trim()
  const date = new Date(commit.time * 1000)
  return (
    <div className="border-b border-border px-3 py-3">
      <p className="m-0 whitespace-pre-wrap break-words text-[13px] font-medium text-fg">
        {subject || '(no message)'}
      </p>
      {body && (
        <p className="m-0 mt-1.5 whitespace-pre-wrap break-words text-[12px] text-fg-muted">
          {body}
        </p>
      )}
      <p className="m-0 mt-2 flex flex-wrap gap-x-1.5 text-[11px] text-fg-subtle">
        <span className="font-term" title={commit.hash}>
          {commit.hash.slice(0, 7)}
        </span>
        <span aria-hidden="true">·</span>
        <span>{visibleUnsafe(commit.author)}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
      </p>
      {commit.parents.length > 1 && (
        <p className="m-0 mt-1 text-[11px] text-fg-subtle">
          Merge: changes against the first parent
        </p>
      )}
    </div>
  )
}

// One file's diff in the commit
function CommitFileDiff({
  paneId,
  root,
  hash,
  file,
  isMobile,
  canReveal,
  onBack,
  onHeadMoved,
  onRootChanged,
}: {
  paneId: string
  root?: string
  hash: string
  file: CommitFile
  isMobile: boolean
  canReveal: boolean
  onBack: () => void
  onHeadMoved: () => void
  onRootChanged: (root: string) => void
}) {
  const [state, setState] = useState<FileLoaded>({ kind: 'loading' })
  const [reveal, setReveal] = useState(false)
  const [wrap, setWrap] = useState(isMobile)

  useEffect(() => {
    let live = true
    setState({ kind: 'loading' })
    fetchCommitDiff(paneId, hash, file, { root, reveal }).then(
      (d) =>
        live &&
        setState(
          d.sensitive ? { kind: 'sensitive' } : { kind: 'diff', diff: d },
        ),
      (err) => {
        if (!live) return
        if (err instanceof RequestError && err.status === 409) {
          if (err.root) onRootChanged(err.root)
          else onHeadMoved()
          return
        }
        setState({ kind: 'error', text: ERRORS[filesError(err)] })
      },
    )
    return () => {
      live = false
    }
  }, [paneId, root, hash, file, reveal, onHeadMoved, onRootChanged])

  const label = 'Wrap lines'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        title={keepOrder(file.orig ? `${file.orig} → ${file.path}` : file.path)}
        detail={`${STATUS[file.status] ?? file.status} · ${hash.slice(0, 7)}`}
        backLabel="Back to the commit"
        onBack={onBack}
      >
        {state.kind === 'diff' && (
          <IconButton
            size="sm"
            onClick={() => setWrap((w) => !w)}
            aria-label={label}
            aria-pressed={wrap}
            title={label}
          >
            <WrapText size={15} aria-hidden="true" />
          </IconButton>
        )}
      </Header>
      {state.kind === 'loading' && <ViewMessage>Loading…</ViewMessage>}
      {state.kind === 'error' && <ViewMessage>{state.text}</ViewMessage>}
      {state.kind === 'sensitive' && (
        <ViewMessage>
          <Lock size={20} aria-hidden="true" />
          This file may contain secrets
          {!canReveal && <span>A view-only device cannot show it</span>}
        </ViewMessage>
      )}
      {state.kind === 'diff' && (
        <DiffBody diff={state.diff} wrap={wrap} oneColumn={isMobile} />
      )}
      <SensitiveConfirm
        isOpen={canReveal && state.kind === 'sensitive'}
        onConfirm={() => setReveal(true)}
        onCancel={onBack}
      />
    </div>
  )
}
