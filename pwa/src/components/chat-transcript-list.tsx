import { type RefObject, useMemo } from 'react'
import type { TranscriptEntry } from '../hooks/use-mux-api'
import { ENTER_FROM } from '../hooks/use-new-keys'
import { useT } from '../i18n/i18n-context'
import { ChatMessage, chatSide } from './chat-message'
import {
  chatItems,
  hasPending,
  type RunState,
  toolRunRows,
} from './chat-tool-run'

// An entry this long after the one before shows its time again.
const TIME_GAP_MS = 5 * 60_000

// Where each entry sits among its neighbours: the time over the first entry
// of each side's run (and after a long pause), and the agent's timeline
// line carried on to its next entry.
export function chatLayout(entries: TranscriptEntry[]) {
  return entries.map((e, i) => {
    const side = chatSide(e)
    const prev = entries[i - 1]
    const next = entries[i + 1]
    const gap =
      prev?.ts && e.ts ? Date.parse(e.ts) - Date.parse(prev.ts) : Number.NaN
    return {
      showTime:
        side !== 'other' &&
        (!prev || chatSide(prev) !== side || gap > TIME_GAP_MS),
      joinsNext: side === 'agent' && !!next && chatSide(next) === 'agent',
    }
  })
}

// What the messages of a list read from it: the element they scroll in (a
// diagram draws once near it) and the toast. Stable, so the memoized
// messages do not draw again.
export function useChatMarkdown(
  listRef: RefObject<HTMLElement | null>,
  notify: (message: string) => void,
) {
  return useMemo(
    () => ({ scrollRoot: () => listRef.current, notify }),
    [listRef, notify],
  )
}

// How a message that just came in enters
const ENTER_MESSAGE = `transition-[opacity,translate] duration-(--duration-base) ease-standard ${ENTER_FROM}`

interface Props {
  entries: TranscriptEntry[]
  // Entries at the start not drawn (shown on scrolling up)
  hidden: number
  runs: RunState
  // The agent is working: its last run is open on its newest steps
  working: boolean
  // The agent waits on the reader (a permission, a question): its live run
  // says so, and its time stops
  waiting?: boolean
  // The agent is done: a call left without a result keeps nothing open, and
  // the runs seen live fold
  settled: boolean
  // An entry that came in after the conversation showed fades in
  enters?: (id: string, index: number) => boolean
}

// The messages and tool runs of a conversation, as the Chat view draws them
// and the history shows an old one. Runs are found over every entry held, so
// the one at the top keeps its place as earlier entries are shown.
export function ChatTranscriptList({
  entries,
  hidden,
  runs,
  working,
  waiting = false,
  settled,
  enters,
}: Props) {
  const { t } = useT()
  const layout = chatLayout(entries.slice(hidden))
  const items = chatItems(entries)
  return items.flatMap((item, k) => {
    if (item.kind === 'entry') {
      if (item.index < hidden) return []
      const e = entries[item.index]
      const l = layout[item.index - hidden]
      return [
        <ChatMessage
          key={e.id}
          entry={e}
          showTime={l.showTime}
          joinsNext={l.joinsNext}
          className={enters?.(e.id, item.index) ? ENTER_MESSAGE : undefined}
        />,
      ]
    }
    if (item.end <= hidden) return []
    const start = Math.max(item.start, hidden)
    const run = entries.slice(start, item.end)
    const next = entries[item.end]
    // The run the agent is in: open on its newest steps
    const live =
      k === items.length - 1 && (working || (!settled && hasPending(run)))
    return toolRunRows(
      run,
      layout.slice(start - hidden, item.end - hidden),
      live,
      runs,
      t,
      {
        key: entries[item.start].id,
        ids: entries.slice(item.start, item.end).map((e) => e.id),
        start: entries[item.start].ts,
        // The agent's next entry ends the run; the reader's own, maybe
        // hours later, says nothing of how long it worked
        end: next && chatSide(next) === 'agent' ? next.ts : undefined,
        settled,
        waiting,
      },
    )
  })
}
