import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { historyImageAgent } from '../chat-agents'
import { useHistoryTranscript } from '../hooks/use-history-transcript'
import type { HistoryAgent, TranscriptEntry } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { ChatFileLinkContext } from './chat-file-link'
import { ChatImageViewer } from './chat-image-viewer'
import { ChatMarkdownContext } from './chat-message'
import type { RunMode, RunState } from './chat-tool-run'
import { ChatTranscriptList, useChatMarkdown } from './chat-transcript-list'
import { Button } from './ui/button'

interface Props {
  paneId: string
  agent: HistoryAgent
  sessionId: string
  notify: (message: string) => void
  // A path the agent wrote, opened in the Files view of the pane
  openFile?: (path: string, line?: number) => Promise<void>
}

// An old session's conversation, read once (TranscriptReader).
export function HistoryTranscriptView({
  paneId,
  agent,
  sessionId,
  notify,
  openFile,
}: Props) {
  const { t } = useT()
  const h = useHistoryTranscript(paneId, agent, sessionId)
  if (!h.loaded) {
    return (
      <p className="p-6 text-center text-fg-muted">{t('chat.view.loading')}</p>
    )
  }
  if (h.error) {
    return (
      <p role="alert" className="p-6 text-center text-fg-muted">
        {h.error === 'gone'
          ? t('chat.history.gone')
          : t('chat.view.readFailed')}
      </p>
    )
  }
  // An image chip opens the image where the server serves an old session's
  // images; elsewhere it stays plain text.
  return (
    <TranscriptReader
      entries={h.entries}
      hasOlder={h.hasOlder}
      loadingOlder={h.loadingOlder}
      loadOlder={h.loadOlder}
      scroll="end"
      working={false}
      notify={notify}
      openFile={openFile}
      imagePane={historyImageAgent(agent) ? paneId : ''}
      testId="history-transcript"
    />
  )
}

// Within this many pixels of the bottom, a following reader stays there.
const STICK_DISTANCE = 48

interface ReaderProps {
  entries: TranscriptEntry[]
  hasOlder: boolean
  loadingOlder: boolean
  loadOlder: () => void
  // end: every change shows the end (a conversation read once); follow:
  // new entries keep the end in view only for a reader already there
  scroll: 'end' | 'follow'
  // The agent is working: its last run is open on its newest steps
  working: boolean
  notify: (message: string) => void
  // A path the agent wrote, opened in the Files view of the pane
  openFile?: (path: string, line?: number) => Promise<void>
  // The pane whose server serves the entries' images ('': plain chips)
  imagePane: string
  testId: string
  // Shown above the entries (why no more come)
  notice?: ReactNode
  // Shown in place of the entries when there are none
  empty?: string
}

// A conversation read only, drawn as the Chat view draws a running one. It
// opens at its end; older entries load on request, the entry being read
// staying in place.
export function TranscriptReader({
  entries,
  hasOlder,
  loadingOlder,
  loadOlder,
  scroll,
  working,
  notify,
  openFile,
  imagePane,
  testId,
  notice,
  empty,
}: ReaderProps) {
  const { t } = useT()
  const listRef = useRef<HTMLDivElement>(null)
  const [modes, setModes] = useState<Record<string, RunMode>>({})
  const held = useRef(new Set<string>())
  const tails = useRef(new Map<string, string>())
  // The height before older entries went above, to keep the place
  const before = useRef<number | null>(null)
  // The reader is at the end (follow), as of its last scroll
  const [atBottom, setAtBottom] = useState(true)
  const markdown = useChatMarkdown(listRef, notify)

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as entries arrive
  useLayoutEffect(() => {
    const el = listRef.current as HTMLElement
    if (before.current !== null)
      el.scrollTop += el.scrollHeight - before.current
    else if (scroll === 'end' || atBottom) el.scrollTop = el.scrollHeight
    before.current = null
  }, [entries])

  const runs: RunState = {
    modes,
    held: held.current,
    tails: tails.current,
    follow: scroll === 'follow' && atBottom,
    setMode: (ids, mode) =>
      setModes((m) => ({
        ...m,
        ...Object.fromEntries(ids.map((id) => [id, mode])),
      })),
  }
  const showEarlier = () => {
    before.current = (listRef.current as HTMLElement).scrollHeight
    loadOlder()
  }
  const onScroll =
    scroll === 'follow'
      ? () => {
          const el = listRef.current as HTMLElement
          setAtBottom(
            el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_DISTANCE,
          )
        }
      : undefined
  return (
    <section
      ref={listRef}
      aria-label={t('chat.view.conversation')}
      data-testid={testId}
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3"
      onScroll={onScroll}
      data-native-menu
    >
      <ChatFileLinkContext.Provider value={openFile}>
        <ChatImageViewer paneId={imagePane}>
          <ChatMarkdownContext.Provider value={markdown}>
            <div className="space-y-3">
              {notice}
              {hasOlder && (
                <div className="flex justify-center">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={loadingOlder}
                    onClick={showEarlier}
                  >
                    {loadingOlder
                      ? t('chat.view.loadingOlder')
                      : t('chat.view.showEarlier')}
                  </Button>
                </div>
              )}
              {entries.length === 0 && (
                <p className="text-center text-fg-muted">
                  {empty ?? t('chat.view.empty')}
                </p>
              )}
              <ChatTranscriptList
                entries={entries}
                hidden={0}
                runs={runs}
                working={working}
                settled={!working}
              />
            </div>
          </ChatMarkdownContext.Provider>
        </ChatImageViewer>
      </ChatFileLinkContext.Provider>
    </section>
  )
}
