import { ArrowDown, History } from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ViewProps } from '../app-views'
import { agentLabel, chatInputAgent, subagentAgent } from '../chat-agents'
import { useAgentPrompt } from '../hooks/use-agent-prompt'
import { useAgentTranscript } from '../hooks/use-agent-transcript'
import { useDomSelection } from '../hooks/use-dom-selection'
import {
  FOLLOW_NOTICES,
  followPathInFiles,
  openOutsideInFiles,
} from '../hooks/use-files'
import type { ResumeWhere, SubagentNode } from '../hooks/use-mux-api'
import { useNewKeys } from '../hooks/use-new-keys'
import { useResumeSession } from '../hooks/use-resume-session'
import type { StartRecord } from '../hooks/use-start-agent'
import { useT } from '../i18n/i18n-context'
import { toAgentStatus } from '../types/session'
import { canResumeHere, canStartAgent } from '../utils/agent-start'
import { selectionText } from '../utils/chat-quote'
import { setChatSelection } from '../utils/chat-selection'
import type { LineMark } from '../utils/file-position'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { FILES_VIEW_ID } from '../view-ids'
import { AgentStatusBadge } from './agent-status-badge'
import { ChatActivity, ChatBackground } from './chat-activity-row'
import { ChatAsks } from './chat-asks'
import { ChatFileLinkContext } from './chat-file-link'
import { ChatImageViewer } from './chat-image-viewer'
import { ChatMarkdownContext } from './chat-message'
import { ChatSubagents } from './chat-subagents'
import {
  keepRun,
  keepRunAt,
  type RunMode,
  type RunState,
} from './chat-tool-run'
import { ChatTranscriptList, useChatMarkdown } from './chat-transcript-list'
import { OpenTerminalButton } from './open-terminal-button'
import { PromptCard } from './prompt-card'
import { RecentSessions } from './recent-sessions'
import { StartAgentPanel } from './start-agent-panel'
import {
  type SubagentTarget,
  SubagentTranscriptSheet,
} from './subagent-transcript-sheet'
import { Button, IconButton } from './ui/button'

// Entries rendered at once; scrolling to the top shows more.
export const RENDER_WINDOW = 150
// Within this many pixels of the bottom, the list follows new entries.
const STICK_DISTANCE = 48

// Where the reader was in each conversation left on screen, by pane and
// session: switching tabs or views and coming back finds it there again.
interface ChatPlace {
  shown: number
  atBottom: boolean
  unseen: boolean
  top: number
  lastId?: string
  runModes: Record<string, RunMode>
  held: Set<string>
  tails: Map<string, string>
}
const MAX_PLACES = 100
const places = new Map<string, ChatPlace>()

export function resetChatPlaces() {
  places.clear()
}

function keepPlace(key: string, place: ChatPlace) {
  places.delete(key) // re-inserted last: the oldest goes first
  places.set(key, place)
  if (places.size > MAX_PLACES) {
    places.delete(places.keys().next().value as string)
  }
}
// How far below the top of the list an element is
function offsetIn(list: Element, el: Element) {
  return el.getBoundingClientRect().top - list.getBoundingClientRect().top
}

// The first entry of the list still on screen, and where
function firstOnScreen(list: Element) {
  const content = list.firstElementChild as Element
  for (const entry of content.children) {
    const top = offsetIn(list, entry)
    if (top + entry.getBoundingClientRect().height > 0) return { entry, top }
  }
  return null
}

export function ChatView(props: ViewProps) {
  if (!props.session.hasAgent) return <NoAgentChat {...props} />
  return <AgentChat {...props} />
}

// A pane with no agent (yet): start one, follow the start, or say there is
// none.
function NoAgentChat(props: ViewProps) {
  const { mux, session, showView, agentStart } = props
  const { t } = useT()
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
          kinds={
            mux.caps.agentStartCodex
              ? ['claude', 'codex', 'opencode']
              : ['claude', 'opencode']
          }
          record={record}
          onStart={(kind) => agentStart.start(paneId, kind)}
        />
        <Recent {...props} />
      </Centered>
    )
  }
  return (
    <Centered>
      <p>{t('chat.view.noAgent')}</p>
      <OpenTerminalButton showView={showView} />
      <Recent {...props} />
    </Centered>
  )
}

// The latest sessions of the pane's folder, to resume: in the pane itself
// when it is an idle shell, else in a new tab.
function Recent({
  mux,
  session,
  readOnly,
  notify,
  openHistory,
  onSessionResumed,
}: ViewProps) {
  const paneId = session.paneId
  const { pending, resume } = useResumeSession({
    notify,
    onResumed: (result, where) => onSessionResumed?.(result, where),
  })
  if (!paneId || !openHistory || !mux.caps.files) return null
  const where: ResumeWhere | undefined =
    readOnly || !mux.caps.tasks
      ? undefined
      : canResumeHere(mux, session)
        ? 'here'
        : 'tab'
  return (
    <RecentSessions
      paneId={paneId}
      where={where}
      pending={pending}
      onResume={(s, w) => resume(paneId, s, w)}
      onOpen={(s) => openHistory(paneId, s)}
    />
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
  const { t } = useT()
  if (record.kind === 'codex') {
    return (
      <Centered>
        <p>{t('chat.view.codexStarted')}</p>
        <OpenTerminalButton showView={showView} />
      </Centered>
    )
  }
  return (
    <Centered>
      {t('chat.view.starting', { agent: agentLabel(record.kind) })}
    </Centered>
  )
}

function AgentChat({
  mux,
  session,
  showView,
  readOnly,
  agentStart,
  notify,
  isMobile,
  clockOffset,
  openHistory,
  hiddenGroupIds,
}: ViewProps) {
  const t = useAgentTranscript(session.paneId)
  const { t: translate } = useT()
  // A message that came in after the conversation showed fades in: not its
  // history, nor older messages loaded above it (before the first one known)
  const isNew = useNewKeys(
    t.entries.map((e) => e.id),
    session.paneId,
  )
  const firstKnown = t.entries.findIndex((e) => !isNew(e.id))
  const status = toAgentStatus(t.status)
  // View-only has no composer: the dialog is shown here, without buttons.
  // An agent without input has no dialog reader on the server.
  const p = useAgentPrompt(
    readOnly && chatInputAgent(session.agentName) ? session.paneId : undefined,
    status,
  )
  const agent = agentLabel(session.agentName)
  const listRef = useRef<HTMLDivElement>(null)
  // Text selected in the conversation, for a template's {{selection}} and
  // the composer's Quote button (kept as shown, until quoted or touched
  // again)
  // (called only with a pane, inside the list)
  useDomSelection(listRef, session.paneId, 'chat.fill.from.chat', (range) =>
    setChatSelection(
      session.paneId as string,
      selectionText(range, listRef.current as HTMLElement),
    ),
  )
  // The pane left (another one, the view closed) forgets its selection
  useEffect(() => {
    const id = session.paneId
    return () => {
      if (id) setChatSelection(id, null)
    }
  }, [session.paneId])
  const contentRef = useRef<HTMLDivElement>(null)
  // The first entry on screen while reading above the bottom, and how far
  // below the list's top it was
  const readingRef = useRef<{ entry: Element; top: number } | null>(null)
  const markdown = useChatMarkdown(listRef, notify)
  const paneId = session.paneId ?? ''
  // The subagent whose conversation is open: held here, so it stays open
  // when the last running one ends and the strip it was opened from goes
  const [subagent, setSubagent] = useState<SubagentTarget>()
  const openSubagent = useCallback(
    (node: SubagentNode) => setSubagent({ paneId, node }),
    [paneId],
  )
  // A path the agent wrote, opened in the Files view; none without one
  const openFile = useMemo(
    () =>
      mux.caps.files && paneId
        ? async (path: string, line?: number, marks?: LineMark[]) => {
            const result = await followPathInFiles(paneId, path, line, marks)
            if (result === 'opened') showView(FILES_VIEW_ID)
            else if (result === 'outside') {
              const notice = await openOutsideInFiles(paneId, path, {
                readOnly,
              })
              if (notice) notify(translate(notice))
              else showView(FILES_VIEW_ID)
            } else if (FOLLOW_NOTICES[result])
              notify(translate(FOLLOW_NOTICES[result]))
          }
        : undefined,
    [mux.caps.files, paneId, showView, notify, translate, readOnly],
  )
  const [shown, setShown] = useState(RENDER_WINDOW)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  atBottomRef.current = atBottom
  const [unseen, setUnseen] = useState(false)
  const lastId = t.entries[t.entries.length - 1]?.id
  // What the reader opened or folded of each run, and the runs that were
  // live on screen, by entry id
  const [runModes, setRunModes] = useState<Record<string, RunMode>>({})
  const heldRef = useRef(new Set<string>())
  const tailsRef = useRef(new Map<string, string>())

  // Where the list was before older entries were put above it, so the entry
  // being read stays in place. fromServer: waiting for loadOlder's entries.
  const anchorRef = useRef<{
    height: number
    top: number
    length: number
    fromServer: boolean
  } | null>(null)

  // The reader's place as of the last commit, and the scroll position the
  // list last reported: kept when the conversation is left
  const placeRef = useRef<ChatPlace | null>(null)
  const topRef = useRef(0)
  // A place to scroll back to once the list shows the window it was in
  const [restore, setRestore] = useState<{ top: number } | null>(null)
  const placeKey = t.sessionId ? `${paneId}\n${t.sessionId}` : undefined

  // Another conversation (another tab, or this one shown again) opens where
  // it was left, a new one at its end. Runs before the effect below, so that
  // one already follows the last entry of a conversation left at its end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on conversation change only
  useLayoutEffect(() => {
    const p = placeKey ? places.get(placeKey) : undefined
    setShown(p?.shown ?? RENDER_WINDOW)
    setAtBottom(p?.atBottom ?? true)
    // Entries that came in while away are news to a reader above them
    setUnseen(!!p && !p.atBottom && (p.unseen || p.lastId !== lastId))
    setRunModes(p?.runModes ?? {})
    heldRef.current = p?.held ?? new Set()
    tailsRef.current = p?.tails ?? new Map()
    atBottomRef.current = p?.atBottom ?? true
    anchorRef.current = null
    readingRef.current = null
    topRef.current = p?.top ?? 0
    setRestore(p && !p.atBottom ? { top: p.top } : null)
    return () => {
      if (placeKey && placeRef.current) {
        keepPlace(placeKey, { ...placeRef.current, top: topRef.current })
      }
    }
  }, [placeKey])

  // Declared after the effect above: its cleanup still reads the place of
  // the conversation being left.
  useLayoutEffect(() => {
    placeRef.current = {
      shown,
      atBottom,
      unseen,
      top: 0,
      lastId,
      runModes,
      held: heldRef.current,
      tails: tailsRef.current,
    }
  })

  // Back where the reader was, once the restored window is drawn (and the
  // list is, for a conversation still loading)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list mounts once loaded
  useLayoutEffect(() => {
    const el = listRef.current
    if (!restore || !el) return
    el.scrollTop = restore.top
    readingRef.current = firstOnScreen(el)
    setRestore(null)
  }, [restore, t.loaded])

  // New entries: follow them at the bottom, else offer a jump (one that came
  // in while away is the effect above's).
  // null: none followed yet, so a restored place offers no jump on mount
  const followedRef = useRef<string | undefined | null>(null)
  useLayoutEffect(() => {
    const el = listRef.current
    const same = followedRef.current === placeKey
    followedRef.current = placeKey
    if (!el || !lastId) return
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
    else if (same) setUnseen(true)
  }, [lastId, placeKey])

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
  // it, its content taller when a diagram or highlighted code arrives late:
  // one that was at the bottom stays there, else the entry being read stays
  // in place (a browser without scroll anchoring would move it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list mounts once loaded
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) {
        el.scrollTop = el.scrollHeight
        return
      }
      const r = readingRef.current
      if (r?.entry.isConnected) el.scrollTop += offsetIn(el, r.entry) - r.top
    })
    ro.observe(el)
    ro.observe(contentRef.current as HTMLDivElement)
    return () => ro.disconnect()
  }, [t.loaded, t.error])

  const onScroll = () => {
    const el = listRef.current
    /* v8 ignore next */
    if (!el) return
    const bottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE
    topRef.current = el.scrollTop
    setAtBottom(bottom)
    if (bottom) setUnseen(false)
    readingRef.current = bottom ? null : firstOnScreen(el)
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
    return <Centered>{translate('chat.view.loading')}</Centered>
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
            ? translate('chat.view.noSession', { agent })
            : translate('chat.view.readFailed')}
        </p>
        <OpenTerminalButton showView={showView} />
      </Centered>
    )
  }

  const visible = t.entries.slice(hidden)
  const runs: RunState = {
    modes: runModes,
    held: heldRef.current,
    tails: tailsRef.current,
    follow: atBottom,
    clockOffset: clockOffset ?? 0,
    setMode: (ids, mode) =>
      setRunModes((m) => ({
        ...m,
        ...Object.fromEntries(ids.map((id) => [id, mode])),
      })),
    keep: (id) => setRunModes((m) => keepRun(m, id)),
  }
  // A call left without a result (an interrupted one) keeps nothing open
  // once the agent says it is done.
  const settled = status === 'idle' || status === 'done'
  // A split tab names the pane too, and so does a one-pane tab whose pane
  // the user named.
  const shownPane = session.panes?.find((p) => p.id === session.paneId)
  const paneLabel =
    session.panes && session.panes.length > 1
      ? shownPane?.label
      : shownPane?.name
  return (
    <div className="relative flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[12px]">
        <AgentStatusBadge status={status} />
        <span className="min-w-0 flex-1 truncate font-medium">
          {/* The session's tab names it on a desktop; a phone has no tabs */}
          {[agent, isMobile ? session.name : undefined, paneLabel]
            .filter((part): part is string => !!part)
            .map((part) => visibleUnsafe(part))
            .join(' · ')}
        </span>
        {t.error && (
          <span className="text-warning">
            {translate('chat.view.reconnecting')}
          </span>
        )}
        {openHistory && mux.caps.files && paneId && (
          <IconButton
            size="sm"
            aria-label={translate('chat.history.title')}
            title={translate('chat.history.title')}
            onClick={() => openHistory(paneId)}
          >
            <History size={14} aria-hidden="true" />
          </IconButton>
        )}
      </header>
      <section
        ref={listRef}
        onScroll={onScroll}
        // A run pressed or focused inside stays open once the agent is done
        onFocusCapture={(e) => keepRunAt(e, runs)}
        onPointerDownCapture={(e) => keepRunAt(e, runs)}
        // A click or tap that leaves nothing selected: the selection kept is
        // not quoted (a right click, a tap on the selected text keep it; a
        // new selection replaces it)
        onClick={() => {
          if (session.paneId && document.getSelection()?.isCollapsed) {
            setChatSelection(session.paneId, null)
          }
        }}
        aria-label={translate('chat.view.conversation')}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3"
        data-native-menu
      >
        <ChatFileLinkContext.Provider value={openFile}>
          <ChatImageViewer paneId={paneId}>
            <ChatMarkdownContext.Provider value={markdown}>
              <div ref={contentRef} className="space-y-3">
                {(hidden > 0 || t.before) && (
                  <div className="flex justify-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={t.loadingOlder}
                      onClick={showEarlier}
                    >
                      {t.loadingOlder
                        ? translate('chat.view.loadingOlder')
                        : translate('chat.view.showEarlier')}
                    </Button>
                  </div>
                )}
                {visible.length === 0 && (
                  <p className="text-center text-fg-muted">
                    {translate('chat.view.empty')}
                  </p>
                )}
                <ChatTranscriptList
                  entries={t.entries}
                  hidden={hidden}
                  runs={runs}
                  working={status === 'working'}
                  settled={settled}
                  enters={(id, index) => isNew(id) && index > firstKnown}
                />
                {status === 'working' ? (
                  <ChatActivity
                    paneId={
                      chatInputAgent(session.agentName)
                        ? session.paneId
                        : undefined
                    }
                    status={status}
                    agent={agent}
                  />
                ) : (
                  chatInputAgent(session.agentName) &&
                  session.paneId && (
                    <ChatBackground paneId={session.paneId} status={status} />
                  )
                )}
              </div>
            </ChatMarkdownContext.Provider>
          </ChatImageViewer>
        </ChatFileLinkContext.Provider>
      </section>
      {/* Only Claude Code's and OpenCode's sessions have a subagent tree */}
      {subagentAgent(session.agentName) && paneId && (
        <ChatSubagents
          paneId={paneId}
          clockOffset={clockOffset}
          // Only Claude Code's subagents have a conversation to read, and a
          // view-only device does not read it (their task and report are
          // plain text there)
          onOpen={
            session.agentName === 'claude' && !readOnly
              ? openSubagent
              : undefined
          }
        />
      )}
      {!readOnly && paneId && (
        <ChatAsks
          paneId={paneId}
          clockOffset={clockOffset ?? 0}
          hiddenGroupIds={hiddenGroupIds}
        />
      )}
      <SubagentTranscriptSheet
        target={subagent?.paneId === paneId ? subagent : undefined}
        onClose={() => setSubagent(undefined)}
        notify={notify}
        clockOffset={clockOffset}
      />
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
            {translate('chat.view.newMessages')}
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
