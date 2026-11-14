import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useHistoryTranscript } from '../hooks/use-history-transcript'
import type { HistoryAgent } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { ChatFileLinkContext } from './chat-file-link'
import { ChatMarkdownContext } from './chat-message'
import type { RunMode, RunState } from './chat-tool-run'
import { ChatTranscriptList } from './chat-transcript-list'
import { Button } from './ui/button'

interface Props {
  paneId: string
  agent: HistoryAgent
  sessionId: string
  notify: (message: string) => void
  // A path the agent wrote, opened in the Files view of the pane
  openFile?: (path: string, line?: number) => Promise<void>
}

// An old session's conversation, read only, drawn as the Chat view draws a
// running one. It opens at its end; older entries load on request, the
// entry being read staying in place.
export function HistoryTranscriptView({
  paneId,
  agent,
  sessionId,
  notify,
  openFile,
}: Props) {
  const { t } = useT()
  const h = useHistoryTranscript(paneId, agent, sessionId)
  const listRef = useRef<HTMLDivElement>(null)
  const [modes, setModes] = useState<Record<string, RunMode>>({})
  const held = useRef(new Set<string>())
  const tails = useRef(new Map<string, string>())
  // The height before older entries went above, to keep the place
  const before = useRef<number | null>(null)
  const markdown = useMemo(
    () => ({ scrollRoot: () => listRef.current, notify }),
    [notify],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as entries arrive
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (before.current === null) el.scrollTop = el.scrollHeight
    else el.scrollTop += el.scrollHeight - before.current
    before.current = null
  }, [h.entries])

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
  const runs: RunState = {
    modes,
    held: held.current,
    tails: tails.current,
    follow: false,
    setMode: (ids, mode) =>
      setModes((m) => ({
        ...m,
        ...Object.fromEntries(ids.map((id) => [id, mode])),
      })),
  }
  const showEarlier = () => {
    before.current = listRef.current?.scrollHeight ?? null
    h.loadOlder()
  }
  return (
    <section
      ref={listRef}
      aria-label={t('chat.view.conversation')}
      data-testid="history-transcript"
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3"
      data-native-menu
    >
      <ChatFileLinkContext.Provider value={openFile}>
        <ChatMarkdownContext.Provider value={markdown}>
          <div className="space-y-3">
            {h.hasOlder && (
              <div className="flex justify-center">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={h.loadingOlder}
                  onClick={showEarlier}
                >
                  {h.loadingOlder
                    ? t('chat.view.loadingOlder')
                    : t('chat.view.showEarlier')}
                </Button>
              </div>
            )}
            {h.entries.length === 0 && (
              <p className="text-center text-fg-muted">
                {t('chat.view.empty')}
              </p>
            )}
            <ChatTranscriptList
              entries={h.entries}
              hidden={0}
              runs={runs}
              working={false}
              settled
            />
          </div>
        </ChatMarkdownContext.Provider>
      </ChatFileLinkContext.Provider>
    </section>
  )
}
