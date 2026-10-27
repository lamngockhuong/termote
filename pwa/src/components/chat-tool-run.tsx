import { ChevronRight } from 'lucide-react'
import type { ReactElement } from 'react'
import { EDIT_TOOLS } from '../hooks/use-agent-transcript'
import type { TranscriptEntry, TranscriptPart } from '../hooks/use-mux-api'
import { ChatMessage, chatSide, Step, Time } from './chat-message'

// The agent's steps one after another (tool calls, thinking) fold into one
// line saying what they were, so a turn of twenty commands does not push its
// answer off screen. A tap opens them. A run still going at the end of the
// list stays open on its newest steps, and stays so once done: folding it
// then would pull the card out from under the eye.
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

type StepKind = 'command' | 'edit' | 'read' | 'search' | 'other'

function stepKind(p: TranscriptPart): StepKind {
  const tool = p.tool ?? ''
  if (p.detail?.command || tool === 'Bash') return 'command'
  if (EDIT_TOOLS.has(tool)) return 'edit'
  if (tool === 'Read' || tool === 'ViewImage') return 'read'
  if (/grep|glob|search|fetch/i.test(tool)) return 'search'
  return 'other'
}

const NOUNS: [StepKind, string, string][] = [
  ['command', 'command', 'commands'],
  ['edit', 'edit', 'edits'],
  ['read', 'read', 'reads'],
  ['search', 'search', 'searches'],
  ['other', 'other step', 'other steps'],
]

// "3 commands, 2 reads"
export function runSummary(tools: TranscriptPart[]) {
  return NOUNS.map(([kind, one, many]) => {
    const n = tools.filter((p) => stepKind(p) === kind).length
    return n ? `${n} ${n === 1 ? one : many}` : ''
  })
    .filter(Boolean)
    .join(', ')
}

// The newest step in a few words: what the model said it does, else the
// command or the tool and what it acted on
export function stepLine(p: TranscriptPart) {
  if (p.detail?.description) return p.detail.description
  if (p.detail?.command) return `$ ${p.detail.command.split('\n')[0]}`
  return [p.orphan ? 'Result' : p.tool, p.input].filter(Boolean).join(' ')
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

export type RunMode = 'open' | 'closed'

// What the list keeps for its runs, by entry id: the reader's choice, the
// runs that were live on screen, and where a live run's tail starts. follow:
// the list is at its bottom; read above it, the tail stays where it was,
// or each new step would move the lines being read.
export interface RunState {
  modes: Record<string, RunMode>
  held: Set<string>
  tails: Map<string, string>
  follow: boolean
  setMode: (ids: string[], mode: RunMode) => void
}

const HEADER =
  'flex w-full min-w-0 items-center gap-1.5 text-left text-[12px] text-fg-muted hover:text-fg pointer-coarse:min-h-touch'

// The rows of a run: its header, then the entries it shows. live: the
// agent is in this run now.
export function toolRunRows(
  entries: TranscriptEntry[],
  layout: Layout[],
  live: boolean,
  state: RunState,
): ReactElement[] {
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
  const summary = runSummary(tools)
  const dot = runDot(tools)
  const setMode = (mode: RunMode) => state.setMode(ids, mode)
  const tail = !chosen && ids.some((id) => state.held.has(id))
  if (chosen === 'open' || tail) {
    let start = 0
    if (tail) {
      const kept = state.follow
        ? -1
        : ids.indexOf(state.tails.get(ids[0]) ?? '')
      start = kept >= 0 ? kept : Math.max(0, entries.length - LIVE_TAIL)
      state.tails.set(ids[0], ids[start])
    }
    const earlier = toolsOf(entries.slice(0, start)).length
    const label =
      start === 0
        ? summary
        : earlier
          ? `${earlier} earlier ${earlier === 1 ? 'step' : 'steps'} · ${summary}`
          : `Earlier steps · ${summary}`
    return [
      <div
        key={`run:${ids[0]}`}
        data-run
        data-role="assistant"
        className="flex flex-col gap-3"
      >
        {layout[start].showTime && <Time ts={entries[start].ts} />}
        <Step dot={dot} line>
          <button
            type="button"
            aria-expanded={start === 0}
            onClick={() => setMode(start === 0 ? 'closed' : 'open')}
            className={HEADER}
          >
            <ChevronRight
              size={14}
              aria-hidden="true"
              className={`shrink-0 transition-transform ${start === 0 ? 'rotate-90' : ''}`}
            />
            <span className="min-w-0 truncate tabular-nums">{label}</span>
          </button>
        </Step>
      </div>,
      ...entries
        .slice(start)
        .map((e, i) => (
          <ChatMessage
            key={e.id}
            entry={e}
            showTime={i > 0 && layout[start + i].showTime}
            joinsNext={layout[start + i].joinsNext}
          />
        )),
    ]
  }
  const failed = tools.filter((p) => p.isError).length
  const last = tools[tools.length - 1]
  return [
    <div
      key={`run:${ids[0]}`}
      data-run
      data-role="assistant"
      className="flex flex-col gap-3"
    >
      {layout[0].showTime && <Time ts={entries[0].ts} />}
      <Step dot={dot} line={layout[layout.length - 1].joinsNext}>
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setMode('open')}
          className="flex w-full min-w-0 flex-col gap-0.5 rounded-control border border-border bg-surface px-2 py-1.5 text-left text-[12px] text-fg-muted hover:text-fg pointer-coarse:min-h-touch"
        >
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            <ChevronRight size={14} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 truncate tabular-nums">{summary}</span>
            {failed > 0 && (
              <span className="shrink-0 text-danger">{failed} failed</span>
            )}
          </span>
          <span
            className={`min-w-0 truncate pl-5 ${last.detail?.description ? '' : 'font-mono text-[11px]'}`}
          >
            {stepLine(last)}
          </span>
        </button>
      </Step>
    </div>,
  ]
}
