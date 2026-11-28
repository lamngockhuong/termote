import { ChevronRight } from 'lucide-react'
import type { ReactElement, SyntheticEvent } from 'react'
import type { TranscriptEntry, TranscriptPart } from '../hooks/use-mux-api'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { formatElapsed } from './chat-activity-row'
import { ChatMessage, chatSide, Step, Time } from './chat-message'
import { useServerSeconds } from './chat-subagents'
import { type StepKind, stepKind } from './chat-tool-card'

// The agent's steps one after another (tool calls, thinking) fold into one
// line saying what they were, so a turn of twenty commands does not push its
// answer off screen. A tap opens them, each step a line of its own that a
// tap opens in turn. A run still going at the end of the list stays open on
// its newest steps. Once the agent is done it folds, but only while the
// reader follows the bottom: read above, folding would pull the lines out
// from under the eye, so it waits until the reader is back. A run the reader
// pressed or focused inside stays open.
//
// A run is drawn as rows of the list beside its entries, never around them:
// an entry keeps its element (and what the reader opened in it) when the
// steps around it become a run, and the list keeps each entry as a place to
// hold the reading position by. What the reader chose for a run is kept by
// the list per entry, so it holds when the run grows at either end.

// Steps a run needs before it folds: two read as two things that happened,
// and folding them buys a line and costs a tap.
export const MIN_RUN = 3
// Entries an open live run shows; the rest wait behind one tap.
export const LIVE_TAIL = 6

export type ChatItem =
  | { kind: 'entry'; index: number }
  // Entries [start, end) of the list
  | { kind: 'run'; start: number; end: number }

// An entry holding only steps: a tool call or thinking, on the agent's side
function isSteps(entry: TranscriptEntry) {
  return (
    chatSide(entry) === 'agent' &&
    entry.parts.length > 0 &&
    entry.parts.every((p) => p.kind === 'tool' || p.kind === 'thinking')
  )
}

function stepCount(entries: TranscriptEntry[]) {
  return entries.reduce((n, e) => n + e.parts.length, 0)
}

function toolsOf(entries: TranscriptEntry[]) {
  return entries.flatMap((e) => e.parts.filter((p) => p.kind === 'tool'))
}

// The list as single entries and runs of steps
export function chatItems(entries: TranscriptEntry[]): ChatItem[] {
  const out: ChatItem[] = []
  let start = 0
  const flush = (end: number) => {
    const run = entries.slice(start, end)
    if (stepCount(run) >= MIN_RUN && toolsOf(run).length > 0) {
      out.push({ kind: 'run', start, end })
    } else {
      for (let i = start; i < end; i++) out.push({ kind: 'entry', index: i })
    }
  }
  entries.forEach((e, i) => {
    if (isSteps(e)) return
    flush(i)
    out.push({ kind: 'entry', index: i })
    start = i + 1
  })
  flush(entries.length)
  return out
}

const NOUNS: [StepKind, MessageKey][] = [
  ['command', 'chat.run.command'],
  ['edit', 'chat.run.edit'],
  ['read', 'chat.run.read'],
  ['search', 'chat.run.search'],
  ['other', 'chat.run.other'],
]

// "3 commands, 2 reads"
export function runSummary(tools: TranscriptPart[], t: Translate<MessageKey>) {
  return NOUNS.map(([kind, key]) => {
    const n = tools.filter((p) => stepKind(p) === kind).length
    return n ? t(key, { count: n }) : ''
  })
    .filter(Boolean)
    .join(', ')
}

// Seconds from start to end, both entry times; undefined when either is
// missing or they do not make a span
export function runSeconds(start?: string, end?: string) {
  if (!start || !end) return undefined
  const ms = Date.parse(end) - Date.parse(start)
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : undefined
}

// A call without its result yet
function pending(p: TranscriptPart) {
  return p.kind === 'tool' && !p.result && !p.orphan
}

export function hasPending(entries: TranscriptEntry[]) {
  return entries.some((e) => e.parts.some(pending))
}

function runDot(tools: TranscriptPart[]) {
  if (tools.some((p) => p.isError)) return 'bg-danger'
  if (tools.some(pending)) {
    return 'border border-fg-subtle bg-transparent'
  }
  return 'bg-success'
}

type Layout = { showTime: boolean; joinsNext: boolean }

// kept: the reader pressed or focused inside the run, which then never
// folds by itself
export type RunMode = 'open' | 'closed' | 'kept'

// What the list keeps for its runs, by entry id: the reader's choice, the
// runs that were live on screen, and where a live run's tail starts. follow:
// the list is at its bottom; read above it, the tail stays where it was,
// or each new step would move the lines being read. clockOffset: the
// server's clock less this device's (ms), for the time a live run counts.
export interface RunState {
  modes: Record<string, RunMode>
  held: Set<string>
  tails: Map<string, string>
  follow: boolean
  clockOffset?: number
  setMode: (ids: string[], mode: RunMode) => void
  // The reader pressed or focused inside the entry id of a run
  keep: (id: string) => void
}

// The modes with the run of entry id kept, unless the reader chose already
export function keepRun(modes: Record<string, RunMode>, id: string) {
  return modes[id] ? modes : { ...modes, [id]: 'kept' as const }
}

// The run an event inside the list happened in, kept open: for the list's
// focus and click capture. A click, not a pointer down: a finger that
// scrolls the list starts with one too, and reading is no choice to keep.
export function keepRunAt(e: SyntheticEvent, runs: RunState) {
  const at = (e.target as Element).closest?.('[data-run-entry]')
  const id = at?.getAttribute('data-run-entry')
  if (id) runs.keep(id)
}

// Where a run sits in its conversation. key: the id of the run's first
// entry in the whole list, which holds while the list's window cuts the
// run's top. ids: the ids of the whole run, the window's cut included.
// start: the time of that entry; end: the time of the agent's entry after
// the run, when there is one. settled: the agent says the turn is done.
export interface RunAt {
  key?: string
  ids?: string[]
  start?: string
  end?: string
  settled?: boolean
}

const HEADER =
  'flex w-full min-w-0 items-center gap-1.5 text-left text-[12px] text-fg-muted hover:text-fg pointer-coarse:min-h-touch'

// The line over a run: "Working… · 15s · 3 commands · 1 failed" while it
// runs, a second at a time, then "Worked for 15s · …". The count of failed
// steps is a span of its own the summary's cut never reaches. The button
// is named by the whole line, so a screen reader says the parts as words.
function RunHeader({
  open,
  live,
  start,
  end,
  clockOffset,
  label,
  failed,
  onClick,
  t,
}: {
  open: boolean
  live: boolean
  start?: string
  end?: string
  clockOffset: number
  label: string
  failed: number
  onClick: () => void
  t: Translate<MessageKey>
}) {
  const now = useServerSeconds(live, clockOffset)
  const seconds = live
    ? runSeconds(start, new Date(now).toISOString())
    : runSeconds(start, end)
  const title = live
    ? t('chat.run.working')
    : seconds === undefined
      ? t('chat.run.worked')
      : t('chat.run.workedFor', { duration: formatElapsed(seconds) })
  const elapsed = live && seconds !== undefined && formatElapsed(seconds)
  const failures = failed > 0 && t('chat.run.failed', { count: failed })
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={[title, elapsed, label, failures].filter(Boolean).join(' · ')}
      onClick={onClick}
      className={HEADER}
    >
      <ChevronRight
        size={14}
        aria-hidden="true"
        className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
      />
      <span className="shrink-0 font-medium">{title}</span>
      {elapsed && <span className="shrink-0 tabular-nums">· {elapsed}</span>}
      <span className="min-w-0 truncate tabular-nums">· {label}</span>
      {failures && <span className="shrink-0 text-danger">· {failures}</span>}
    </button>
  )
}

// The rows of a run: its header, then the entries it shows, each step a
// line. live: the agent is in this run now.
export function toolRunRows(
  entries: TranscriptEntry[],
  layout: Layout[],
  live: boolean,
  state: RunState,
  t: Translate<MessageKey>,
  at: RunAt = {},
): ReactElement[] {
  const runKey = at.key ?? entries[0].id
  const tools = toolsOf(entries)
  // Cut by the list's window down to thinking only: no run left to say
  if (!tools.length) {
    return entries.map((e, i) => (
      <ChatMessage
        key={e.id}
        entry={e}
        showTime={layout[i].showTime}
        joinsNext={layout[i].joinsNext}
      />
    ))
  }
  const ids = entries.map((e) => e.id)
  if (live) for (const id of ids) state.held.add(id)
  const chosen = ids.map((id) => state.modes[id]).find(Boolean)
  // The turn done, and the reader at the bottom: the run folds, and stays
  // so (the part the window cuts too, or it would open again shown)
  if (
    !live &&
    at.settled &&
    !chosen &&
    state.follow &&
    ids.some((id) => state.held.has(id))
  ) {
    for (const id of at.ids ?? ids) state.held.delete(id)
    state.tails.delete(runKey)
  }
  const failed = tools.filter((p) => p.isError).length
  const summary = runSummary(tools, t)
  const dot = runDot(tools)
  const setMode = (mode: RunMode) => state.setMode(ids, mode)
  const tail =
    (!chosen || chosen === 'kept') && ids.some((id) => state.held.has(id))
  const open = chosen === 'open' || tail
  let start = 0
  if (tail) {
    const kept = state.tails.get(runKey)
    // Read above the bottom, the tail starts where it did; once the window
    // has moved past that entry, at the top of what is left
    start =
      state.follow || kept === undefined
        ? Math.max(0, entries.length - LIVE_TAIL)
        : Math.max(0, ids.indexOf(kept))
    state.tails.set(runKey, ids[start])
  }
  const earlier = toolsOf(entries.slice(0, start)).length
  const label =
    start === 0
      ? summary
      : earlier
        ? t('chat.run.earlier', { count: earlier, summary })
        : t('chat.run.earlierSteps', { summary })
  const header = (
    <div
      key={`run:${runKey}`}
      data-run
      data-role="assistant"
      className="flex flex-col gap-3"
    >
      {layout[start].showTime && <Time ts={entries[start].ts} />}
      <Step dot={dot} line={open || layout[layout.length - 1].joinsNext}>
        <RunHeader
          open={open && start === 0}
          live={live}
          start={at.start ?? entries[0].ts}
          end={at.end}
          clockOffset={state.clockOffset ?? 0}
          label={label}
          failed={failed}
          onClick={() =>
            setMode(!open ? 'open' : start === 0 ? 'closed' : 'open')
          }
          t={t}
        />
      </Step>
    </div>
  )
  if (!open) return [header]
  return [
    header,
    ...entries
      .slice(start)
      .map((e, i) => (
        <ChatMessage
          key={e.id}
          entry={e}
          steps
          showTime={i > 0 && layout[start + i].showTime}
          joinsNext={layout[start + i].joinsNext}
        />
      )),
  ]
}
