import { ChevronRight, ImageIcon } from 'lucide-react'
import {
  type ComponentProps,
  createContext,
  memo,
  type ReactNode,
  useContext,
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
import { CopyButton } from './chat-copy-button'
import { FileRef } from './chat-file-link'
import { ToolCard, toolDot } from './chat-tool-card'
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
      <FileRef path={file.path} line={file.line} className="inline">
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
    <FileRef path={file.path} line={file.line} className="inline">
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

function ImageChip() {
  const { t } = useT()
  return (
    <span className="inline-flex items-center gap-1 text-fg-muted">
      <ImageIcon size={13} aria-hidden="true" />
      {t('chat.message.imageChip')}
    </span>
  )
}

function Part({ part }: { part: TranscriptPart }) {
  const { t } = useT()
  switch (part.kind) {
    case 'tool':
      return <ToolCard part={part} />
    case 'image':
      return <ImageChip />
    case 'thinking':
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

// One step of the agent's side, on a line down the left: a dot coloured by
// what the step is (a tool by how it ended), and the line on to the next
// step when there is one.
export function Step({
  dot,
  line,
  children,
}: {
  dot: string
  line: boolean
  children: ReactNode
}) {
  return (
    <div className="relative min-w-0 pl-5">
      <span
        aria-hidden="true"
        className={`absolute top-[7px] left-0 size-[7px] rounded-full ${dot}`}
      />
      {line && (
        <span
          aria-hidden="true"
          className="absolute top-[18px] -bottom-3 left-[3px] w-px bg-border"
        />
      )}
      {children}
    </div>
  )
}

export function Time({ ts }: { ts?: string }) {
  const { locale } = useT()
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return (
    <time
      dateTime={ts}
      title={formatDateTime(d, locale)}
      className="self-end text-[11px] text-fg-subtle"
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
// joinsNext: the agent's next entry follows, so the line goes on; at the
// end of a turn the answer gets a copy button instead.
export const ChatMessage = memo(function ChatMessage({
  entry,
  showTime,
  joinsNext,
}: {
  entry: TranscriptEntry
  showTime?: boolean
  joinsNext?: boolean
}) {
  const { t } = useT()
  if (entry.role === 'summary') {
    return (
      <div data-role="summary" className="my-2 flex items-center gap-2">
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
      <div className="pl-5 text-[12px] text-fg-subtle italic">
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
  const time = showTime && <Time ts={entry.ts} />
  if (user) {
    return (
      // The reader's own messages sit on the right, as wide as their text up
      // to 85% of the column
      <div data-role="user" className="flex flex-col items-end gap-1">
        {time}
        <div className="w-fit min-w-0 max-w-[85%] space-y-1.5 rounded-control border border-border bg-surface px-3 py-2">
          {entry.parts.map((part, i) =>
            part.kind === 'image' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
              <ImageChip key={i} />
            ) : part.kind === 'tool' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
              <ToolCard key={i} part={part} />
            ) : (
              <p
                // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
                key={i}
                className="whitespace-pre-wrap break-words"
              >
                {part.text}
              </p>
            ),
          )}
        </div>
      </div>
    )
  }
  const last = entry.parts.length - 1
  const answer = entry.parts
    .filter((p) => p.kind === 'text' && p.text)
    .map((p) => p.text)
    .join('\n\n')
  return (
    <div data-role={entry.role} className="flex flex-col gap-3">
      {time}
      {entry.parts.map((part, i) => (
        <Step
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
          key={i}
          dot={part.kind === 'tool' ? toolDot(part) : 'bg-fg-subtle'}
          line={i < last || !!joinsNext}
        >
          <Part part={part} />
        </Step>
      ))}
      {!joinsNext && answer && (
        <div className="-mt-2 pl-4">
          <CopyButton
            text={() => answer}
            label={t('chat.message.copyAnswer')}
          />
        </div>
      )}
    </div>
  )
})
