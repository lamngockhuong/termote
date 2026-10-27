import type { DiffHunk, DiffLine } from '../hooks/use-mux-api'
import { quoteLines } from './review-message'

// Lines picked for a review comment, in a diff, a file or an editor.

// What a comment is about: its range as the new side numbers it, the
// deleted lines in it (old side), and the lines themselves
export interface LineRange {
  start: number
  end: number
  removed?: { start: number; end: number }
  // Deleted lines only: start and end are where they were removed
  removedOnly?: boolean
  // Left out for a sensitive file
  quote?: string
  sensitive?: boolean
  // Picked in an editor with unsaved edits
  unsaved?: boolean
}

// Lines picked by their gutter: a and b are line numbers (a file) or
// indexes (a hunk's lines) in group (the hunk; 0 for a file)
export interface LinePick {
  group: number
  a: number
  b: number
}

// The pick after line of group is pressed: the same single line again
// clears it; extend (Shift, or a touch screen once a line is picked) goes
// from the first line picked to this one in the same group; anything else
// picks this line alone.
export function pickLine(
  pick: LinePick | null,
  group: number,
  line: number,
  extend: boolean,
): LinePick | null {
  if (pick?.group === group && pick.a === line && pick.b === line) return null
  if (pick && extend && pick.group === group)
    return { group, a: pick.a, b: line }
  return { group, a: line, b: line }
}

// pick's lines in order
export const pickSpan = (p: LinePick): [number, number] =>
  p.a <= p.b ? [p.a, p.b] : [p.b, p.a]

export const inPick = (p: LinePick | null, group: number, line: number) => {
  if (p?.group !== group) return false
  const [lo, hi] = pickSpan(p)
  return line >= lo && line <= hi
}

const SIGN: Record<DiffLine['kind'], string> = { ctx: ' ', add: '+', del: '-' }

// The range of hunk's lines from index a to b (either order): new numbers
// from its kept and added lines, old ones from its deleted lines. Deleted
// lines only: where they were removed, as the editor opens at them.
export function diffRange(hunk: DiffHunk, a: number, b: number): LineRange {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  const lines = hunk.lines.slice(lo, hi + 1)
  const news = lines.flatMap((l) => (l.kind === 'del' ? [] : [l.new as number]))
  const olds = lines.flatMap((l) => (l.kind === 'del' ? [l.old as number] : []))
  const quote = quoteLines(lines.map((l) => SIGN[l.kind] + l.text))
  const removed = olds.length
    ? { start: olds[0], end: olds[olds.length - 1] }
    : undefined
  if (news.length)
    return { start: news[0], end: news[news.length - 1], removed, quote }
  // The new line before the range, from the header (@@ -a,b +c,d @@) and
  // the lines above it
  let last = Number(/\+(\d+)/.exec(hunk.header)?.[1] ?? 1) - 1
  for (const l of hunk.lines.slice(0, lo))
    if (l.kind !== 'del') last = l.new as number
  return { start: last + 1, end: last + 1, removed, removedOnly: true, quote }
}

// Lines of a file: the first and last numbers, and their text
export interface TextLines {
  from: number
  to: number
  lines: string[]
}

// The whole lines of text that the selection from start to end (offsets)
// covers; an end at the start of a line (whole lines selected) leaves that
// line out
export function selectedLines(
  text: string,
  start: number,
  end: number,
): TextLines {
  const all = text.split('\n')
  const lineAt = (offset: number) => text.slice(0, offset).split('\n').length
  const from = lineAt(Math.min(start, end))
  let to = lineAt(Math.max(start, end))
  if (to > from && text[Math.max(start, end) - 1] === '\n') to--
  return { from, to, lines: all.slice(from - 1, to) }
}
