import { Hourglass, Sparkle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAgentActivity } from '../hooks/use-agent-prompt'
import type { AgentActivity } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { AgentStatus } from '../types/session'
import { visibleUnsafe } from '../utils/unsafe-chars'

// The row under the conversation while the agent works: its working line as
// the terminal shows it (word, phase, time, tokens), so the wait for the next
// transcript write is not a silent one. Without a line read (an older server,
// a line of another shape) it still says the agent works and for how long.

// "5s", "1m 14s", "1h 2m": the terminal's own way, the same in every language
export function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// The row of paneId's agent while it works: read off its own subscription,
// so a new count each second renders this row only, not the conversation.
// A pane without a screen reader (no input) gets the row without a line.
export function ChatActivity({
  paneId,
  status,
  agent,
}: {
  paneId: string | undefined
  status: AgentStatus
  agent: string
}) {
  const { activity, dialog } = useAgentActivity(paneId, status)
  if (dialog) return null
  // A turn's end line read before the status caught up is no working line
  return (
    <ChatActivityRow
      activity={activity?.background ? null : activity}
      agent={agent}
    />
  )
}

// The row once the turn is done while what it started still runs (shells,
// monitors): the terminal says so on the line that ends the turn, and the
// agent goes on by itself when they finish.
export function ChatBackground({
  paneId,
  status,
}: {
  paneId: string
  status: AgentStatus | undefined
}) {
  const { activity, dialog } = useAgentActivity(paneId, status)
  if (dialog || !activity?.background) return null
  return <ChatBackgroundRow what={activity.background} />
}

export function ChatBackgroundRow({ what }: { what: string }) {
  const { t } = useT()
  return (
    <div className="flex items-center gap-2 text-[13px] text-fg-muted">
      <Hourglass size={14} aria-hidden="true" className="shrink-0" />
      <span role="status" className="min-w-0 flex-1 truncate">
        {t('chat.activity.background', { what: visibleUnsafe(what) })}
      </span>
    </div>
  )
}

interface Props {
  activity: AgentActivity | null
  // The agent's name, for the row without a line read
  agent: string
}

export function ChatActivityRow({ activity, agent }: Props) {
  const { t } = useT()
  const [now, setNow] = useState(() => Date.now())
  // The last elapsed count the line reported and when it came; the time
  // shown runs on from it each second between two reads.
  const anchor = useRef<{ elapsed: number; at: number; reported?: number }>(
    null,
  )
  const reported = activity?.elapsed
  if (
    !anchor.current ||
    (reported !== undefined && reported !== anchor.current.reported)
  ) {
    anchor.current = { elapsed: reported ?? 0, at: Date.now(), reported }
  }
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const elapsed =
    anchor.current.elapsed +
    Math.max(0, Math.floor((now - anchor.current.at) / 1000))

  const what = activity
    ? `${visibleUnsafe(activity.label)}…`
    : t('chat.activity.working', { agent })
  const phase =
    activity?.phase === 'thinking'
      ? t('chat.activity.thinking')
      : activity?.detail && visibleUnsafe(activity.detail)
  const parts = [
    phase,
    formatElapsed(elapsed),
    activity?.tokens &&
      t('chat.activity.tokens', { tokens: visibleUnsafe(activity.tokens) }),
  ].filter((p): p is string => !!p)
  return (
    // relative: the text read out is absolute, and kept inside this row; its
    // box otherwise belongs to the view outside the scrolling list, which
    // iOS Safari grows by a screen of empty space below the row
    <div className="relative flex items-center gap-2 text-[13px] text-fg-muted">
      <Sparkle
        size={14}
        aria-hidden="true"
        className="shrink-0 text-warning motion-safe:animate-pulse"
      />
      {/* Read out when the phase changes, not every second */}
      <span role="status" className="sr-only">
        {[what, phase].filter(Boolean).join(' ')}
      </span>
      <span aria-hidden="true" className="min-w-0 flex-1 truncate">
        <span className="font-medium text-fg">{what}</span>
        {parts.map((p, i) => (
          // The parts keep their order: phase, time, tokens
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed positions
          <span key={i}> · {p}</span>
        ))}
      </span>
    </div>
  )
}
