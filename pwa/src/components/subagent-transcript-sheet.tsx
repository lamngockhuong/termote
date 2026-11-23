import { useRef } from 'react'
import type { SubagentNode } from '../hooks/use-mux-api'
import { useSubagentTranscript } from '../hooks/use-subagent-transcript'
import { useSubagents } from '../hooks/use-subagents'
import { useT } from '../i18n/i18n-context'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { useServerSeconds } from './chat-subagents'
import { TranscriptReader } from './history-transcript-view'
import { flattenSubagents, subagentFacts } from './subagent-tree'
import { Sheet } from './ui/sheet'

// One subagent of a pane's Claude Code session and its conversation, read
// only: no input, no action. It follows the conversation while the subagent
// runs. Whoever opens it holds which one is open, above the rows it was
// opened from, so it stays open when that row's list or card goes.

export interface SubagentTarget {
  paneId: string
  // The node as it was when opened, shown once the tree no longer has it
  node: SubagentNode
}

interface Props {
  target?: SubagentTarget
  onClose: () => void
  notify: (message: string) => void
  // The server's clock minus this device's (ms)
  clockOffset?: number
}

export function SubagentTranscriptSheet({
  target,
  onClose,
  notify,
  clockOffset = 0,
}: Props) {
  const { t } = useT()
  // The whole tree, not a filtered list: the subagent's status as it is now
  const { tree } = useSubagents(target?.paneId ?? '', !!target)
  const last = useRef<SubagentNode | undefined>(undefined)
  const found =
    target &&
    flattenSubagents(tree?.nodes ?? []).find((n) => n.id === target.node.id)
  if (found) last.current = found
  const node =
    found ??
    (last.current?.id === target?.node.id ? last.current : target?.node)
  // Before the tree is read, the node opened is taken as listed
  const listed = !!found || !tree
  const live = listed && node?.status === 'running'
  const now = useServerSeconds(!!target && live, clockOffset)
  return (
    <Sheet
      isOpen={!!target}
      onClose={onClose}
      title={node ? visibleUnsafe(node.type) : ''}
      closeLabel={t('chat.subagent.close')}
      className="max-w-2xl!"
    >
      {target && node && (
        <div className="flex h-[min(75vh,48rem)] flex-col">
          <div className="shrink-0 border-b border-border px-4 py-2 text-[12px]">
            {node.description && (
              <p className="truncate text-fg">
                {visibleUnsafe(node.description)}
              </p>
            )}
            <p
              className="text-fg-muted"
              data-status={live ? 'running' : node.status}
            >
              {subagentFacts(live ? node : notRunning(node), now, t)}
            </p>
          </div>
          <SubagentConversation
            key={`${target.paneId}\0${node.id}`}
            paneId={target.paneId}
            agentId={node.id}
            live={live}
            listed={listed}
            notify={notify}
          />
        </div>
      )}
    </Sheet>
  )
}

// A node the tree no longer lists is not said to run: nothing reports it
// any more, so it reads as done, guessed.
function notRunning(n: SubagentNode): SubagentNode {
  return n.status === 'running'
    ? { ...n, status: 'done', statusGuessed: true }
    : n
}

function SubagentConversation({
  paneId,
  agentId,
  live,
  listed,
  notify,
}: {
  paneId: string
  agentId: string
  live: boolean
  listed: boolean
  notify: (message: string) => void
}) {
  const { t } = useT()
  const s = useSubagentTranscript(paneId, agentId, live, listed)
  if (!s.loaded) {
    return (
      <p className="p-6 text-center text-fg-muted">{t('chat.view.loading')}</p>
    )
  }
  const message =
    s.error === 'gone'
      ? t('chat.subagent.gone')
      : s.error === 'unsupported'
        ? t('chat.subagent.unsupported')
        : s.error && t('chat.view.readFailed')
  if (message && s.entries.length === 0) {
    return (
      <p role="alert" className="p-6 text-center text-fg-muted">
        {message}
      </p>
    )
  }
  return (
    <TranscriptReader
      entries={s.entries}
      hasOlder={s.hasOlder}
      loadingOlder={s.loadingOlder}
      loadOlder={s.loadOlder}
      scroll="follow"
      working={live}
      notify={notify}
      imagePane=""
      testId="subagent-transcript"
      empty={t('chat.subagent.empty')}
      notice={
        message && (
          <p
            role="alert"
            className="rounded-control bg-surface px-3 py-2 text-center text-[12px] text-fg-muted"
          >
            {message}
          </p>
        )
      }
    />
  )
}
