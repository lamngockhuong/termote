import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTheme } from '../contexts/theme-context'
import { useLinePick } from '../hooks/use-line-pick'
import { BLOCK_LINES, useLineWindow } from '../hooks/use-line-window'
import { formatNumber } from '../i18n/format'
import { useT } from '../i18n/i18n-context'
import { highlight, type Token } from '../utils/highlight'
import { inPick, pickSpan, type TextLines } from '../utils/line-range'
import { lineText } from '../utils/review-message'
import { LineCommentBar, LineGutterButton } from './line-comment-bar'

// The code frame shared by Files and Changes: a gutter of line numbers that
// stays put while the code scrolls sideways (or wraps), in the terminal font.
export const CODE_FRAME =
  'min-h-0 flex-1 overflow-auto bg-bg font-term text-[12px] leading-[1.6] text-fg'

export function codeText(wrap: boolean) {
  return wrap
    ? 'min-w-0 flex-1 whitespace-pre-wrap break-all'
    : 'whitespace-pre pr-4'
}

// A line number column; the caller gives its colour (subtler on plain lines
// than on diff backgrounds)
export const GUTTER_CELL = 'shrink-0 select-none px-2 text-right tabular-nums'
export const GUTTER = `sticky left-0 bg-inherit ${GUTTER_CELL}`

// The lines of a file; a final newline does not open an empty last line.
export function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// Past this many lines only the lines near the view are in the page (a few
// DOM nodes a row: tens of thousands stall a tablet for seconds). Up to it
// every line is, so the browser's find and a selection see the whole file.
export const WINDOW_FROM_LINES = 2000
// Lines shown at most: browsers cap an element's height (Firefox near 17.9
// million px, about 930,000 rows), and 4 MiB of short lines is millions
export const MAX_LINES = 400_000

// fontStyle bits from Shiki
const ITALIC = 1
const BOLD = 2
const UNDERLINE = 4

export function tokenStyle([, color, font = 0]: Token): CSSProperties {
  return {
    color,
    fontStyle: font & ITALIC ? 'italic' : undefined,
    fontWeight: font & BOLD ? 'bold' : undefined,
    textDecoration: font & UNDERLINE ? 'underline' : undefined,
  }
}

interface Props {
  text: string
  // Picks the language
  path: string
  wrap: boolean
  // Where it starts scrolled to (a tab shown again)
  scrollTop?: number
  // A line (1-based) to show in the middle and highlight instead, each
  // time jump changes (a search result picked, the same one again too)
  line?: number
  jump?: number
  // Lines may be picked by their numbers for a review comment
  onLineComment?: (lines: TextLines) => void
  // The lines a comment is on
  commentedLines?: Set<number>
}

// A text file with line numbers, highlighted once the worker answers; plain
// until then and whenever it does not.
export function CodeBlock({
  text,
  path,
  wrap,
  scrollTop,
  line,
  jump,
  onLineComment,
  commentedLines,
}: Props) {
  const { resolvedTheme } = useTheme()
  const { t, locale } = useT()
  const all = useMemo(() => splitLines(text), [text])
  const lines = useMemo(
    () => (all.length > MAX_LINES ? all.slice(0, MAX_LINES) : all),
    [all],
  )
  const [tokens, setTokens] = useState<Token[][] | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const win = useLineWindow(
    frame,
    lines,
    wrap,
    lines.length > WINDOW_FROM_LINES,
  )
  // A line asked for, scrolled to once its rows are in the page
  const pending = useRef<number>(undefined)
  // The line picked last, highlighted until the next pick
  const [marked, setMarked] = useState<number>()
  const { pick, press, clear } = useLinePick()
  // Lines picked in a file read again may hold something else now. Dropped
  // while rendering the new text, not in an effect: a mount effect still
  // pending would drop a line picked right after the file showed.
  const [pickedIn, setPickedIn] = useState(text)
  if (pickedIn !== text) {
    setPickedIn(text)
    clear()
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: only where it opens
  useLayoutEffect(() => {
    if (line) return
    if (scrollTop && frame.current) frame.current.scrollTop = scrollTop
    win?.sync()
  }, [])

  // The rows are there before the tokens (plain text first): once per pick
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per pick
  useLayoutEffect(() => {
    if (!line) return
    setMarked(line)
    pending.current = line
    win?.reveal(line)
  }, [jump])
  // After every render: the line asked for, once it is there
  useLayoutEffect(() => {
    const at = pending.current
    if (!at) return
    const row = frame.current?.querySelector(`[data-line="${at}"]`)
    if (!row && win && at <= lines.length) return
    pending.current = undefined
    row?.scrollIntoView?.({ block: 'center' })
    win?.sync()
  })

  useEffect(() => {
    let live = true
    setTokens(null)
    highlight(text, path, resolvedTheme).then((t) => {
      if (live) setTokens(t)
    })
    return () => {
      live = false
    }
  }, [text, path, resolvedTheme])

  const gutter = `${String(lines.length).length + 1}ch`
  const span = pick && pickSpan(pick)
  // Unwrapped, the rows in the page are as wide as the widest line, not
  // only the widest of those shown
  const wide = !!win && !wrap
  const widest = useMemo(() => {
    let n = 0
    if (wide) for (const l of lines) n = Math.max(n, l.length)
    return n
  }, [wide, lines])
  const row = (i: number) => {
    const parts = tokens?.[i]
    let content: ReactNode = lines[i]
    if (parts) {
      content = parts.map((t, j) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one line never move
        <span key={j} style={tokenStyle(t)}>
          {t[0]}
        </span>
      ))
    }
    return (
      <div
        key={i}
        data-line={i + 1}
        className={`flex ${marked === i + 1 || inPick(pick, 0, i + 1) ? 'bg-accent/15' : 'bg-bg'}`}
      >
        {onLineComment ? (
          <LineGutterButton
            line={i + 1}
            commented={!!commentedLines?.has(i + 1)}
            onPress={(shift) => press(0, i + 1, shift)}
          >
            <span
              className={`${GUTTER_CELL} text-fg-subtle`}
              style={{ minWidth: gutter }}
            >
              {i + 1}
            </span>
          </LineGutterButton>
        ) : (
          <span
            aria-hidden="true"
            className={`${GUTTER} text-fg-subtle`}
            style={{ minWidth: gutter }}
          >
            {i + 1}
          </span>
        )}
        <code className={codeText(wrap)}>{content || ' '}</code>
      </div>
    )
  }
  const blocks: ReactNode[] = []
  if (win) {
    for (let b = win.first; b <= win.last; b++) {
      const rows: ReactNode[] = []
      const end = Math.min(lines.length, (b + 1) * BLOCK_LINES)
      for (let i = b * BLOCK_LINES; i < end; i++) rows.push(row(i))
      blocks.push(
        <div key={b} data-block={b} ref={win.measure(b)}>
          {rows}
        </div>,
      )
    }
  }
  return (
    <>
      <div
        ref={frame}
        className={CODE_FRAME}
        // The window keeps the view in place itself when a block above it
        // is measured
        style={win ? { overflowAnchor: 'none' } : undefined}
        data-testid="code-block"
        data-scroll-restore
      >
        <div
          className={wrap ? '' : 'w-max min-w-full'}
          style={
            widest
              ? { minWidth: `max(100%, calc(${gutter} + ${widest}ch + 2rem))` }
              : undefined
          }
        >
          {win ? (
            <>
              <div style={{ height: win.before }} />
              {blocks}
              <div style={{ height: win.after }} />
            </>
          ) : (
            lines.map((_, i) => row(i))
          )}
        </div>
        {all.length > lines.length && (
          <p className="px-4 py-2 font-sans text-fg-subtle">
            {t('files.viewer.moreLines', {
              n: formatNumber(all.length - lines.length, locale),
            })}
          </p>
        )}
      </div>
      {onLineComment && span && (
        <LineCommentBar
          label={capitalized(lineText({ start: span[0], end: span[1] }, t))}
          onComment={() => {
            onLineComment({
              from: span[0],
              to: span[1],
              lines: lines.slice(span[0] - 1, span[1]),
            })
            clear()
          }}
          onClear={clear}
        />
      )}
    </>
  )
}

export const capitalized = (s: string) => s[0].toUpperCase() + s.slice(1)
