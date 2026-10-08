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
import { highlight, type Token } from '../utils/highlight'

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
export const GUTTER =
  'sticky left-0 shrink-0 select-none bg-inherit px-2 text-right tabular-nums'

// The lines of a file; a final newline does not open an empty last line.
export function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

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
}

// A text file with line numbers, highlighted once the worker answers; plain
// until then and whenever it does not.
export function CodeBlock({ text, path, wrap, scrollTop }: Props) {
  const { resolvedTheme } = useTheme()
  const lines = useMemo(() => splitLines(text), [text])
  const [tokens, setTokens] = useState<Token[][] | null>(null)
  const frame = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: only where it opens
  useLayoutEffect(() => {
    if (scrollTop && frame.current) frame.current.scrollTop = scrollTop
  }, [])

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
  return (
    <div
      ref={frame}
      className={CODE_FRAME}
      data-testid="code-block"
      data-scroll-restore
    >
      <div className={wrap ? '' : 'w-max min-w-full'}>
        {lines.map((line, i) => {
          const parts = tokens?.[i]
          let content: ReactNode = line
          if (parts) {
            content = parts.map((t, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one line never move
              <span key={j} style={tokenStyle(t)}>
                {t[0]}
              </span>
            ))
          }
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a line is its number
            <div key={i} className="flex bg-bg">
              <span
                aria-hidden="true"
                className={`${GUTTER} text-fg-subtle`}
                style={{ minWidth: gutter }}
              >
                {i + 1}
              </span>
              <code className={codeText(wrap)}>{content || ' '}</code>
            </div>
          )
        })}
      </div>
    </div>
  )
}
