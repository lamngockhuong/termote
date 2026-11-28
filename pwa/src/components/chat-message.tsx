import { BookOpen, ChevronRight, ImageIcon, SquareSlash } from 'lucide-react'
import {
  type ComponentProps,
  createContext,
  memo,
  type ReactNode,
  useContext,
  useState,
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TranscriptEntry, TranscriptPart } from '../hooks/use-mux-api'
import { formatDateTime, formatTime } from '../i18n/format'
import { useT } from '../i18n/i18n-context'
import { fileRefFromHref, parseFileRef } from '../utils/chat-file-links'
import { rehypeMermaidIndex } from '../utils/markdown-links'
import { htmlAsText, safeUrl } from '../utils/markdown-safety'
import { exportName } from '../utils/mermaid-export'
import { commandDescription, type SlashCommand } from '../utils/slash-commands'
import { userMessageTokens } from '../utils/user-message-tokens'
import { CopyButton } from './chat-copy-button'
import { FileRef } from './chat-file-link'
import { ChatImageContext } from './chat-image-viewer'
import { STEP_ROW, ToolCard, ToolStep, toolDot } from './chat-tool-card'
import { CodeFence } from './fenced-code'

// One entry of an agent's transcript. Agent text is untrusted (a prompt
// injection can write anything), so markdown is rendered without raw HTML,
// links open only for http(s), and images never load: an image URL can carry
// data out without a click. A relative link, or inline code that names a
// file, opens that file in the Files view, where the server checks it like
// any other.

// Inside a link: its inline code is not a link of its own
const InLink = createContext(false)

function MdLink({ href, children }: ComponentProps<'a'>) {
  const u = safeUrl(href)
  if (!u) {
    const file = fileRefFromHref(href)
    if (!file) return <span>{children}</span>
    return (
      <FileRef
        path={file.path}
        line={file.line}
        marks={file.marks}
        className="inline"
      >
        <InLink.Provider value>{children}</InLink.Provider>
      </FileRef>
    )
  }
  return (
    <a
      href={href}
      // The text of a link can name another host than it goes to.
      title={u.host}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline underline-offset-2"
    >
      <InLink.Provider value>{children}</InLink.Provider>
    </a>
  )
}

function MdImage({ src, alt }: ComponentProps<'img'>) {
  const inLink = useContext(InLink)
  const { t } = useT()
  const u = safeUrl(src)
  const label = t('chat.message.image', {
    where: u ? u.host : alt || t('chat.message.imageUnavailable'),
  })
  // Inside a link, a link of its own would take the click too
  if (!u || inLink) return <span className="text-fg-muted">[{label}]</span>
  return (
    <a
      href={u.href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-accent underline underline-offset-2"
    >
      <ImageIcon size={13} aria-hidden="true" />
      {label}
    </a>
  )
}

// What a message's code blocks need from the Chat view around it: where the
// list scrolls (a diagram is drawn once near it) and its notices
export const ChatMarkdownContext = createContext<{
  scrollRoot: () => Element | null
  notify: (message: string) => void
}>({ scrollRoot: () => null, notify: () => {} })

// A code block, or a Mermaid diagram. Copy reports on the button itself.
function MdPre({ node }: { node?: unknown }) {
  const { scrollRoot, notify } = useContext(ChatMarkdownContext)
  const { t } = useT()
  return (
    <CodeFence
      node={node}
      wrap={false}
      notify={notify}
      scrollRoot={scrollRoot}
      exportName={(index) => exportName('chat', index)}
      copyButton={(text) => (
        <CopyButton text={() => text} label={t('chat.message.copyCode')} />
      )}
    />
  )
}

// Inline code; a code block is MdPre's
function MdCode({ children }: ComponentProps<'code'>) {
  const inLink = useContext(InLink)
  const file =
    !inLink && typeof children === 'string' ? parseFileRef(children) : null
  if (!file) return <code>{children}</code>
  return (
    <FileRef
      path={file.path}
      line={file.line}
      marks={file.marks}
      className="inline"
    >
      <code>{children}</code>
    </FileRef>
  )
}

const MD_COMPONENTS = { a: MdLink, img: MdImage, pre: MdPre, code: MdCode }

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words leading-relaxed [&_:not(pre)>code]:rounded [&_:not(pre)>code]:box-decoration-clone [&_:not(pre)>code]:border [&_:not(pre)>code]:border-border [&_:not(pre)>code]:bg-surface-raised [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.88em] [&_h1]:mt-3 [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_li]:ml-5 [&_li+li]:mt-1 [&_ol]:my-2 [&_ol]:list-decimal [&_p+p]:mt-2 [&_ul]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_th]:border [&_th]:border-border [&_th]:px-1.5 [&_ul]:list-disc">
      <Markdown
        remarkPlugins={[remarkGfm, htmlAsText]}
        rehypePlugins={[rehypeMermaidIndex]}
        components={MD_COMPONENTS}
      >
        {text}
      </Markdown>
    </div>
  )
}

function Clipped({ show }: { show?: boolean }) {
  const { t } = useT()
  if (!show) return null
  return (
    <p className="mt-1 text-[12px] text-fg-subtle">
      {t('chat.message.shortened')}
    </p>
  )
}

function Disclosure({
  summary,
  children,
}: {
  summary: ReactNode
  children?: ReactNode
}) {
  return (
    <details className="group rounded-control border border-border bg-surface text-[13px]">
      <summary className="flex min-h-touch cursor-pointer list-none items-center gap-1.5 px-2 text-fg-muted [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        {summary}
      </summary>
      <div className="border-t border-border px-2 py-1.5">{children}</div>
    </details>
  )
}

// The number each image part of an entry shows, so a reader can tell which
// image the text's "[Image #N]" means. The agent's own numbers when the text
// names one per image (Claude Code keeps counting across a session), else
// the order in the entry when there is more than one image.
export function imageNumbers(parts: TranscriptPart[]): (number | undefined)[] {
  const tokens = parts.flatMap((p) =>
    p.kind === 'text' && p.text
      ? [...p.text.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1]))
      : [],
  )
  const count = parts.filter((p) => p.kind === 'image').length
  let i = 0
  return parts.map((p) => {
    if (p.kind !== 'image') return undefined
    const n = i++
    if (tokens.length === count) return tokens[n]
    return count > 1 ? n + 1 : undefined
  })
}

function ImageChip({ src, n }: { src?: string; n?: number }) {
  const { t } = useT()
  const open = useContext(ChatImageContext)
  const label =
    n === undefined
      ? t('chat.message.imageChip')
      : t('chat.message.imageChipNumbered', { n: String(n) })
  if (!src || !open) {
    return (
      <span className="inline-flex items-center gap-1 text-fg-muted">
        <ImageIcon size={13} aria-hidden="true" />
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      title={t('chat.message.imageOpen')}
      onClick={() => open(src)}
      className="inline-flex cursor-pointer items-center gap-1 text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      <ImageIcon size={13} aria-hidden="true" />
      {label}
    </button>
  )
}

// The commands and skills the pane's agent knows, each after its trigger:
// a user message names one as a chip. None outside the Chat view.
export const ChatCommandsContext = createContext<SlashCommand[]>([])

// What the user typed, as typed (never markdown), its links opening in a new
// tab and the commands and skills it names shown as chips
export function UserText({ text }: { text: string }) {
  const commands = useContext(ChatCommandsContext)
  const { t } = useT()
  return (
    <p className="whitespace-pre-wrap break-words">
      {userMessageTokens(text, commands).map((tok, i) => {
        if (tok.kind === 'link') {
          return (
            <a
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one text
              key={i}
              href={tok.href}
              // The text of a link can name another host than it goes to.
              title={new URL(tok.href).host}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 [overflow-wrap:anywhere]"
            >
              {tok.text}
            </a>
          )
        }
        if (tok.kind === 'command') {
          const Icon = tok.command.kind === 'skill' ? BookOpen : SquareSlash
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one text
              key={i}
              data-command={tok.text}
              title={commandDescription(tok.command, t)}
              className="inline-flex items-center gap-1 rounded border border-border bg-surface-raised px-1.5 align-baseline font-mono text-[0.9em]"
            >
              <Icon size={12} aria-hidden="true" className="shrink-0" />
              {tok.text}
            </span>
          )
        }
        return tok.text
      })}
    </p>
  )
}

function Part({
  part,
  n,
  steps,
}: {
  part: TranscriptPart
  n?: number
  steps?: boolean
}) {
  const { t } = useT()
  switch (part.kind) {
    case 'tool':
      return <ToolStep part={part} steps={steps} />
    case 'image':
      return <ImageChip src={part.image} n={n} />
    case 'thinking':
      if (steps) return <StepThinking part={part} />
      return (
        <Disclosure summary={t('chat.message.thinking')}>
          <p className="whitespace-pre-wrap text-fg-muted">{part.text}</p>
          <Clipped show={part.clipped} />
        </Disclosure>
      )
    default:
      return (
        <>
          <MarkdownText text={part.text ?? ''} />
          <Clipped show={part.clipped} />
        </>
      )
  }
}

// Thinking among the lines of a run: a line of its own, its text under it
function StepThinking({ part }: { part: TranscriptPart }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={STEP_ROW}
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="min-w-0 truncate">{t('chat.message.thinking')}</span>
      </button>
      {open && (
        <div className="pb-2 pl-5 text-[12px]">
          <p className="whitespace-pre-wrap text-fg-muted">{part.text}</p>
          <Clipped show={part.clipped} />
        </div>
      )}
    </div>
  )
}

// One step of the agent's side, on a line down the left: a dot coloured by
// what the step is (a tool by how it ended), and the line on to the next
// step when there is one. A line of an open run has no dot of its own (the
// run's header has it), its line drawn from its top. row: the dot centred
// on a 28px line (a run's header).
export function Step({
  dot,
  line,
  row,
  children,
}: {
  dot?: string
  line: boolean
  row?: boolean
  children: ReactNode
}) {
  return (
    <div className="relative min-w-0 pl-5">
      {dot && (
        <span
          aria-hidden="true"
          className={`absolute ${row ? 'top-[10.5px]' : 'top-[7px]'} left-0 size-[7px] rounded-full ${dot}`}
        />
      )}
      {line && (
        <span
          aria-hidden="true"
          className={`absolute ${!dot ? 'top-0' : row ? 'top-[21.5px]' : 'top-[18px]'} -bottom-3 left-[3px] w-px bg-border`}
        />
      )}
      {children}
    </div>
  )
}

// With a mouse a message's time and copy button wait for a hover or focus
// on it; a touch screen has no hover, so there they always show
export const REVEAL =
  'opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 pointer-coarse:opacity-100'

export function Time({
  ts,
  className = '',
}: {
  ts?: string
  className?: string
}) {
  const { locale } = useT()
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return (
    <time
      dateTime={ts}
      title={formatDateTime(d, locale)}
      className={`text-[11px] text-fg-subtle ${className}`}
    >
      {formatTime(d, locale)}
    </time>
  )
}

// Whose side an entry is on. A user row holding only tool results (whose
// calls are not in this read) is the agent's.
export function chatSide(entry: TranscriptEntry): 'user' | 'agent' | 'other' {
  if (entry.role === 'user') {
    return entry.parts.some((p) => p.kind !== 'tool') ? 'user' : 'agent'
  }
  return entry.role === 'assistant' ? 'agent' : 'other'
}

// Memoised: a poll that brings new entries leaves the others (and their
// parsed markdown) alone. showTime: the entry starts a run of its own;
// joinsNext: the agent's next entry follows, so the line goes on. A
// message with text has its time and a copy button under it (beside it, the
// reader's own; at the right, taking no room, when the agent goes on), shown
// on hover with a mouse; a touch screen shows them at the end of a turn, the
// time only where showTime asks for it. className: motion
// on its root (a message that just came in). steps: the entry is in an open
// run, each tool call a line. data-run-entry, on an entry of steps only: the
// list keeps a run open once the reader pressed or focused inside one of
// its entries, before the run formed too.
export const ChatMessage = memo(function ChatMessage({
  entry,
  showTime,
  joinsNext,
  steps,
  className = '',
}: {
  entry: TranscriptEntry
  showTime?: boolean
  joinsNext?: boolean
  steps?: boolean
  className?: string
}) {
  const { t } = useT()
  if (entry.role === 'summary') {
    return (
      <div
        data-role="summary"
        className={`my-2 flex items-center gap-2 ${className}`}
      >
        <span className="h-px flex-1 bg-border" />
        <Disclosure summary={t('chat.message.compacted')}>
          <p className="whitespace-pre-wrap text-fg-muted">
            {entry.parts.map((p) => p.text).join('\n')}
          </p>
        </Disclosure>
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }
  if (entry.role === 'note') {
    return (
      <div className={`pl-5 text-[12px] text-fg-subtle italic ${className}`}>
        {entry.parts.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
          <p key={i} className="whitespace-pre-wrap">
            {p.clipped && !p.text ? t('chat.message.lineTooLarge') : p.text}
          </p>
        ))}
      </div>
    )
  }
  const user = chatSide(entry) === 'user'
  const numbers = imageNumbers(entry.parts)
  // A touch screen shows the time only where a run starts
  const timeTouch = showTime ? '' : 'pointer-coarse:hidden'
  if (user) {
    const said = entry.parts
      .filter((p) => p.kind === 'text' && p.text)
      .map((p) => p.text)
      .join('\n\n')
    return (
      // The reader's own messages sit on the right, as wide as their text up
      // to 85% of the column, the time and copy button on their left
      <div
        data-role="user"
        className={`group/msg flex items-end justify-end gap-2 ${className}`}
      >
        <div className={`flex shrink-0 items-center gap-1 ${REVEAL}`}>
          <Time ts={entry.ts} className={timeTouch} />
          {said && (
            // Not on a touch screen: always shown there, beside every
            // message of the reader's own
            <CopyButton
              text={() => said}
              label={t('chat.message.copyMessage')}
              className="pointer-coarse:hidden"
            />
          )}
        </div>
        <div className="w-fit min-w-0 max-w-[85%] space-y-1.5 rounded-control border border-border bg-surface px-3 py-2">
          {entry.parts.map((part, i) =>
            part.kind === 'image' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
              <ImageChip key={i} src={part.image} n={numbers[i]} />
            ) : part.kind === 'tool' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
              <ToolCard key={i} part={part} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
              <UserText key={i} text={part.text ?? ''} />
            ),
          )}
        </div>
      </div>
    )
  }
  const last = entry.parts.length - 1
  const onlySteps = entry.parts.every(
    (p) => p.kind === 'tool' || p.kind === 'thinking',
  )
  const answer = entry.parts
    .filter((p) => p.kind === 'text' && p.text)
    .map((p) => p.text)
    .join('\n\n')
  return (
    // In an open run its lines sit flush, with no dot of their own
    <div
      data-role={entry.role}
      data-run-entry={onlySteps ? entry.id : undefined}
      className={`group/msg relative flex flex-col ${steps ? '' : 'gap-3'} ${className}`}
    >
      {!answer && showTime && (
        <Time ts={entry.ts} className={`self-end ${REVEAL}`} />
      )}
      {answer && joinsNext && showTime && (
        // Where a touch screen shows the time of a message the agent goes
        // on from: it has no row of its own there
        <Time ts={entry.ts} className="hidden self-end pointer-coarse:inline" />
      )}
      {entry.parts.map((part, i) => (
        <Step
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
          key={i}
          dot={
            steps
              ? undefined
              : part.kind === 'tool'
                ? toolDot(part)
                : 'bg-fg-subtle'
          }
          line={i < last || !!joinsNext}
        >
          <Part part={part} n={numbers[i]} steps={steps} />
        </Step>
      ))}
      {answer && !joinsNext && (
        <div className={`-mt-2 flex items-center gap-1 pl-4 ${REVEAL}`}>
          <CopyButton
            text={() => answer}
            label={t('chat.message.copyAnswer')}
          />
          <Time ts={entry.ts} className={timeTouch} />
        </div>
      )}
      {answer && joinsNext && (
        // The agent goes on: the row takes no room, at the right under the
        // message, over the start of the next entry (a run's short line).
        // Above that entry (its row is positioned too, and comes later), or
        // the pointer on the way to the button would leave the message.
        // Unseen it lets clicks through to that entry; a touch screen does
        // not have it, as the row would always show there
        <div
          className={`pointer-events-none absolute top-full right-0 z-10 flex items-center gap-1 pt-2 group-focus-within/msg:pointer-events-auto group-hover/msg:pointer-events-auto pointer-coarse:hidden ${REVEAL}`}
        >
          <Time ts={entry.ts} />
          <CopyButton
            text={() => answer}
            label={t('chat.message.copyAnswer')}
          />
        </div>
      )}
    </div>
  )
})
