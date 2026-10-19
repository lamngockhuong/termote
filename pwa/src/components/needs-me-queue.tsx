import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { agentLabel } from '../chat-agents'
import { useAgentPrompt } from '../hooks/use-agent-prompt'
import type { Session, SessionPane } from '../types/session'
import {
  ANSWER_GRACE,
  advance,
  type Blocked,
  EMPTY_QUEUE,
  markAnswered,
  markSent,
  paneOf,
  unskip,
  updateQueue,
} from '../utils/needs-me-queue'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { PromptCard, WaitingCard } from './prompt-card'
import { ReadOnlyBar } from './read-only-bar'
import { Button } from './ui/button'

// Next is held this long after "Answered" shows: taps meant for the answer
// buttons, repeated, do not move on to another agent's dialog.
export const NEXT_DELAY = 400

export interface QueueCard {
  session: Session
  pane: SessionPane
  // "group / tab"
  where: string
}

interface Props {
  // Every agent card, in any order; the blocked ones are queued
  cards: QueueCard[]
  readOnly: boolean
  // The server reads and answers this pane's dialogs (else: the terminal)
  canAnswer: (pane: SessionPane) => boolean
  onOpen: (
    session: Session,
    pane: SessionPane,
    view: 'chat' | 'terminal',
  ) => void
}

// The dialogs waiting on the user, answered one at a time at the top of the
// overview (utils/needs-me-queue.ts: the card on top is pinned, an answer
// never moves on by itself). Only that card's dialog is read.
export function NeedsMeQueue({ cards, readOnly, canAnswer, onOpen }: Props) {
  const blocked: Blocked[] = useMemo(
    () =>
      cards
        .filter((c) => c.pane.agentStatus === 'blocked')
        .map((c) => ({ paneId: c.pane.id, since: c.pane.agentSince })),
    [cards],
  )
  const blockedKey = blocked.map((b) => `${b.paneId}@${b.since}`).join('\n')
  const [queue, setQueue] = useState(() => updateQueue(EMPTY_QUEUE, blocked))
  // biome-ignore lint/correctness/useExhaustiveDependencies: blockedKey stands for blocked
  useEffect(() => {
    setQueue((q) => updateQueue(q, blocked))
  }, [blockedKey])
  // An answered wait still blocked once its grace is over comes back
  const graced = queue.answeredWaits.size > 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: blockedKey stands for blocked
  useEffect(() => {
    if (!graced) return
    const id = setTimeout(
      () => setQueue((q) => updateQueue(q, blocked)),
      ANSWER_GRACE,
    )
    return () => clearTimeout(id)
  }, [graced, blockedKey, queue.answeredWaits])

  // The card answered stays on screen after its pane left the list; the
  // others are dropped with their pane.
  const seen = useRef(new Map<string, QueueCard>())
  const currentPane = queue.current === null ? null : paneOf(queue.current)
  const listed = new Set(cards.map((c) => c.pane.id))
  for (const id of seen.current.keys()) {
    if (!listed.has(id) && id !== currentPane) seen.current.delete(id)
  }
  for (const c of cards) seen.current.set(c.pane.id, c)
  const card = currentPane ? seen.current.get(currentPane) : undefined

  // Only a move the user asked for (Next, Skip) takes the focus to the new
  // card's title, never onto an answer button a repeated tap would press.
  const titleRef = useRef<HTMLHeadingElement>(null)
  const focusNext = useRef(false)
  const move = (next: typeof queue) => {
    focusNext.current = true
    setQueue(next)
  }
  useEffect(() => {
    if (focusNext.current && queue.current) titleRef.current?.focus()
    focusNext.current = false
  }, [queue.current])
  const done = useCallback(() => setQueue((q) => markAnswered(q)), [])
  const sent = useCallback(() => setQueue(markSent), [])

  const titleId = useId()
  if (!card) {
    const n = queue.skipped.size
    return n > 0 ? (
      <p className="mb-4 flex items-center gap-2 text-[13px] text-fg-muted">
        {n} skipped {n === 1 ? 'dialog is' : 'dialogs are'} still waiting.
        <Button size="sm" onClick={() => move(unskip(queue, blocked))}>
          Show again
        </Button>
      </p>
    ) : null
  }
  const left = queue.waiting.length
  return (
    <section
      aria-labelledby={titleId}
      className="mb-4 overflow-hidden rounded-panel border border-danger/50 bg-surface ui-terminal:bg-bg"
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <h3
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate text-[14px] font-semibold outline-none"
        >
          Needs you: {agentLabel(card.pane.agentName)},{' '}
          {visibleUnsafe(card.where)}
        </h3>
        <span className="shrink-0 text-[12px] text-fg-muted">
          {left > 0 ? `${left} more waiting` : 'last one'}
        </span>
        {!queue.answered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => move(advance(queue, blocked))}
          >
            Skip
          </Button>
        )}
      </div>
      {queue.answered ? (
        <Answered left={left} onNext={() => move(advance(queue, blocked))} />
      ) : (
        <QueueDialog
          key={queue.current}
          card={card}
          readOnly={readOnly}
          answerable={canAnswer(card.pane)}
          onOpen={onOpen}
          onSent={sent}
          onDone={done}
        />
      )}
    </section>
  )
}

function Answered({ left, onNext }: { left: number; onNext: () => void }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setReady(true), NEXT_DELAY)
    return () => clearTimeout(id)
  }, [])
  return (
    <div className="flex items-center gap-2 p-3">
      <p role="status" className="flex-1 text-[13px] text-fg">
        Answered.
      </p>
      <Button variant="primary" disabled={!ready} onClick={onNext}>
        {left > 0 ? `Next (${left} left)` : 'Done'}
      </Button>
    </div>
  )
}

function QueueDialog({
  card,
  readOnly,
  answerable,
  onOpen,
  onSent,
  onDone,
}: {
  card: QueueCard
  readOnly: boolean
  answerable: boolean
  onOpen: Props['onOpen']
  // A choice reached the pane (maybe only a tab of the dialog)
  onSent: () => void
  // An answer was sent and the dialog has closed since
  onDone: () => void
}) {
  const { session, pane } = card
  // Only this card's dialog is polled, and only where the server reads it
  const p = useAgentPrompt(answerable ? pane.id : undefined, 'blocked')
  // A sent choice may only move to the next tab or tick an option: the
  // wait is answered once the dialog is gone, not before.
  const [sent, setSent] = useState(false)
  const closed = p.loaded && !p.prompt
  useEffect(() => {
    if (sent && closed) onDone()
  }, [sent, closed, onDone])
  // The card's only way out (Open terminal) goes to its own pane's
  // terminal, not to the pane on screen
  const showView = () => onOpen(session, pane, 'terminal')
  if (!answerable || closed) {
    return <WaitingCard agentName={pane.agentName} showView={showView} />
  }
  if (!p.prompt) {
    return (
      <p role="status" className="p-3 text-[13px] text-fg-muted">
        Reading the dialog…
      </p>
    )
  }
  return (
    <>
      <PromptCard
        // A new dialog starts afresh: its body unread, its lock on
        key={`${pane.id}\n${p.prompt.promptId ?? ''}`}
        paneId={pane.id}
        agentName={pane.agentName}
        prompt={p.prompt}
        readOnly={readOnly}
        showView={showView}
        onAnswered={p.refresh}
        onSent={() => {
          setSent(true)
          onSent()
        }}
        onChanged={p.show}
      />
      {readOnly && (
        <ReadOnlyBar label="View only: answer from a device with full access" />
      )}
    </>
  )
}
