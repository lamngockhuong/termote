import { MessageSquareText, Pencil, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { NotifyOptions } from '../app-views'
import { agentLabel } from '../chat-agents'
import { RequestError } from '../hooks/use-mux-api'
import { useReviewDraft } from '../hooks/use-review-draft'
import type { Session } from '../types/session'
import {
  type ReviewComment,
  removeReviewComments,
  updateReviewComment,
} from '../utils/review-draft'
import {
  lineLabel,
  MAX_REVIEW_MESSAGE_BYTES,
  reviewMessage,
  sourceLabel,
} from '../utils/review-message'
import { sendToAgent } from '../utils/send-to-agent'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { CHAT_VIEW_ID } from '../view-ids'
import {
  type AgentPaneChoice,
  AgentPanePicker,
  agentPanes,
  rememberAgent,
  rememberedAgent,
} from './agent-pane-picker'
import { ReviewCommentSheet } from './review-comment-sheet'
import { Button, IconButton } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Sheet } from './ui/sheet'

interface Props {
  paneId: string
  // The tab shown: its group's agent is remembered for the next review
  session: Session
  sessions: Session[]
  // The server takes a message for an agent
  canSend: boolean
  notify: (message: string, options?: NotifyOptions) => void
  openTab?: (id: string, paneId?: string, view?: string) => void
  // Shows where a comment is (its diff or file)
  onOpenComment: (c: ReviewComment) => void
}

// The receiver of a review: the pane's own agent, else the agent pane last
// picked for its group (shared with Tasks), else none yet (asked)
function receiver(
  paneId: string,
  groupId: string,
  choices: AgentPaneChoice[],
): { to?: AgentPaneChoice; own: boolean } {
  const own = choices.find((c) => c.paneId === paneId)
  if (own) return { to: own, own: true }
  const last = rememberedAgent(groupId)
  return { to: choices.find((c) => c.paneId === last), own: false }
}

const kib = (n: number) => (n / 1024).toFixed(1)

// The Review button of a pane's header, with how many comments its review
// holds, and the review it opens: the comments by file, each opened,
// edited or deleted there, and all of them sent to an agent as one
// message. Nothing shows while the review is empty.
export function ReviewControl({
  paneId,
  session,
  sessions,
  canSend,
  notify,
  openTab,
  onOpenComment,
}: Props) {
  const comments = useReviewDraft(paneId)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ReviewComment | null>(null)
  const [clearing, setClearing] = useState(false)
  const [picking, setPicking] = useState(false)
  const [sending, setSending] = useState(false)
  if (comments.length === 0 && !open) return null

  const groupId = session.groupId ?? ''
  const choices = agentPanes(sessions)
  const { to, own } = receiver(paneId, groupId, choices)
  const message = reviewMessage(comments)
  const tooLong = message.bytes > MAX_REVIEW_MESSAGE_BYTES
  const why = !canSend
    ? 'This server cannot send a message to an agent'
    : choices.length === 0
      ? 'No pane runs Claude Code or Codex'
      : tooLong
        ? `Too long for one message: ${kib(message.bytes)} of ${kib(MAX_REVIEW_MESSAGE_BYTES)} KiB`
        : undefined

  const send = async (target: AgentPaneChoice, remember: boolean) => {
    if (remember) rememberAgent(groupId, target.paneId)
    setPicking(false)
    setSending(true)
    // Only what is sent goes once it is taken: a comment added meanwhile
    // stays
    const ids = comments.map((c) => c.id)
    const name = agentLabel(target.agentName)
    const openChat = {
      label: 'Open chat',
      onClick: () => openTab?.(target.sessionId, target.paneId, CHAT_VIEW_ID),
    }
    try {
      const { queued } = await sendToAgent(target.paneId, message.text)
      removeReviewComments(paneId, ids)
      setOpen(false)
      notify(queued ? `Queued for ${name}` : `Sent to ${name}`, {
        variant: 'success',
        action: openChat,
      })
    } catch (err) {
      notify(
        err instanceof RequestError
          ? `Not sent: ${err.message}`
          : 'Could not send the review',
        { variant: 'danger' },
      )
    } finally {
      setSending(false)
    }
  }

  // Comments by file, each file where its first comment is
  const byFile = new Map<string, ReviewComment[]>()
  for (const c of comments) {
    const key = `${c.root}\u0000${c.path}`
    byFile.set(key, [...(byFile.get(key) ?? []), c])
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label={`Review, ${comments.length} comment${comments.length === 1 ? '' : 's'}`}
        title="Review comments"
      >
        <MessageSquareText size={15} aria-hidden="true" />
        {comments.length}
      </Button>
      <Sheet
        isOpen={open}
        onClose={() => setOpen(false)}
        title={`Review (${comments.length})`}
      >
        <div className="flex max-h-[70vh] flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {comments.length === 0 && (
              <p className="m-0 p-4 text-sm text-fg-muted">No comments</p>
            )}
            {[...byFile.values()].map((list) => (
              <section
                key={`${list[0].root}\u0000${list[0].path}`}
                aria-label={list[0].path}
              >
                <h3 className="m-0 bg-surface px-3 py-1 font-term text-[12px] font-normal break-all">
                  <bdi>{visibleUnsafe(list[0].path)}</bdi>
                </h3>
                <ul>
                  {list.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-start gap-1 border-b border-border px-3 py-2"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <button
                          type="button"
                          onClick={() => {
                            setOpen(false)
                            onOpenComment(c)
                          }}
                          className="self-start text-left text-[12px] text-accent hover:underline"
                        >
                          {lineLabel(c)}{' '}
                          <span className="text-fg-muted">
                            · {sourceLabel(c)}
                          </span>
                        </button>
                        <p className="m-0 whitespace-pre-wrap break-words text-[13px] text-fg">
                          {visibleUnsafe(c.text, true)}
                        </p>
                      </div>
                      <IconButton
                        size="sm"
                        onClick={() => setEditing(c)}
                        // What is being sent is removed once taken: an
                        // edit made meanwhile would go with it, unsent
                        disabled={sending}
                        aria-label="Edit comment"
                        title="Edit"
                      >
                        <Pencil size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        size="sm"
                        onClick={() => removeReviewComments(paneId, [c.id])}
                        disabled={sending}
                        aria-label="Delete comment"
                        title="Delete"
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="flex shrink-0 flex-col gap-1 border-t border-border p-3">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => setClearing(true)}
                disabled={comments.length === 0 || sending}
              >
                Clear
              </Button>
              <span className="flex-1" />
              {to && !own && (
                <Button
                  variant="ghost"
                  onClick={() => setPicking(true)}
                  disabled={sending}
                >
                  Change
                </Button>
              )}
              <Button
                variant="primary"
                className="pointer-coarse:h-touch"
                disabled={!!why || sending || comments.length === 0}
                onClick={() => {
                  if (to) void send(to, !own)
                  else setPicking(true)
                }}
              >
                <Send size={14} aria-hidden="true" />
                {sending
                  ? 'Sending…'
                  : to
                    ? `Send to ${agentLabel(to.agentName)}`
                    : 'Send to…'}
              </Button>
            </div>
            {to && !own && (
              <p className="m-0 truncate text-right text-[12px] text-fg-muted">
                {visibleUnsafe(to.label)}
              </p>
            )}
            {why && (
              <p className="m-0 text-right text-[12px] text-fg-muted">{why}</p>
            )}
          </div>
        </div>
      </Sheet>
      <AgentPanePicker
        isOpen={picking}
        choices={choices}
        onPick={(c) => void send(c, true)}
        onClose={() => setPicking(false)}
      />
      <ReviewCommentSheet
        target={editing}
        initialText={editing?.text}
        onSave={(text) => {
          // Open only while editing one
          updateReviewComment(paneId, (editing as ReviewComment).id, text)
          setEditing(null)
        }}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        isOpen={clearing}
        title="Clear the review?"
        confirmLabel="Clear"
        destructive
        onConfirm={() => {
          setClearing(false)
          removeReviewComments(
            paneId,
            comments.map((c) => c.id),
          )
        }}
        onCancel={() => setClearing(false)}
      >
        {comments.length} comment{comments.length === 1 ? '' : 's'} will be
        deleted.
      </ConfirmDialog>
    </>
  )
}
