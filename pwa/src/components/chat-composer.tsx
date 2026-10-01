import { SendHorizontal } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useState } from 'react'
import type { ViewProps } from '../app-views'
import { useAgentPrompt } from '../hooks/use-agent-prompt'
import { useAgentTranscript } from '../hooks/use-agent-transcript'
import { AgentRequestError, sendAgentMessage } from '../hooks/use-mux-api'
import { toAgentStatus } from '../types/session'
import { OpenTerminalButton } from './open-terminal-button'
import { PromptCard, WaitingCard } from './prompt-card'
import { Banner, type BannerVariant } from './ui/banner'
import { IconButton } from './ui/button'

// The server's limit on a message, in UTF-8 bytes.
export const MAX_MESSAGE_BYTES = 16 * 1024
const MAX_ROWS = 6

const draftKey = (paneId: string) => `termote-chat-draft:${paneId}`

function loadDraft(paneId: string): string {
  try {
    return sessionStorage.getItem(draftKey(paneId)) ?? ''
  } catch {
    return ''
  }
}

function saveDraft(paneId: string, text: string) {
  try {
    if (text) sessionStorage.setItem(draftKey(paneId), text)
    else sessionStorage.removeItem(draftKey(paneId))
  } catch {
    // A private window without storage keeps the draft in memory only.
  }
}

const encoder = new TextEncoder()
export const byteLength = (s: string) => encoder.encode(s).length

interface Notice {
  variant: BannerVariant
  text: string
  // Offer the terminal: the screen needs a look there
  terminal?: boolean
}

// What to tell the user when the server refuses a message.
function noticeFor(err: unknown): Notice {
  if (!(err instanceof AgentRequestError)) {
    return {
      variant: 'danger',
      text: 'Could not reach the server; the message was not sent.',
    }
  }
  switch (err.code) {
    case 'input_not_ready':
      return {
        variant: 'warning',
        text: `Not sent: ${err.message}.`,
        terminal: true,
      }
    case 'paste_not_confirmed':
      return {
        variant: 'warning',
        text: 'Not sent: the text did not show in the input box. It may be there now; check in the terminal.',
        terminal: true,
      }
    case 'delivered_not_submitted':
      return {
        variant: 'danger',
        text: 'The text was pasted but not submitted. Check the terminal before sending again.',
        terminal: true,
      }
    case 'session_changed':
      return {
        variant: 'info',
        text: 'The conversation changed; it has been reloaded. Send again if you still want to.',
      }
    case 'text_too_long':
      return {
        variant: 'warning',
        text: `Too long: the limit is ${Math.floor((err.limit ?? MAX_MESSAGE_BYTES) / 1024)} KB.`,
      }
    default:
      return {
        variant: 'danger',
        text: `Not sent: ${err.message}.`,
        terminal: err.status === 409,
      }
  }
}

export function ChatComposer({ session, isMobile, showView }: ViewProps) {
  const paneId = session.paneId ?? ''
  const t = useAgentTranscript(session.paneId)
  const status = toAgentStatus(t.status)
  const p = useAgentPrompt(session.paneId, status)
  // Blocked with no dialog the server can read. Only once a dialog read came
  // back: before it, or as an answer settles, this would flash.
  const waiting = status === 'blocked' && p.loaded && !p.prompt
  const [text, setText] = useState(() => loadDraft(paneId))
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const limitId = useId()

  // Each pane keeps its own draft.
  useEffect(() => {
    setText(loadDraft(paneId))
    setNotice(null)
  }, [paneId])

  const update = (value: string) => {
    setText(value)
    saveDraft(paneId, value)
  }

  const bytes = byteLength(text)
  const tooLong = bytes > MAX_MESSAGE_BYTES
  const canSend = !sending && !!t.cursor && text.trim() !== '' && !tooLong

  const send = async () => {
    if (!canSend || !t.cursor) return
    // "!" runs the rest as a shell command in Claude Code.
    if (
      text.trimStart().startsWith('!') &&
      !window.confirm('Run this as a shell command in Claude Code?')
    ) {
      return
    }
    setSending(true)
    setNotice(null)
    try {
      await sendAgentMessage(paneId, text, t.cursor)
      update('')
      t.refresh()
    } catch (err) {
      setNotice(noticeFor(err))
      if (err instanceof AgentRequestError && err.code === 'session_changed') {
        t.refresh()
      }
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // On a phone Enter is a new line and the button sends; with a keyboard,
    // Ctrl/Cmd+Enter sends.
    if (e.key === 'Enter' && !isMobile && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      send()
    }
  }

  const rows = Math.min(MAX_ROWS, Math.max(1, text.split('\n').length))
  // One live region in every state, so a dialog, a wait or a refusal is
  // announced when it appears.
  const announcement =
    notice?.text ??
    (p.prompt
      ? `Claude Code asks: ${p.prompt.title || 'a question'}`
      : waiting
        ? 'Claude Code is waiting for you in the terminal.'
        : '')
  const live = (
    <p aria-live="polite" className="sr-only">
      {announcement}
    </p>
  )
  // An open dialog takes the composer's place; the draft is kept for after.
  if (p.prompt) {
    return (
      <>
        {live}
        <PromptCard
          // A new dialog (or another tab of one) starts without the last
          // one's notice
          key={`${p.prompt.title}\n${p.prompt.steps?.findIndex((s) => s.current) ?? ''}`}
          paneId={paneId}
          prompt={p.prompt}
          showView={showView}
          onAnswered={() => {
            p.refresh()
            t.refresh()
          }}
          onChanged={(next) => {
            p.show(next)
            if (!next) {
              setNotice({
                variant: 'info',
                text: 'The dialog closed before the answer was sent.',
              })
            }
          }}
        />
      </>
    )
  }
  if (waiting) {
    return (
      <>
        {live}
        <WaitingCard showView={showView} />
      </>
    )
  }
  return (
    <div className="shrink-0 border-t border-border bg-surface pb-safe ui-terminal:bg-bg">
      {live}
      {notice && (
        <Banner
          variant={notice.variant}
          action={notice.terminal && <OpenTerminalButton showView={showView} />}
        >
          {notice.text}
        </Banner>
      )}
      {tooLong && (
        <p id={limitId} className="px-3 pt-2 text-[12px] text-danger">
          {Math.ceil(bytes / 1024)} KB of {MAX_MESSAGE_BYTES / 1024} KB: shorten
          the message to send it.
        </p>
      )}
      <div className="flex items-end gap-2 p-2">
        <textarea
          aria-label="Message to Claude Code"
          aria-describedby={tooLong ? limitId : undefined}
          value={text}
          rows={rows}
          readOnly={sending}
          aria-busy={sending}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isMobile ? 'Message' : 'Message (Ctrl+Enter to send)'}
          className="min-h-touch min-w-0 flex-1 resize-none rounded-control border border-border bg-bg px-3 py-2 text-[15px] text-fg focus-visible:border-accent focus-visible:outline-none"
        />
        <IconButton
          aria-label="Send"
          variant="primary"
          disabled={!canSend}
          onClick={send}
        >
          <SendHorizontal size={18} aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  )
}
