import { ImagePlus, SendHorizontal } from 'lucide-react'
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ViewProps } from '../app-views'
import { agentLabel } from '../chat-agents'
import { useAgentCommands } from '../hooks/use-agent-commands'
import { useAgentPrompt } from '../hooks/use-agent-prompt'
import { useAgentTranscript } from '../hooks/use-agent-transcript'
import { useChatAttachments } from '../hooks/use-chat-attachments'
import { AgentRequestError, sendAgentMessage } from '../hooks/use-mux-api'
import { toAgentStatus } from '../types/session'
import { loadDraft, saveDraft } from '../utils/chat-draft'
import {
  BUILTIN_COMMANDS,
  commandOf,
  filterSlashCommands,
  mergeSlashCommands,
  type SlashCommand,
  slashQuery,
} from '../utils/slash-commands'
import { imageFromClipboard, pickImageFile } from '../utils/upload-image'
import { TERMINAL_VIEW_ID } from '../view-ids'
import { ChatAttachments } from './chat-attachments'
import { OpenTerminalButton } from './open-terminal-button'
import { PromptCard, WaitingCard } from './prompt-card'
import { SlashCommandList, slashOptionId } from './slash-command-list'
import { Banner, type BannerVariant } from './ui/banner'
import { IconButton } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'

// The server's limit on a message, in UTF-8 bytes.
export const MAX_MESSAGE_BYTES = 16 * 1024
const MAX_ROWS = 6

// An agent without built-ins: one array, so the merged list stays memoized
const NO_COMMANDS: SlashCommand[] = []

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
    case 'partial_paste':
      return {
        variant: 'danger',
        text: 'Not sent: the input box holds part of this message. Clear it in the terminal before sending again.',
        terminal: true,
      }
    case 'uploads_unavailable':
      return {
        variant: 'warning',
        text: 'Not sent: this server cannot take images.',
      }
    case 'invalid_request':
      if (err.images?.length) {
        return {
          variant: 'warning',
          text: 'Not sent: an image is no longer on the host. Remove it and attach it again.',
        }
      }
      return { variant: 'danger', text: `Not sent: ${err.message}.` }
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

export function ChatComposer({
  session,
  isMobile,
  showView,
  mux,
  readOnly,
}: ViewProps) {
  const paneId = session.paneId ?? ''
  const agent = agentLabel(session.agentName)
  const t = useAgentTranscript(session.paneId)
  const status = toAgentStatus(t.status)
  const p = useAgentPrompt(session.paneId, status)
  // Blocked with no dialog the server can read. Only once a dialog read came
  // back: before it, or as an answer settles, this would flash.
  const waiting = status === 'blocked' && p.loaded && !p.prompt
  const [text, setText] = useState(() => loadDraft(paneId))
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  // A message waiting for the user to confirm it (/exit)
  const [confirming, setConfirming] = useState<string | null>(null)
  const limitId = useId()
  const listId = useId()
  const boxRef = useRef<HTMLTextAreaElement>(null)
  // Images go to the host first; view-only sends nothing, so none either.
  const uploadsOn = !!mux.caps.uploads && !readOnly
  const showError = useCallback(
    (text: string) => setNotice({ variant: 'danger', text }),
    [],
  )
  const images = useChatAttachments(paneId, showError)
  // The pane and its images now: a tmux window move can change the pane's
  // id while a message is sending.
  const latest = useRef({ paneId, images })
  latest.current = { paneId, images }

  // Command suggestions: open while the message is only "/name", until
  // Escape; the highlighted row resets as the list changes.
  const query = slashQuery(text)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const listOpen = query !== null && !dismissed
  const custom = useAgentCommands(paneId, listOpen)
  const builtins = BUILTIN_COMMANDS[session.agentName ?? ''] ?? NO_COMMANDS
  const commands = useMemo(
    () => mergeSlashCommands(builtins, custom),
    [builtins, custom],
  )
  const matches = useMemo(
    () => (listOpen ? filterSlashCommands(commands, query) : []),
    [listOpen, commands, query],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query or list starts at the top
  useEffect(() => setActive(0), [query, matches.length])
  useEffect(() => {
    if (query === null) setDismissed(false)
  }, [query])

  // Each pane keeps its own draft.
  useEffect(() => {
    setText(loadDraft(paneId))
    setNotice(null)
    setConfirming(null)
  }, [paneId])

  const update = (value: string) => {
    setText(value)
    saveDraft(paneId, value)
  }

  const bytes = byteLength(text)
  const tooLong = bytes > MAX_MESSAGE_BYTES
  // Every image uploaded and none refused: a message never goes without one
  // the user attached.
  const canSend =
    !sending &&
    !!t.cursor &&
    (text.trim() !== '' || images.ids.length > 0) &&
    !tooLong &&
    !images.uploading &&
    !images.failed

  // Sends message (the composer's text, or a command picked from the list).
  // A command that ends the agent is confirmed first; one that opens an
  // interactive screen, sent without arguments, shows the terminal after.
  const submit = async (
    message: string,
    confirmed = false,
    imageIds: string[] = [],
  ) => {
    if (sending || !t.cursor) return
    // With images the agent receives "[Image #1] /cmd": text, not a command.
    const plain = imageIds.length > 0
    const cmd = plain ? undefined : commandOf(message, commands)
    if (cmd?.confirm && !confirmed) {
      setConfirming(message)
      return
    }
    // "!" runs the rest as a shell command in the agent.
    if (
      !plain &&
      message.trimStart().startsWith('!') &&
      !window.confirm(`Run this as a shell command in ${agent}?`)
    ) {
      return
    }
    setSending(true)
    setNotice(null)
    try {
      await sendAgentMessage(paneId, message, t.cursor, imageIds)
      setText('')
      saveDraft(latest.current.paneId, '')
      if (imageIds.length > 0) latest.current.images.clear()
      t.refresh()
      if (cmd?.terminal && message.trim() === `/${cmd.name}`) {
        showView(TERMINAL_VIEW_ID)
      }
    } catch (err) {
      setNotice(noticeFor(err))
      if (err instanceof AgentRequestError && err.code === 'session_changed') {
        t.refresh()
      }
      if (err instanceof AgentRequestError && err.images?.length) {
        images.markGone(err.images)
      }
    } finally {
      setSending(false)
    }
  }

  const send = () => {
    if (canSend) submit(text, false, images.ids)
  }

  const attach = async () => {
    const file = await pickImageFile()
    if (file) await images.add(file)
  }

  // An image pasted without text is attached; text pasted as usual.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!uploadsOn || sending) return
    const file = imageFromClipboard(e.clipboardData)
    if (!file) return
    e.preventDefault()
    images.add(file)
  }

  // A picked command is typed in for its arguments; one that opens an
  // interactive screen or ends the agent is sent right away (after asking).
  const pick = (c: SlashCommand) => {
    if (c.terminal || c.confirm) {
      submit(`/${c.name}`)
      return
    }
    const value = `/${c.name} `
    update(value)
    const box = boxRef.current
    box?.focus()
    // After React writes the value, unless typing already began: a late frame
    // would pull the caret back into the middle of what was typed
    requestAnimationFrame(() => {
      if (box?.value === value)
        box.setSelectionRange(value.length, value.length)
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (listOpen && matches.length > 0 && !e.ctrlKey && !e.metaKey) {
      const n = matches.length
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActive((i) => (i + 1) % n)
          return
        case 'ArrowUp':
          e.preventDefault()
          setActive((i) => (i - 1 + n) % n)
          return
        case 'Enter':
        case 'Tab':
          if (e.shiftKey) break
          e.preventDefault()
          pick(matches[Math.min(active, n - 1)])
          return
      }
    }
    if (listOpen && e.key === 'Escape') {
      e.preventDefault()
      setDismissed(true)
      return
    }
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
      ? `${agent} asks: ${p.prompt.title || 'a question'}`
      : waiting
        ? `${agent} is waiting for you in the terminal.`
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
          agentName={session.agentName}
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
        <WaitingCard agentName={session.agentName} showView={showView} />
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
      <ConfirmDialog
        isOpen={confirming !== null}
        title={`Exit ${agent}?`}
        confirmLabel="Exit"
        destructive
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null)
          // Only open while a message waits
          submit(confirming as string, true)
        }}
      >
        This ends the agent in this pane; the app goes back to the terminal.
      </ConfirmDialog>
      {listOpen && (
        <SlashCommandList
          id={listId}
          commands={matches}
          active={active}
          onActive={setActive}
          onPick={pick}
        />
      )}
      {tooLong && (
        <p id={limitId} className="px-3 pt-2 text-[12px] text-danger">
          {Math.ceil(bytes / 1024)} KB of {MAX_MESSAGE_BYTES / 1024} KB: shorten
          the message to send it.
        </p>
      )}
      <ChatAttachments
        items={images.items}
        onRemove={images.remove}
        disabled={sending}
      />
      <div className="flex items-end gap-2 p-2">
        {uploadsOn && (
          <IconButton
            aria-label="Attach image"
            disabled={sending || images.full}
            onClick={attach}
          >
            <ImagePlus size={18} aria-hidden="true" />
          </IconButton>
        )}
        <textarea
          ref={boxRef}
          aria-label={`Message to ${agent}`}
          aria-describedby={tooLong ? limitId : undefined}
          aria-autocomplete="list"
          aria-controls={listOpen && matches.length > 0 ? listId : undefined}
          aria-activedescendant={
            listOpen && matches.length > 0
              ? slashOptionId(listId, Math.min(active, matches.length - 1))
              : undefined
          }
          value={text}
          rows={rows}
          readOnly={sending}
          aria-busy={sending}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
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
