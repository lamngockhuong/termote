import { File, Lock, Search } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { type FilesError, filesError } from '../hooks/use-files'
import {
  type FindResponse,
  findFiles,
  RequestError,
} from '../hooks/use-mux-api'
import { useSettings } from '../hooks/use-settings'
import { splitPath } from '../utils/files-format'
import { FOCUS_RING } from './ui/button'
import { Switch } from './ui/switch'

// Typing waits this long before a search is sent
export const FIND_DEBOUNCE_MS = 150

const ERRORS: Record<FilesError, string> = {
  unsupported: 'Not supported by this backend',
  'not-found': 'Directory not found',
  'not-allowed': "This directory can't be searched",
  'view-only': 'View only: files show in a git repository only',
  unavailable: 'Could not search the files',
}

type Found =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; res: FindResponse }
  | { status: 'error'; error: FilesError }

interface Props {
  paneId: string
  root?: string
  isRepo: boolean
  // The query, kept by the caller: Back from a file opened here returns to
  // the same results
  query: string
  onQuery: (q: string) => void
  // Bumped when the user refreshes: the next search reads the files again
  refreshTick: number
  onPick: (path: string) => void
  onRootChanged: (root: string) => void
  // Shown without a query: the tree
  children: ReactNode
}

// Finds a file by name anywhere under the pane's root (GET files/find): a
// box at the top of the Files view, so a phone's keyboard never covers it,
// and the matches in place of the tree while it holds a query.
export function FileSearch({
  paneId,
  root,
  isRepo,
  query,
  onQuery,
  refreshTick,
  onPick,
  onRootChanged,
  children,
}: Props) {
  const { settings, updateSetting } = useSettings()
  const ignored = isRepo && settings.findIncludeIgnored
  const excludes = settings.findExcludes
  const [found, setFound] = useState<Found>({ status: 'idle' })
  const input = useRef<HTMLInputElement>(null)
  const rows = useRef<(HTMLButtonElement | null)[]>([])
  const switchLabel = useId()
  // The refresh the last search sent was asked after
  const sentTick = useRef(refreshTick)
  const q = query.trim()

  useEffect(() => {
    if (!q) {
      setFound({ status: 'idle' })
      return
    }
    const abort = new AbortController()
    const timer = setTimeout(async () => {
      const fresh = refreshTick !== sentTick.current
      sentTick.current = refreshTick
      setFound({ status: 'loading' })
      try {
        const res = await findFiles(
          paneId,
          { q, root, ignored, exclude: excludes, fresh },
          abort.signal,
        )
        setFound({ status: 'done', res })
      } catch (err) {
        // A newer search replaced this one
        if (abort.signal.aborted) return
        if (err instanceof RequestError && err.status === 409 && err.root) {
          onRootChanged(err.root)
          return
        }
        setFound({ status: 'error', error: filesError(err) })
      }
    }, FIND_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [paneId, q, root, ignored, excludes, refreshTick, onRootChanged])

  const focusRow = (i: number) => rows.current[i]?.focus()

  const onInputKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && query) {
      e.preventDefault()
      onQuery('')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusRow(0)
    }
  }

  const onRowKey = (e: KeyboardEvent, i: number) => {
    if (e.key === 'ArrowDown') focusRow(i + 1)
    else if (e.key === 'ArrowUp') {
      if (i === 0) input.current?.focus()
      else focusRow(i - 1)
    } else if (e.key === 'Escape') {
      onQuery('')
      input.current?.focus()
    } else return
    e.preventDefault()
  }

  let body: ReactNode = children
  if (q) {
    if (found.status === 'error') {
      body = <Note>{ERRORS[found.error]}</Note>
    } else if (found.status !== 'done') {
      body = <Note>Searching…</Note>
    } else if (found.res.results.length === 0) {
      body = (
        <Note>
          {found.res.incomplete
            ? 'No files match. The search stopped early in a large tree.'
            : 'No files match'}
        </Note>
      )
    } else {
      const { results, truncated, incomplete } = found.res
      rows.current.length = results.length
      body = (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <ul aria-label="Matching files">
            {results.map((r, i) => {
              const [dir, name] = splitPath(r.path)
              return (
                <li key={r.path}>
                  <button
                    ref={(el) => {
                      rows.current[i] = el
                    }}
                    type="button"
                    onClick={() => onPick(r.path)}
                    onKeyDown={(e) => onRowKey(e, i)}
                    className={`flex min-h-11 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-surface ${FOCUS_RING} focus-visible:-outline-offset-2 ${r.ignored ? 'opacity-60' : ''}`}
                  >
                    <File
                      size={15}
                      aria-hidden="true"
                      className="shrink-0 text-fg-muted"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium text-fg">
                        {name}
                      </span>
                      {dir && (
                        <span className="truncate text-[12px] text-fg-subtle">
                          {dir}
                        </span>
                      )}
                    </span>
                    {r.ignored && (
                      <span className="shrink-0 rounded-control border border-border px-1.5 text-[11px] text-fg-muted">
                        ignored
                      </span>
                    )}
                    {r.sensitive && (
                      <span
                        className="flex shrink-0 items-center text-warning"
                        title="May contain secrets"
                      >
                        <Lock size={12} aria-hidden="true" />
                        <span className="sr-only">Sensitive</span>
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
          {truncated && (
            <Note>More than 200 matches — type more to narrow</Note>
          )}
          {incomplete && <Note>Search stopped early in a large tree</Note>}
        </div>
      )
    }
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-subtle"
          />
          <input
            ref={input}
            type="search"
            aria-label="Find a file"
            placeholder="Find a file…"
            value={query}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            enterKeyHint="search"
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onInputKey}
            // 16px on a phone: iOS zooms the page into a smaller field
            className="h-8 w-full min-w-0 rounded-control border border-border bg-bg pr-2 pl-7 text-base text-fg outline-none placeholder:text-fg-subtle focus:border-accent md:text-[13px] pointer-coarse:h-touch"
          />
        </div>
        {isRepo && (
          <div className="flex shrink-0 items-center gap-2">
            <span id={switchLabel} className="text-[12px] text-fg-muted">
              Include ignored
            </span>
            <Switch
              labelledBy={switchLabel}
              checked={settings.findIncludeIgnored}
              onChange={(v) => updateSetting('findIncludeIgnored', v)}
            />
          </div>
        )}
      </div>
      {body}
    </>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="m-0 px-3 py-2 text-[12px] text-fg-subtle">
      {children}
    </p>
  )
}
