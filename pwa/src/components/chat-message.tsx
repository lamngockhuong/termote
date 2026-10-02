import { ChevronRight, ImageIcon, Wrench } from 'lucide-react'
import { type ComponentProps, memo, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TranscriptEntry, TranscriptPart } from '../hooks/use-mux-api'
import { htmlAsText, safeUrl } from '../utils/markdown-safety'

// One entry of an agent's transcript. Agent text is untrusted (a prompt
// injection can write anything), so markdown is rendered without raw HTML,
// links open only for http(s), and images never load: an image URL can carry
// data out without a click.

function MdLink({ href, children }: ComponentProps<'a'>) {
  const u = safeUrl(href)
  if (!u) return <span>{children}</span>
  return (
    <a
      href={href}
      // The text of a link can name another host than it goes to.
      title={u.host}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline underline-offset-2"
    >
      {children}
    </a>
  )
}

function MdImage({ src, alt }: ComponentProps<'img'>) {
  const u = safeUrl(src)
  const label = `image: ${u ? u.host : alt || 'unavailable'}`
  if (!u) return <span className="text-fg-muted">[{label}]</span>
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

const MD_COMPONENTS = { a: MdLink, img: MdImage }

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words [&_code]:rounded [&_code]:bg-surface-raised [&_code]:px-1 [&_li]:ml-5 [&_ol]:list-decimal [&_p+p]:mt-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-control [&_pre]:bg-surface-raised [&_pre]:p-2 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_th]:border [&_th]:border-border [&_th]:px-1.5 [&_ul]:list-disc">
      <Markdown
        remarkPlugins={[remarkGfm, htmlAsText]}
        components={MD_COMPONENTS}
      >
        {text}
      </Markdown>
    </div>
  )
}

function Clipped({ show }: { show?: boolean }) {
  if (!show) return null
  return <p className="mt-1 text-[12px] text-fg-subtle">(shortened)</p>
}

function Disclosure({
  summary,
  children,
  danger,
}: {
  summary: ReactNode
  children?: ReactNode
  danger?: boolean
}) {
  return (
    <details className="group rounded-control border border-border bg-surface text-[13px]">
      <summary
        className={`flex min-h-touch cursor-pointer list-none items-center gap-1.5 px-2 [&::-webkit-details-marker]:hidden ${danger ? 'text-danger' : 'text-fg-muted'}`}
      >
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

function ToolPart({ part }: { part: TranscriptPart }) {
  const name = part.orphan ? 'Result' : part.tool
  return (
    <Disclosure
      danger={part.isError}
      summary={
        <span className="flex min-w-0 items-center gap-1.5">
          <Wrench size={13} aria-hidden="true" className="shrink-0" />
          <span className="font-medium">{name}</span>
          {part.input && (
            <span className="min-w-0 truncate font-mono text-[12px]">
              {part.input}
            </span>
          )}
        </span>
      }
    >
      {part.orphan && (
        <p className="mb-1 text-[12px] text-fg-subtle">
          The call is in an earlier part of the conversation.
        </p>
      )}
      {part.result ? (
        <pre
          className={`max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] ${part.isError ? 'text-danger' : ''}`}
        >
          {part.result}
        </pre>
      ) : (
        <p className="text-[12px] text-fg-subtle">No result yet</p>
      )}
      <Clipped show={part.clipped} />
    </Disclosure>
  )
}

function Part({ part, markdown }: { part: TranscriptPart; markdown: boolean }) {
  switch (part.kind) {
    case 'tool':
      return <ToolPart part={part} />
    case 'image':
      return (
        <span className="inline-flex items-center gap-1 text-fg-muted">
          <ImageIcon size={13} aria-hidden="true" />
          [image]
        </span>
      )
    case 'thinking':
      return (
        <Disclosure summary="Thinking">
          <p className="whitespace-pre-wrap text-fg-muted">{part.text}</p>
          <Clipped show={part.clipped} />
        </Disclosure>
      )
    default:
      return (
        <>
          {markdown ? (
            <MarkdownText text={part.text ?? ''} />
          ) : (
            <p className="whitespace-pre-wrap break-words">{part.text}</p>
          )}
          <Clipped show={part.clipped} />
        </>
      )
  }
}

// Memoised: a poll that brings new entries leaves the others (and their
// parsed markdown) alone.
export const ChatMessage = memo(function ChatMessage({
  entry,
}: {
  entry: TranscriptEntry
}) {
  if (entry.role === 'summary') {
    return (
      <div data-role="summary" className="my-2 flex items-center gap-2">
        <span className="h-px flex-1 bg-border" />
        <Disclosure summary="Conversation compacted">
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
      <div className="text-[12px] text-fg-subtle">
        {entry.parts.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
          <p key={i} className="whitespace-pre-wrap">
            {p.clipped && !p.text ? 'A line too large to show' : p.text}
          </p>
        ))}
      </div>
    )
  }
  const user = entry.role === 'user'
  return (
    <div
      data-role={entry.role}
      className={`flex flex-col gap-1.5 ${user ? 'items-end' : 'items-stretch'}`}
    >
      <div
        className={
          user
            ? 'max-w-[85%] rounded-panel bg-accent/12 px-3 py-2'
            : 'min-w-0 space-y-1.5'
        }
      >
        {entry.parts.map((part, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
          <Part key={i} part={part} markdown={!user} />
        ))}
      </div>
    </div>
  )
})
