import { ArrowDown } from 'lucide-react'
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { ViewProps } from '../app-views'
import { agentLabel, chatInputAgent } from '../chat-agents'
import { useAgentPrompt } from '../hooks/use-agent-prompt'
import { useAgentTranscript } from '../hooks/use-agent-transcript'
import type { TranscriptEntry } from '../hooks/use-mux-api'
import type { StartRecord } from '../hooks/use-start-agent'
import { toAgentStatus } from '../types/session'
import { canStartAgent } from '../utils/agent-start'
import { AgentStatusBadge } from './agent-status-badge'
import { ChatMessage, chatSide } from './chat-message'
import { OpenTerminalButton } from './open-terminal-button'
import { PromptCard } from './prompt-card'
import { StartAgentPanel } from './start-agent-panel'
import { Button } from './ui/button'

// Entries rendered at once; scrolling to the top shows more.
export const RENDER_WINDOW = 150
// Within this many pixels of the bottom, the list follows new entries.
const STICK_DISTANCE = 48
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

export function ChatView(props: ViewProps) {
  if (!props.session.hasAgent) return <NoAgentChat {...props} />
  return <AgentChat {...props} />
}

// A pane with no agent (yet): start one, follow the start, or say there is
// none.
function NoAgentChat({ mux, session, showView, agentStart }: ViewProps) {
  const paneId = session.paneId ?? ''
  const record = agentStart?.starts[paneId]
  if (record?.phase === 'ready') {
    return <StartedNotice record={record} showView={showView} />
  }
  if (
    agentStart &&
    ((record && record.phase !== 'failed') || canStartAgent(mux, session))
  ) {
    return (
      <Centered>
        <StartAgentPanel
          kinds={mux.caps.agentStartCodex ? ['claude', 'codex'] : ['claude']}
          record={record}
          onStart={(kind) => agentStart.start(paneId, kind)}
        />
      </Centered>
    )
  }
  return (
    <Centered>
      <p>No agent runs in this pane.</p>
      <OpenTerminalButton showView={showView} />
    </Centered>
  )
}

// An agent started from this page that has no conversation to show yet.
// Codex writes its rollout only with its first message, which the Chat view
// cannot send without one; Claude Code's session is reported by Herdr a
// moment after it is ready.
function StartedNotice({
  record,
  showView,
}: {
  record: StartRecord
  showView: ViewProps['showView']
}) {
  if (record.kind === 'codex') {
    return (
      <Centered>
        <p>
          Codex is running. Type your first message in the terminal; the Chat
          view follows from the next one.
        </p>
        <OpenTerminalButton showView={showView} />
      </Centered>
    )
  }
  return <Centered>{agentLabel(record.kind)} is starting…</Centered>
}

function AgentChat({ session, showView, readOnly, agentStart }: ViewProps) {
  const t = useAgentTranscript(session.paneId)
  const status = toAgentStatus(t.status)
  // View-only has no composer: the dialog is shown here, without buttons.
  // An agent without input has no dialog reader on the server.
  const p = useAgentPrompt(
    readOnly && chatInputAgent(session.agentName) ? session.paneId : undefined,
    status,
  )
  const agent = agentLabel(session.agentName)
  const listRef = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(RENDER_WINDOW)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  atBottomRef.current = atBottom
  const [unseen, setUnseen] = useState(false)
  const lastId = t.entries[t.entries.length - 1]?.id

  // Where the list was before older entries were put above it, so the entry
  // being read stays in place. fromServer: waiting for loadOlder's entries.
  const anchorRef = useRef<{
    height: number
    top: number
    length: number
    fromServer: boolean
  } | null>(null)

  // A new session starts at its end again. Runs before the effect below, so
  // that one already follows the new session's last entry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on session change only
  useLayoutEffect(() => {
    setShown(RENDER_WINDOW)
    setAtBottom(true)
    setUnseen(false)
    atBottomRef.current = true
    anchorRef.current = null
  }, [t.sessionId])

  // New entries: follow them at the bottom, else offer a jump.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || !lastId) return
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
    else setUnseen(true)
  }, [lastId])

  // Older entries above: show the ones loadOlder brought, then put the
  // scroll position back by the height they added.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list grows or loading ends
  useLayoutEffect(() => {
    const a = anchorRef.current
    const el = listRef.current
    if (!a || !el) return
    if (a.fromServer) {
      if (t.entries.length > a.length) {
        a.fromServer = false
        setShown((n) => n + t.entries.length - a.length)
      } else if (!t.loadingOlder) {
        anchorRef.current = null // nothing came back
      }
      return
    }
    el.scrollTop = a.top + el.scrollHeight - a.height
    anchorRef.current = null
  }, [shown, t.entries.length, t.loadingOlder])

  // The list gets shorter when a notice or a taller composer appears under
  // it; one that was at the bottom stays there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list mounts once loaded
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [t.loaded, t.error])

  const onScroll = () => {
    const el = listRef.current
    /* v8 ignore next */
    if (!el) return
    const bottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE
    setAtBottom(bottom)
    if (bottom) setUnseen(false)
    if (el.scrollTop === 0) showEarlier()
  }

  const jumpToBottom = () => {
    const el = listRef.current
    /* v8 ignore next */
    if (!el) return
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
    setUnseen(false)
  }

  const hidden = Math.max(0, t.entries.length - shown)
  const showEarlier = () => {
    const el = listRef.current
    if (anchorRef.current || (hidden === 0 && !t.before) || !el) return
    anchorRef.current = {
      height: el.scrollHeight,
      top: el.scrollTop,
      length: t.entries.length,
      fromServer: hidden === 0,
    }
    if (hidden > 0) setShown((n) => n + RENDER_WINDOW)
    else t.loadOlder()
  }

  if (!t.loaded) {
    return <Centered>Loading the conversation…</Centered>
  }
  const started = agentStart?.starts[session.paneId ?? '']
  if (
    t.error === 'no-session' &&
    t.entries.length === 0 &&
    started?.phase === 'ready' &&
    started.kind === session.agentName
  ) {
    return <StartedNotice record={started} showView={showView} />
  }
  if (t.error && t.entries.length === 0) {
    return (
      <Centered>
        <p>
          {t.error === 'no-session'
            ? `No ${agent} session found in this pane.`
            : 'Could not read the conversation.'}
        </p>
        <OpenTerminalButton showView={showView} />
      </Centered>
    )
  }

  const visible = t.entries.slice(hidden)
  const layout = chatLayout(visible)
  // A split tab (herdr) names the pane too.
  const paneLabel =
    session.panes && session.panes.length > 1
      ? session.panes.find((p) => p.id === session.paneId)?.label
      : undefined
  return (
    <div className="relative flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-[13px]">
        <AgentStatusBadge status={status} />
        <span className="min-w-0 flex-1 truncate font-medium">
          {agent} · {session.name}
          {paneLabel && ` · ${paneLabel}`}
        </span>
        {t.error && <span className="text-warning">Reconnecting…</span>}
      </header>
      <section
        ref={listRef}
        onScroll={onScroll}
        aria-label="Conversation"
        className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto px-3 py-3"
      >
        {(hidden > 0 || t.before) && (
          <div className="flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              disabled={t.loadingOlder}
              onClick={showEarlier}
            >
              {t.loadingOlder ? 'Loading…' : 'Show earlier messages'}
            </Button>
          </div>
        )}
        {visible.length === 0 && (
          <p className="text-center text-fg-muted">No messages yet.</p>
        )}
        {visible.map((e, i) => (
          <ChatMessage
            key={e.id}
            entry={e}
            showTime={layout[i].showTime}
            joinsNext={layout[i].joinsNext}
          />
        ))}
      </section>
      {readOnly && p.prompt && (
        <PromptCard
          readOnly
          paneId={session.paneId ?? ''}
          agentName={session.agentName}
          prompt={p.prompt}
          showView={showView}
          onAnswered={p.refresh}
          onChanged={p.show}
        />
      )}
      {unseen && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            size="sm"
            variant="primary"
            className="pointer-events-auto shadow-md"
            onClick={jumpToBottom}
          >
            <ArrowDown size={14} aria-hidden="true" />
            New messages
          </Button>
        </div>
      )}
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-fg-muted">
      {children}
    </div>
  )
}

export default ChatView
