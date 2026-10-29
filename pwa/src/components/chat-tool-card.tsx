import { ChevronRight } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { EDIT_TOOLS } from '../hooks/use-agent-transcript'
import type { TranscriptPart } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import {
  type DiffRow,
  diffLines,
  diffSummary,
  parseUnifiedDiff,
} from '../utils/line-diff'
import { FileRef } from './chat-file-link'

// A tool call of the Chat view, as a card: its name and what it is about,
// then the command it ran and, folded until asked for, what it returned; or
// for an edit the lines it changed. Each block stays a few lines tall until
// opened. Long lines wrap: on a phone a block scrolling sideways would carry
// the whole list with it.

// Lines a block shows before "Show all": a command only says what ran, its
// output is a tap away
const COMMAND_LINES = 3
const DIFF_LINES = 12
// Lines of an opened result shown first, from its end: where a command
// says how it went
const OUT_TAIL = 10

const ROW: Record<DiffRow['kind'], string> = {
  ctx: '',
  add: 'bg-diff-add',
  del: 'bg-diff-del',
}
const SIGN: Record<DiffRow['kind'], string> = { ctx: ' ', add: '+', del: '-' }

function lineCount(text: string) {
  return text.replace(/\n$/, '').split('\n').length
}

// Tools whose input is the file they read or changed, opened in Files from
// the card
const FILE_TOOLS = new Set([...EDIT_TOOLS, 'Read', 'ViewImage'])

// The file a call is about: a Codex move names both, the file is where it
// went. None from an input the server shortened ("…"): the path is cut.
function toolFile(part: TranscriptPart) {
  const input = part.input
  if (part.orphan || !input || !FILE_TOOLS.has(part.tool ?? '')) return
  if (input.endsWith('…')) return
  return input.split(' → ').pop()
}

function basename(path: string) {
  const name = path.split(/[\\/]/).pop()
  return name || path
}

// A block cut to maxClass's height until opened: when it holds more than
// lines, or overflows the cut (a long line wraps over several). The cut is
// on while closed, so the overflow can be measured against it.
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
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [tall, setTall] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the content changes
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const measure = () => setTall(el.scrollHeight > el.clientHeight + 1)
    measure()
    // A narrower list (a phone turned, a panel opened) wraps a line more
    // often: measured again, or what the cut hides would have no way out.
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children, open])
  const capped = lines > limit || tall
  return (
    <>
      <div ref={ref} className={`${className} ${open ? '' : maxClass}`}>
        {children}
      </div>
      {capped && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full border-t border-border px-2 py-1 text-left font-sans text-[12px] text-fg-muted hover:text-fg pointer-coarse:min-h-touch"
        >
          {open
            ? t('chat.showLess')
            : lines > limit
              ? t('chat.showAllLines', { count: lines })
              : t('chat.showAll')}
        </button>
      )}
    </>
  )
}

function CommandRow({ command }: { command: string }) {
  return (
    <Capped
      lines={lineCount(command)}
      limit={COMMAND_LINES}
      // The lines and the block's own padding (py-1.5)
      maxClass="max-h-[calc(4.8em+0.75rem)]"
      className="overflow-hidden px-2 py-1.5 leading-[1.6]"
    >
      <pre className="whitespace-pre-wrap break-all">
        <span className="select-none text-success">$ </span>
        {command}
      </pre>
    </Capped>
  )
}

const FOLD_ROW =
  'flex flex-1 items-center gap-1.5 px-2 py-1 font-sans text-[12px] text-fg-muted tabular-nums hover:text-fg pointer-coarse:min-h-touch'

// What a call returned, behind one row until opened; a failure opens at
// once. Opened, it shows its last lines, and all of them on request.
function OutputFold({ text, danger }: { text: string; danger?: boolean }) {
  const { t } = useT()
  const [open, setOpen] = useState(!!danger)
  const [all, setAll] = useState(false)
  const lines = text.replace(/\n+$/, '').split('\n')
  const shown = all ? lines : lines.slice(-OUT_TAIL)
  return (
    <div className="border-t border-border first:border-t-0">
      {open && (
        <pre
          className={`whitespace-pre-wrap break-all px-2 py-1.5 leading-[1.6] ${danger ? 'text-danger' : ''}`}
        >
          {shown.join('\n')}
        </pre>
      )}
      <div className={`flex ${open ? 'border-t border-border' : ''}`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={FOLD_ROW}
        >
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          {open
            ? t('chat.tool.hideOutput')
            : t('chat.tool.output', { count: lines.length })}
        </button>
        {open && lines.length > OUT_TAIL && (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll(!all)}
            className={`${FOLD_ROW} justify-center border-l border-border`}
          >
            {all
              ? t('chat.tool.showLast', { count: OUT_TAIL })
              : t('chat.showAllLines', { count: lines.length })}
          </button>
        )}
      </div>
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
  const { t } = useT()
  const d = part.detail
  const name = part.orphan ? t('chat.tool.result') : part.tool
  const edit = !part.orphan && EDIT_TOOLS.has(part.tool ?? '')
  const hunks = edit ? editHunks(part) : null
  const command = d?.command
  const about = d?.description || part.input
  const file = toolFile(part)
  const clipped = part.clipped || d?.clipped
  // An edit's result only repeats the file; shown when the edit failed
  const out = !hunks && (!edit || part.isError) ? part.result : undefined
  return (
    <div
      className="min-w-0 text-[13px]"
      data-tool={part.orphan ? 'Result' : part.tool}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span
          className={`min-w-0 shrink-[0.5] truncate font-semibold ${part.isError ? 'text-danger' : ''}`}
          title={name}
        >
          {name}
        </span>
        {edit && part.input ? (
          <FileRef
            path={file}
            title={part.input}
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-accent"
          >
            {basename(part.input)}
          </FileRef>
        ) : file && !d?.description ? (
          <FileRef
            path={file}
            className="min-w-0 flex-1 truncate font-mono text-[12px]"
            plainClassName="text-fg-muted"
          >
            {part.input}
          </FileRef>
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
        <p className="text-[12px] text-fg-subtle">{t('chat.tool.orphan')}</p>
      )}
      {hunks && (
        <>
          <p className="text-[12px] text-fg-subtle">
            {diffSummary(hunks.flat(), t)}
          </p>
          <DiffBlock hunks={hunks} />
        </>
      )}
      {d?.hidden && (
        <p className="text-[12px] text-fg-subtle">
          {edit ? t('chat.tool.hiddenEdit') : t('chat.tool.hiddenContents')}
        </p>
      )}
      {(command || out) && (
        <Frame>
          {command && <CommandRow command={command} />}
          {out && <OutputFold text={out} danger={part.isError} />}
        </Frame>
      )}
      {clipped && (
        <p className="mt-1 text-[12px] text-fg-subtle">
          {t('chat.message.shortened')}
        </p>
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
