import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import type { TranscriptPart } from '../hooks/use-mux-api'
import {
  type DiffRow,
  diffLines,
  diffSummary,
  parseUnifiedDiff,
} from '../utils/line-diff'

// A tool call of the Chat view, as a card: its name and what it is about,
// then what it ran and returned (IN/OUT), or for an edit the lines it
// changed. Each block stays a few lines tall until opened. Long lines wrap:
// on a phone a block scrolling sideways would carry the whole list with it.

// Lines a block shows before "Show all"
const IO_LINES = 6
const DIFF_LINES = 12

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])

const ROW: Record<DiffRow['kind'], string> = {
  ctx: '',
  add: 'bg-diff-add',
  del: 'bg-diff-del',
}
const SIGN: Record<DiffRow['kind'], string> = { ctx: ' ', add: '+', del: '-' }

function lineCount(text: string) {
  return text.replace(/\n$/, '').split('\n').length
}

function basename(path: string) {
  const name = path.split(/[\\/]/).pop()
  return name || path
}

// A block cut to maxClass's height until opened: when it holds more than
// lines, or once rendered taller (a long line wraps over several).
function Capped({
  lines,
  limit,
  maxClass,
  className,
  children,
}: {
  lines: number
  limit: number
  maxClass: string
  className: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [tall, setTall] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the content changes
  useLayoutEffect(() => {
    const el = ref.current
    if (el && !open) setTall(el.scrollHeight > el.clientHeight + 1)
  }, [children, open])
  const capped = lines > limit || tall
  return (
    <>
      <div
        ref={ref}
        className={`${className} ${capped && !open ? maxClass : ''}`}
      >
        {children}
      </div>
      {capped && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full border-t border-border px-2 py-1 text-left font-sans text-[12px] text-fg-muted hover:text-fg"
        >
          {open
            ? 'Show less'
            : lines > limit
              ? `Show all ${lines} lines`
              : 'Show all'}
        </button>
      )}
    </>
  )
}

function IoRow({
  label,
  text,
  danger,
}: {
  label: string
  text: string
  danger?: boolean
}) {
  return (
    <div className="border-t border-border first:border-t-0">
      <Capped
        lines={lineCount(text)}
        limit={IO_LINES}
        maxClass="max-h-[9.6em]"
        className="flex min-w-0 overflow-hidden leading-[1.6]"
      >
        <span className="w-10 shrink-0 select-none px-2 py-1.5 text-[11px] text-fg-subtle">
          {label}
        </span>
        <pre
          className={`min-w-0 flex-1 whitespace-pre-wrap break-all py-1.5 pr-2 ${danger ? 'text-danger' : ''}`}
        >
          {text}
        </pre>
      </Capped>
    </div>
  )
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1.5 overflow-hidden rounded-control border border-border bg-surface font-mono text-[12px]">
      {children}
    </div>
  )
}

// The lines of an edit; several replacements are parted by a dashed line.
function DiffBlock({ hunks }: { hunks: DiffRow[][] }) {
  return (
    <Frame>
      <Capped
        lines={hunks.reduce((n, h) => n + h.length, 0)}
        limit={DIFF_LINES}
        maxClass="max-h-[19.2em]"
        className="overflow-hidden bg-bg leading-[1.6]"
      >
        {hunks.map((rows, h) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: hunks never reorder
            key={h}
            className={h > 0 ? 'border-t border-dashed border-border' : ''}
          >
            {rows.map((r, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows never reorder
                key={i}
                data-diff={r.kind}
                className={`flex pr-2 ${ROW[r.kind]}`}
              >
                <span className="w-5 shrink-0 select-none text-center text-fg-subtle">
                  {SIGN[r.kind]}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">
                  {r.text}
                </span>
              </div>
            ))}
          </div>
        ))}
      </Capped>
    </Frame>
  )
}

// The rows of an edit: from the replacements the server sent, else from a
// unified diff in the result (a Codex file change).
function editHunks(part: TranscriptPart): DiffRow[][] | null {
  const edits = part.detail?.edits
  if (edits?.length) {
    return edits.map((e) => diffLines(e.old ?? '', e.new ?? ''))
  }
  if (part.result && !part.isError && !part.detail?.hidden) {
    const rows = parseUnifiedDiff(part.result)
    return rows.length ? [rows] : null
  }
  return null
}

export function ToolCard({ part }: { part: TranscriptPart }) {
  const d = part.detail
  const name = part.orphan ? 'Result' : part.tool
  const edit = !part.orphan && EDIT_TOOLS.has(part.tool ?? '')
  const hunks = edit ? editHunks(part) : null
  const command = d?.command
  const about = d?.description || part.input
  const clipped = part.clipped || d?.clipped
  // An edit's result only repeats the file; shown when the edit failed
  const out = !hunks && (!edit || part.isError) ? part.result : undefined
  return (
    <div className="min-w-0 text-[13px]" data-tool={name}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span
          className={`min-w-0 shrink-[0.5] truncate font-semibold ${part.isError ? 'text-danger' : ''}`}
          title={name}
        >
          {name}
        </span>
        {edit && part.input ? (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-accent"
            title={part.input}
          >
            {basename(part.input)}
          </span>
        ) : (
          about && (
            <span
              className={`min-w-0 flex-1 truncate text-fg-muted ${d?.description ? '' : 'font-mono text-[12px]'}`}
              title={about}
            >
              {about}
            </span>
          )
        )}
      </div>
      {part.orphan && (
        <p className="text-[12px] text-fg-subtle">
          The call is in an earlier part of the conversation.
        </p>
      )}
      {hunks && (
        <>
          <p className="text-[12px] text-fg-subtle">
            {diffSummary(hunks.flat())}
          </p>
          <DiffBlock hunks={hunks} />
        </>
      )}
      {d?.hidden && (
        <p className="text-[12px] text-fg-subtle">
          The edit of a sensitive file is not shown.
        </p>
      )}
      {(command || out) && (
        <Frame>
          {command && <IoRow label="IN" text={command} />}
          {out && <IoRow label="OUT" text={out} danger={part.isError} />}
        </Frame>
      )}
      {clipped && (
        <p className="mt-1 text-[12px] text-fg-subtle">(shortened)</p>
      )}
    </div>
  )
}

// The colour of a part's dot on the timeline: a tool by how it ended, a
// call still without a result hollow.
export function toolDot(part: TranscriptPart) {
  if (part.isError) return 'bg-danger'
  if (part.result || part.orphan) return 'bg-success'

  return 'border border-fg-subtle bg-transparent'
}
