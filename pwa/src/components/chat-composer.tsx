import { FileText, ImagePlus, SendHorizontal } from 'lucide-react'
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
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
import {
  AgentRequestError,
  type PromptTemplate,
  sendAgentMessage,
} from '../hooks/use-mux-api'
import { usePromptTemplates } from '../hooks/use-prompt-templates'
import { toAgentStatus } from '../types/session'
import {
  isTextInsert,
  loadDraft,
  onDraftInsert,
  saveDraft,
  takeDraftInsert,
} from '../utils/chat-draft'
import {
  imageTokensIn,
  insertImageToken,
  messageWithImages,
  removeImageToken,
} from '../utils/chat-image-tokens'
import { matchTemplates } from '../utils/prompt-templates'
import {
  applyPick,
  BUILTIN_COMMANDS,
  COMMAND_ALIASES,
  CUSTOM_TRIGGER,
  closeTrailingSkill,
  commandOf,
  commandQuery,
  filterSlashCommands,
  mergeSlashCommands,
  type SlashCommand,
} from '../utils/slash-commands'
import { requestTemplateFill } from '../utils/template-fill-request'
import { imageFromClipboard, pickImageFile } from '../utils/upload-image'
import { TERMINAL_VIEW_ID } from '../view-ids'
import { ChatAttachments } from './chat-attachments'
import { OpenTerminalButton } from './open-terminal-button'
import { PromptCard, WaitingCard } from './prompt-card'
import { SlashCommandList, slashOptionId } from './slash-command-list'
import { TemplatePicker } from './template-picker'
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
  openSettings,
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
  const hintId = useId()
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

  // Command suggestions: open while the message is only "/name" or, for an
  // agent whose skills follow "$", while the caret ends a "$name" word; until
  // Escape. The highlighted row resets as the list changes.
  const agentName = session.agentName ?? ''
  const trigger = CUSTOM_TRIGGER[agentName] ?? '/'
  const dollar = trigger === '$'
  // The caret, null while text is selected: followed for every agent, so it
  // is current when the pane's agent changes to one using "$"
  const [caret, setCaret] = useState<number | null>(() => text.length)
  const q = commandQuery(text, caret, dollar)
  const query = q?.query ?? null
  // The word being typed: another one opens the list again after Escape
  const word = q ? `${q.trigger}${q.start}` : null
  const [dismissed, setDismissed] = useState(false)
  const listOpen = q !== null && !dismissed
  const custom = useAgentCommands(paneId, listOpen && q?.trigger === trigger)
  const builtins = BUILTIN_COMMANDS[agentName] ?? NO_COMMANDS
  const commands = useMemo(
    () =>
      mergeSlashCommands(
        builtins,
        custom.map((c) => ({ ...c, trigger })),
      ),
    [builtins, custom, trigger],
  )
  const listTrigger = q?.trigger ?? '/'
  // Prompt templates, after the commands in the "/" list (never highlighted
  // first, so Enter does what it did) and behind the Templates button
  const templatesOn = !!mux.caps.templates
  const prompts = usePromptTemplates()
  const [pickerOpen, setPickerOpen] = useState(false)
  // The template picked, asked for once the picker is gone: its text, or
  // the fill dialog, would else open while the picker's modal makes the
  // message box unfocusable
  const picked = useRef<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the picker closes, with the pane and agent of that render
  useEffect(() => {
    const id = picked.current
    if (pickerOpen || id === null) return
    picked.current = null
    requestTemplateFill({ paneId, templateId: id, agent: session.agentName })
  }, [pickerOpen])
  const slashTemplates = listOpen && listTrigger === '/' && templatesOn
  const { refresh: refreshPrompts } = prompts
  useEffect(() => {
    if (slashTemplates) void refreshPrompts()
  }, [slashTemplates, refreshPrompts])
  const templateMatches = useMemo(
    () =>
      slashTemplates && query !== null
        ? matchTemplates(prompts.templates, query)
        : [],
    [slashTemplates, prompts.templates, query],
  )
  const matches = useMemo(
    () =>
      listOpen && query !== null
        ? filterSlashCommands(
            commands.filter((c) => (c.trigger ?? '/') === listTrigger),
            query,
          )
        : [],
    [listOpen, commands, query, listTrigger],
  )
  // Every row of the list: the commands, then the templates
  const listRows = matches.length + templateMatches.length
  // The highlighted row (-1: none): the one the arrows or the pointer chose
  // in this very list, else the first command. With no command nothing is,
  // so Enter does what it did; a new query or list starts again.
  const listKey = `${query}\n${matches.length}\n${templateMatches.length}`
  const [chosen, setChosen] = useState<{ key: string; i: number } | null>(null)
  const at =
    chosen?.key === listKey
      ? Math.min(chosen.i, listRows - 1)
      : matches.length
        ? 0
        : -1
  const setActive = (i: number) => setChosen({ key: listKey, i })
  // biome-ignore lint/correctness/useExhaustiveDependencies: Escape holds for one word
  useEffect(() => setDismissed(false), [word])

  // The draft as the effects below see it: the pane's own right after a
  // move to another pane, before that render
  const textRef = useRef(text)
  textRef.current = text
  // Each pane keeps its own draft.
  useEffect(() => {
    const draft = loadDraft(paneId)
    textRef.current = draft
    setText(draft)
    setCaret(draft.length)
    setNotice(null)
    setConfirming(null)
  }, [paneId])

  // The pane now: an image picked while the pane moved goes to its draft
  const update = (value: string) => {
    const { paneId, images } = latest.current
    setText(value)
    saveDraft(paneId, value)
    // An image goes with its token: deleting "[Image #n]" removes it
    const kept = imageTokensIn(value)
    for (const a of images.items) if (!kept.has(a.n)) images.remove(a.key)
  }

  // Follows the caret from the event itself: a phone keyboard can report it
  // a frame late through a ref read after rendering.
  const track = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const { selectionStart, selectionEnd } = e.currentTarget
    setCaret(selectionStart === selectionEnd ? selectionStart : null)
  }

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    update(e.target.value)
    track(e)
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
    imageAt: number[] = [],
  ) => {
    if (sending || !t.cursor) return
    // With images the agent receives "[Image #1] /cmd": text, not a command.
    const plain = imageIds.length > 0
    const cmd = plain
      ? undefined
      : commandOf(message, commands, COMMAND_ALIASES[agentName])
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
      const { queued } = await sendAgentMessage(
        paneId,
        message,
        t.cursor,
        imageIds,
        imageAt,
      )
      if (queued) {
        setNotice({
          variant: 'info',
          text: `Queued: ${agent} reads it when it is ready.`,
        })
      }
      setText('')
      setCaret(0)
      saveDraft(latest.current.paneId, '')
      if (imageIds.length > 0) latest.current.images.clear()
      t.refresh()
      // A queued command opens its screen only after the turn: stay here
      if (!queued && cmd?.terminal && message.trim() === `/${cmd.name}`) {
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
    if (!canSend) return
    const m = messageWithImages(
      dollar ? closeTrailingSkill(text) : text,
      images.ready,
    )
    submit(m.text, false, m.ids, m.at)
  }

  // An image attached goes where the caret is, as its "[Image #n]" token
  // (at the end before the box was ever focused), the caret after it.
  const attachImage = (file: File) => {
    const draft = textRef.current
    const added = latest.current.images.add(file, imageTokensIn(draft))
    if (!added) return
    const box = boxRef.current
    const [start, end] =
      box && focusedOnce.current
        ? [box.selectionStart, box.selectionEnd]
        : [draft.length, draft.length]
    const next = insertImageToken(draft, start, end, added.n)
    caretAfterPick.current = next
    textRef.current = next.text
    update(next.text)
    setCaret(next.caret)
    return added.done
  }

  const attach = async () => {
    const file = await pickImageFile()
    if (file) await attachImage(file)
  }

  // An image pasted without text is attached; text pasted as usual.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!uploadsOn || sending) return
    const file = imageFromClipboard(e.clipboardData)
    if (!file) return
    e.preventDefault()
    attachImage(file)
  }

  // An image removed takes its token out of the text.
  const removeImage = (key: number) => {
    for (const a of images.items) {
      if (a.key === key) update(removeImageToken(textRef.current, a.n))
    }
    images.remove(key)
  }

  // The caret after a pick, set in the commit that writes the picked text:
  // a frame later, typing or a select-all could already have begun, and the
  // caret moved then would split what is typed.
  // A pick that changed nothing renders nothing: the next render (typing
  // elsewhere) finds other text and leaves the caret where it is.
  const caretAfterPick = useRef<{ text: string; caret: number } | null>(null)
  useLayoutEffect(() => {
    const want = caretAfterPick.current
    const box = boxRef.current
    if (!want || !box) return
    caretAfterPick.current = null
    if (box.value === want.text) box.setSelectionRange(want.caret, want.caret)
  })

  // The box was focused once on this page: its selection is where the user
  // left the caret, read when text is put in
  const focusedOnce = useRef(false)
  const agentRef = useRef(session.agentName)
  agentRef.current = session.agentName

  // A command picked in the command palette goes in front of the draft, the
  // caret after it, nothing sent; the palette's Show Chat only focuses. A
  // filled template goes where the caret was (or in place of the "/name" it
  // was picked with, or at the end), nothing sent either.
  // biome-ignore lint/correctness/useExhaustiveDependencies: update and the refs read the latest state
  useEffect(() => {
    const take = () => {
      const c = takeDraftInsert(paneId, agentRef.current)
      if (c === undefined) return
      if (isTextInsert(c)) {
        const draft = textRef.current
        const box = boxRef.current
        const [start, end] =
          c.at && draft.slice(c.at.start, c.at.end) === c.at.was
            ? [c.at.start, c.at.end]
            : box && focusedOnce.current
              ? [box.selectionStart, box.selectionEnd]
              : [draft.length, draft.length]
        const next = {
          text: draft.slice(0, start) + c.text + draft.slice(end),
          caret: start + c.text.length,
        }
        caretAfterPick.current = next
        textRef.current = next.text
        update(next.text)
        setCaret(next.caret)
      } else if (c) {
        const at = { trigger: c.trigger ?? '/', query: '', start: 0, end: 0 }
        const next = applyPick(textRef.current, at, c)
        caretAfterPick.current = next
        textRef.current = next.text
        update(next.text)
        setCaret(next.caret)
      }
      boxRef.current?.focus()
    }
    take()
    return onDraftInsert(take)
  }, [paneId])

  // A picked command is typed in for its arguments, a picked skill in place
  // of the word being typed; a command that opens an interactive screen or
  // ends the agent is sent right away (after asking).
  const pick = (c: SlashCommand) => {
    if (c.terminal || c.confirm) {
      submit(`/${c.name}`)
      return
    }
    // Only called from the open list, which has a query
    const next = applyPick(text, q as NonNullable<typeof q>, c)
    caretAfterPick.current = next
    update(next.text)
    setCaret(next.caret)
    boxRef.current?.focus()
  }

  // A template picked in the "/" list: its text replaces the "/name" once
  // filled in (Cancel leaves the draft as it is)
  const pickTemplate = (t: PromptTemplate) => {
    const typed = q as NonNullable<typeof q>
    setDismissed(true)
    requestTemplateFill({
      paneId,
      templateId: t.id,
      agent: session.agentName,
      at: {
        start: typed.start,
        end: typed.end,
        was: text.slice(typed.start, typed.end),
      },
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (listOpen && listRows > 0 && !e.ctrlKey && !e.metaKey) {
      const n = listRows
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActive(at < 0 ? 0 : (at + 1) % n)
          return
        case 'ArrowUp':
          e.preventDefault()
          setActive(at < 0 ? n - 1 : (at - 1 + n) % n)
          return
        case 'Enter':
        case 'Tab':
          if (e.shiftKey || at < 0) break
          e.preventDefault()
          if (at < matches.length) pick(matches[at])
          else pickTemplate(templateMatches[at - matches.length])
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
  const extras = (
    <>
      {uploadsOn && (
        <IconButton
          aria-label="Attach image"
          disabled={sending || images.full}
          onClick={attach}
        >
          <ImagePlus size={18} aria-hidden="true" />
        </IconButton>
      )}
      {templatesOn && (
        <IconButton
          aria-label="Templates"
          aria-haspopup="dialog"
          disabled={sending}
          onClick={() => setPickerOpen(true)}
        >
          <FileText size={18} aria-hidden="true" />
        </IconButton>
      )}
    </>
  )
  const box = (
    <textarea
      ref={boxRef}
      aria-label={`Message to ${agent}`}
      aria-describedby={
        [!isMobile && hintId, tooLong && limitId].filter(Boolean).join(' ') ||
        undefined
      }
      aria-autocomplete="list"
      aria-controls={listOpen && listRows > 0 ? listId : undefined}
      aria-activedescendant={
        listOpen && at >= 0 ? slashOptionId(listId, at) : undefined
      }
      value={text}
      rows={rows}
      readOnly={sending}
      aria-busy={sending}
      onChange={onChange}
      onSelect={track}
      onFocus={() => {
        focusedOnce.current = true
      }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      placeholder="Message"
      className="block w-full min-w-0 resize-none border-0 bg-transparent px-3 pt-2.5 pb-1 text-[15px] text-fg placeholder:text-fg-subtle focus:outline-hidden"
    />
  )
  const sendButton = (
    <IconButton
      aria-label="Send"
      variant="primary"
      disabled={!canSend}
      onClick={send}
    >
      <SendHorizontal size={18} aria-hidden="true" />
    </IconButton>
  )
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
      <TemplatePicker
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(t) => {
          picked.current = t.id
          setPickerOpen(false)
        }}
        onManage={
          openSettings &&
          (() => {
            setPickerOpen(false)
            openSettings('templates')
          })
        }
      />
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
          trigger={listTrigger}
          commands={matches}
          templates={templateMatches}
          active={at}
          onActive={setActive}
          onPick={pick}
          onPickTemplate={pickTemplate}
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
        onRemove={removeImage}
        disabled={sending}
      />
      {/* One card: the box over a row of its buttons, so the text keeps the
          whole width and the buttons stay at the bottom as it grows. The card
          draws the box's focus ring; a tap on its empty space focuses the box (a pointer shortcut
          only: the box and every button are reachable by keyboard). */}
      <div
        onPointerDown={(e) => {
          if ((e.target as Element).closest('button, textarea')) return
          e.preventDefault()
          boxRef.current?.focus()
        }}
        className="m-2 flex cursor-text flex-col rounded-panel border border-border-strong bg-surface-raised focus-within:border-accent has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-accent ui-terminal:bg-bg"
      >
        {box}
        <div
          data-testid="composer-actions"
          className="flex items-center gap-1 px-1 pb-1"
        >
          {extras}
          <div className="ml-auto flex items-center gap-2">
            {!isMobile && (
              <span
                id={hintId}
                className="whitespace-nowrap text-[12px] text-fg-subtle"
              >
                Ctrl+Enter to send
              </span>
            )}
            {sendButton}
          </div>
        </div>
      </div>
    </div>
  )
}
