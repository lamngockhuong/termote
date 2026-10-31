import {
  CaseSensitive,
  ChevronRight,
  Ellipsis,
  Regex,
  Search,
  WholeWord,
} from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { type FilesError, filesError } from '../hooks/use-files'
import {
  RequestError,
  type SearchMatch,
  type SearchResponse,
  searchFiles,
} from '../hooks/use-mux-api'
import { useSettings } from '../hooks/use-settings'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { splitPath } from '../utils/files-format'
import { FIND_ERRORS } from './file-search'
import { FOCUS_RING } from './ui/button'

// Typing waits this long before a search is sent
export const SEARCH_DEBOUNCE_MS = 300
// A shorter query is not sent: one character matches nearly every line
export const SEARCH_MIN_CHARS = 2
// Groups past this many files start collapsed
const OPEN_GROUPS = 50

// Refusals of the query itself, told under the box
const QUERY_ERRORS: Record<string, MessageKey> = {
  invalid_regex: 'files.search.invalidRegex',
  empty_match: 'files.search.emptyMatch',
  invalid_glob: 'files.search.invalidGlob',
  invalid_exclude: 'files.search.invalidExclude',
}

// What the Search tab holds, kept by the caller while a result is open:
// Back returns to the same results, scrolled as they were, without a new
// request.
export interface ContentSearchState {
  query: string
  // Comma-separated globs
  files: string
  skip: string
  globsOpen: boolean
  // The last answer and the request it answered (searchKey), with the
  // refresh it was sent after
  result?: { key: string; tick: number; res: SearchResponse }
  // Groups the user opened or closed, against their default
  toggled: Record<string, boolean>
  // The row last focused (index among the result rows), and the scroll
  // offset when the tab was left
  selected: number
  scrollTop: number
  // The last focusTick that focused the box: a remount never takes the
  // focus again
  focusedTick: number
}

export const CONTENT_SEARCH_INITIAL: ContentSearchState = {
  query: '',
  files: '',
  skip: '',
  globsOpen: false,
  toggled: {},
  selected: 0,
  scrollTop: 0,
  focusedTick: 0,
}

// The globs of a comma-separated field
export const splitGlobs = (s: string) =>
  s
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)

// The search options, each a setting kept on the device
type SearchOption = 'searchCase' | 'searchWord' | 'searchRegex'

type Pending =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'busy' }
  | { status: 'query'; message: MessageKey }
  | { status: 'error'; error: FilesError }

interface Props {
  paneId: string
  // The Place the files are under (absent: the pane's folder)
  place?: string
  root?: string
  state: ContentSearchState
  onState: (patch: Partial<ContentSearchState>) => void
  // Bumped when the user refreshes: the next search reads the files again
  refreshTick: number
  // Bumped to focus and select the box (Ctrl/Cmd+Shift+F)
  focusTick: number
  onPick: (path: string, match: SearchMatch) => void
  onRootChanged: (root: string) => void
}

// Searches the contents of the files under the pane's root (GET
// files/search) as the user types, with Match case, Whole word, Regex and
// file globs; the matching lines grouped by file.
export function ContentSearch({
  paneId,
  place,
  root,
  state,
  onState,
  refreshTick,
  focusTick,
  onPick,
  onRootChanged,
}: Props) {
  const { t } = useT()
  const { settings, updateSetting } = useSettings()
  const [pending, setPending] = useState<Pending>({ status: 'none' })
  const [retry, setRetry] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // Where the results are scrolled to: kept here while they show (a scroll
  // renders nothing), handed to the caller when the tab is left
  const scrolled = useRef(state.scrollTop)
  const errorId = useId()
  const globsId = useId()
  const { query, result } = state
  const files = splitGlobs(state.files)
  const skip = splitGlobs(state.skip)
  const opts = {
    matchCase: settings.searchCase,
    wholeWord: settings.searchWord,
    regex: settings.searchRegex,
  }
  const exclude = settings.findExcludes
  const key = JSON.stringify([root, query, opts, files, skip, exclude])
  const short = query.length < SEARCH_MIN_CHARS
  // Answered already, after the same refresh: nothing is sent again
  const answered = result?.key === key && result.tick === refreshTick
  // The latest state and callbacks, read when an answer arrives
  const latest = useRef({ onState, onRootChanged, result, tick: refreshTick })
  latest.current = { onState, onRootChanged, result, tick: refreshTick }
  // The refresh in place when the search opened: one asked after it, before
  // the first search, reads the files again too
  const openedTick = useRef(refreshTick)

  // key holds every input of the request; retry sends it again
  // biome-ignore lint/correctness/useExhaustiveDependencies: key covers the query
  useEffect(() => {
    if (short || answered) {
      setPending({ status: 'none' })
      return
    }
    const abort = new AbortController()
    const timer = setTimeout(async () => {
      const { result: last, tick } = latest.current
      // Read the files again once the user refreshed since the last search
      // (or since the search opened)
      const fresh = (last?.tick ?? openedTick.current) !== tick
      setPending({ status: 'loading' })
      try {
        const res = await searchFiles(
          { paneId, place },
          { q: query, root, ...opts, files, skip, exclude, fresh },
          abort.signal,
        )
        setPending({ status: 'none' })
        scrolled.current = 0
        if (list.current) list.current.scrollTop = 0
        latest.current.onState({
          result: { key, tick, res },
          toggled: {},
          selected: 0,
          scrollTop: 0,
        })
      } catch (err) {
        // A newer search replaced this one
        if (abort.signal.aborted) return
        if (err instanceof RequestError && err.status === 409 && err.root) {
          setPending({ status: 'none' })
          latest.current.onRootChanged(err.root)
        } else if (err instanceof RequestError && err.code === 'busy') {
          setPending({ status: 'busy' })
        } else if (err instanceof RequestError && QUERY_ERRORS[err.code]) {
          setPending({ status: 'query', message: QUERY_ERRORS[err.code] })
        } else {
          setPending({ status: 'error', error: filesError(err) })
        }
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [paneId, place, key, short, answered, retry])

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per ask
  useEffect(() => {
    if (focusTick <= state.focusedTick) return
    input.current?.focus()
    input.current?.select()
    onState({ focusedTick: focusTick })
  }, [focusTick])

  // Back from a file: the results scrolled as they were left
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = state.scrollTop
    return () => latest.current.onState({ scrollTop: scrolled.current })
  }, [])

  const rows = () =>
    Array.from(
      list.current?.querySelectorAll<HTMLElement>('[data-search-row]') ?? [],
    )
  const focusRow = (i: number) => {
    const all = rows()
    const el = all[Math.max(0, Math.min(i, all.length - 1))]
    el?.focus()
  }

  const onInputKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusRow(state.selected)
    } else if (e.key === 'Escape' && query) {
      e.preventDefault()
      onState({ query: '' })
    }
  }

  const onListKey = (e: KeyboardEvent) => {
    const all = rows()
    const at = all.indexOf(e.target as HTMLElement)
    if (at < 0) return
    if (e.key === 'ArrowDown') focusRow(at + 1)
    else if (e.key === 'ArrowUp') {
      if (at === 0) input.current?.focus()
      else focusRow(at - 1)
    } else if (e.key === 'Escape') input.current?.focus()
    else return
    e.preventDefault()
  }

  const toggle = (k: SearchOption) => updateSetting(k, !settings[k])

  // The folder moved since these results: they name files of another one
  const stale = !!result && !!root && result.res.root !== root

  let body: ReactNode
  if (!query) {
    body = null
  } else if (short) {
    body = <Note>{t('files.search.short', { count: SEARCH_MIN_CHARS })}</Note>
  } else if (pending.status === 'error') {
    body = <Note>{t(FIND_ERRORS[pending.error])}</Note>
  } else if (pending.status === 'busy') {
    body = (
      <Note>
        {t('files.search.busy')}{' '}
        <button
          type="button"
          onClick={() => setRetry((n) => n + 1)}
          className={`text-accent underline ${FOCUS_RING}`}
        >
          {t('files.search.retry')}
        </button>
      </Note>
    )
  } else if (!result) {
    body =
      pending.status === 'query' ? null : (
        <Note>{t('files.find.searching')}</Note>
      )
  } else {
    body = (
      <Results
        res={result.res}
        stale={stale}
        toggled={state.toggled}
        selected={state.selected}
        listRef={list}
        onToggle={(path, open) =>
          onState({ toggled: { ...state.toggled, [path]: open } })
        }
        onFocusRow={(el) => {
          const i = rows().indexOf(el)
          if (i >= 0 && i !== state.selected) onState({ selected: i })
        }}
        onScroll={(top) => {
          scrolled.current = top
        }}
        onKeyDown={onListKey}
        onPick={onPick}
        searching={pending.status === 'loading'}
      />
    )
  }

  return (
    <>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-subtle"
            />
            <input
              ref={input}
              type="search"
              aria-label={t('files.search.label')}
              aria-invalid={pending.status === 'query' || undefined}
              aria-describedby={
                pending.status === 'query' ? errorId : undefined
              }
              placeholder={t('files.search.placeholder')}
              value={query}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              enterKeyHint="search"
              onChange={(e) => onState({ query: e.target.value })}
              onKeyDown={onInputKey}
              // 16px on a phone: iOS zooms the page into a smaller field
              className="h-8 w-full min-w-0 rounded-control border border-border bg-bg pr-2 pl-7 text-base text-fg outline-none placeholder:text-fg-subtle focus:border-accent md:text-[13px] pointer-coarse:h-touch"
            />
          </div>
          <Toggle
            label={t('files.search.matchCase')}
            on={settings.searchCase}
            onClick={() => toggle('searchCase')}
          >
            <CaseSensitive size={16} aria-hidden="true" />
          </Toggle>
          <Toggle
            label={t('files.search.wholeWord')}
            on={settings.searchWord}
            onClick={() => toggle('searchWord')}
          >
            <WholeWord size={16} aria-hidden="true" />
          </Toggle>
          <Toggle
            label={t('files.search.regex')}
            on={settings.searchRegex}
            onClick={() => toggle('searchRegex')}
          >
            <Regex size={16} aria-hidden="true" />
          </Toggle>
          <button
            type="button"
            aria-label={t('files.search.globs')}
            title={t('files.search.globs')}
            aria-expanded={state.globsOpen}
            aria-controls={globsId}
            onClick={() => onState({ globsOpen: !state.globsOpen })}
            className={`flex size-8 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-surface hover:text-fg pointer-coarse:size-touch ${FOCUS_RING}`}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        </div>
        {pending.status === 'query' && (
          <p
            id={errorId}
            role="alert"
            className="m-0 px-1 text-[12px] text-danger"
          >
            {t(pending.message)}
          </p>
        )}
        {state.globsOpen && (
          <div id={globsId} className="flex flex-col gap-1">
            <GlobField
              label={t('files.search.include')}
              placeholder={t('files.search.includeExample')}
              value={state.files}
              onChange={(v) => onState({ files: v })}
            />
            <GlobField
              label={t('files.search.exclude')}
              placeholder={t('files.search.excludeExample')}
              value={state.skip}
              onChange={(v) => onState({ skip: v })}
            />
          </div>
        )}
      </div>
      {body}
    </>
  )
}

function Toggle({
  label,
  on,
  onClick,
  children,
}: {
  label: string
  on: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={onClick}
      className={`flex size-8 shrink-0 items-center justify-center rounded-control pointer-coarse:size-touch ${FOCUS_RING} ${
        on
          ? 'bg-accent-soft text-accent'
          : 'text-fg-muted hover:bg-surface hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

function GlobField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <input
      type="text"
      aria-label={label}
      placeholder={`${label} (${placeholder})`}
      value={value}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full min-w-0 rounded-control border border-border bg-bg px-2 text-base text-fg outline-none placeholder:text-fg-subtle focus:border-accent md:text-[13px] pointer-coarse:h-touch"
    />
  )
}

function Results({
  res,
  stale,
  toggled,
  selected,
  listRef,
  searching,
  onToggle,
  onFocusRow,
  onScroll,
  onKeyDown,
  onPick,
}: {
  res: SearchResponse
  stale: boolean
  toggled: Record<string, boolean>
  selected: number
  listRef: RefObject<HTMLDivElement | null>
  searching: boolean
  onToggle: (path: string, open: boolean) => void
  onFocusRow: (el: HTMLElement) => void
  onScroll: (top: number) => void
  onKeyDown: (e: KeyboardEvent) => void
  onPick: (path: string, match: SearchMatch) => void
}) {
  const { t } = useT()
  // Lines sent, and every matching line known (with those past a file's cap)
  const lines = res.files.reduce((n, f) => n + f.matches.length, 0)
  const total = res.files.reduce((n, f) => n + f.matches.length + f.more, 0)
  const notes: string[] = []
  if (res.truncated) notes.push(t('files.search.truncated', { count: lines }))
  if (res.incomplete) notes.push(t('files.search.incomplete'))
  if (res.skipped.sensitive)
    notes.push(
      t('files.search.skippedSensitive', { count: res.skipped.sensitive }),
    )
  if (res.skipped.hidden)
    notes.push(t('files.search.skippedHidden', { count: res.skipped.hidden }))
  // Row index of each focusable row, in order: the tab stop is the selected
  let row = 0
  return (
    <div
      ref={listRef}
      onScroll={(e) => onScroll(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-y-auto pb-1"
    >
      <p
        role="status"
        className="m-0 px-3 pt-2 pb-1 text-[12px] text-fg-subtle"
      >
        {res.files.length === 0
          ? t('files.search.none')
          : t('files.search.summary', {
              lines: t('files.search.lines', { count: total }),
              files: t('files.search.files', { count: res.files.length }),
            })}
        {searching && ` · ${t('files.find.searching')}`}
      </p>
      {stale && <Note>{t('files.search.stale')}</Note>}
      {notes.map((n) => (
        <Note key={n}>{n}</Note>
      ))}
      <ul
        aria-label={t('files.search.results')}
        className={`m-0 list-none p-0 ${stale ? 'opacity-50' : ''}`}
      >
        {res.files.map((file, fi) => {
          const open = toggled[file.path] ?? fi < OPEN_GROUPS
          const [dir, name] = splitPath(file.path)
          const count = file.matches.length + file.more
          const headerRow = row++
          return (
            <li key={file.path}>
              <button
                type="button"
                data-search-row
                tabIndex={headerRow === selected ? 0 : -1}
                aria-expanded={open}
                onClick={() => onToggle(file.path, !open)}
                onFocus={(e) => onFocusRow(e.currentTarget)}
                className={`flex min-h-8 w-full items-center gap-1.5 px-2 text-left text-[13px] hover:bg-surface pointer-coarse:min-h-touch ${FOCUS_RING} focus-visible:-outline-offset-2`}
              >
                <ChevronRight
                  size={14}
                  aria-hidden="true"
                  className={`shrink-0 text-fg-subtle transition-transform duration-(--duration-fast) ${open ? 'rotate-90' : ''}`}
                />
                <span className="truncate font-medium text-fg">{name}</span>
                {dir && (
                  <span className="min-w-0 truncate text-[12px] text-fg-subtle">
                    {dir}
                  </span>
                )}
                <span className="ml-auto shrink-0 rounded-full bg-surface px-1.5 text-[11px] text-fg-muted">
                  {count}
                </span>
              </button>
              {open && (
                <ul aria-label={file.path} className="m-0 list-none p-0">
                  {file.matches.map((m) => {
                    const r = row++
                    return (
                      <li key={m.line}>
                        <button
                          type="button"
                          data-search-row
                          tabIndex={r === selected ? 0 : -1}
                          disabled={stale}
                          onClick={() => onPick(file.path, m)}
                          onFocus={(e) => onFocusRow(e.currentTarget)}
                          className={`flex min-h-7 w-full items-baseline gap-2 py-0.5 pr-2 pl-7 text-left text-[12px] hover:bg-surface disabled:cursor-default pointer-coarse:min-h-touch ${FOCUS_RING} focus-visible:-outline-offset-2`}
                        >
                          <span className="w-8 shrink-0 text-right font-mono text-fg-subtle tabular-nums">
                            {m.line}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono whitespace-pre text-fg">
                            <Marked match={m} />
                          </span>
                        </button>
                      </li>
                    )
                  })}
                  {file.more > 0 && (
                    <li className="py-0.5 pl-17 text-[12px] text-fg-subtle">
                      {t('files.search.more', { count: file.more })}
                    </li>
                  )}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// Where on its line a match starts (UTF-16): the server's col is where the
// text it sent starts, a window around the match
export function matchStart(match: SearchMatch): number {
  return match.col + (match.ranges[0]?.[0] ?? 0)
}

// A line with its matches marked. The ranges index text as a JS string
// (UTF-16 units); a window that starts inside the line shows an ellipsis.
export function Marked({ match }: { match: SearchMatch }) {
  const { text, ranges, col } = match
  const parts: ReactNode[] = []
  let at = 0
  for (const [s, e] of ranges) {
    if (s < at) continue
    if (s > at) parts.push(text.slice(at, s))
    parts.push(
      <mark key={s} className="rounded-[2px] bg-accent/25 text-fg">
        {text.slice(s, e)}
      </mark>,
    )
    at = e
  }
  if (at < text.length) parts.push(text.slice(at))
  return (
    <>
      {col > 0 && '…'}
      {parts}
    </>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="m-0 px-3 py-1 text-[12px] text-fg-subtle">
      {children}
    </p>
  )
}
