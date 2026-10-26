import type { PaletteMode } from './app-commands'

// The character that opens each mode of the palette in its one input; a
// file name needs none
export const PREFIXES: Record<Exclude<PaletteMode, 'files'>, string> = {
  commands: '>',
  line: ':',
  sessions: '@',
}

// The mode the input's text asks for, and the query after its prefix
export function parsePrefix(text: string): {
  mode: PaletteMode
  query: string
} {
  for (const [mode, prefix] of Object.entries(PREFIXES))
    if (text.startsWith(prefix))
      return { mode: mode as PaletteMode, query: text.slice(1).trim() }
  return { mode: 'files', query: text.trim() }
}

// The input's text when the palette opens in mode
export const prefixOf = (mode: PaletteMode) =>
  mode === 'files' ? '' : PREFIXES[mode]

const isWordStart = (text: string, i: number) =>
  i === 0 ||
  /[\s\-_./:\\>]/.test(text[i - 1]) ||
  (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]))

// How well query matches text as a subsequence, ignoring case, or undefined
// when it does not: letters at the start of a word and letters next to each
// other count more, so "tf" ranks "Toggle Files" above "settings for".
export function matchScore(text: string, query: string): number | undefined {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let score = 0
  let at = 0
  let prev = -2
  for (const ch of q) {
    // Prefer this letter at the start of a word, from here on
    let found = -1
    for (let i = at; i < t.length; i++) {
      if (t[i] !== ch) continue
      if (found < 0) found = i
      if (i === prev + 1 || isWordStart(text, i)) {
        found = i
        break
      }
    }
    if (found < 0) return
    score += 1
    if (found === prev + 1) score += 3
    if (isWordStart(text, found)) score += 2
    prev = found
    at = found + 1
  }
  // Shorter texts first among equals
  return score - text.length / 1000
}

// The items that match query, best first; items scoring the same keep
// their order
export function rankByMatch<T>(
  items: T[],
  query: string,
  textOf: (item: T) => string,
): T[] {
  if (!query) return items
  return items
    .map((item, i) => ({ item, i, score: matchScore(textOf(item), query) }))
    .filter(
      (r): r is { item: T; i: number; score: number } => r.score !== undefined,
    )
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.item)
}

// "120" or "120:5": a line (1-based) and maybe a column, or undefined
export function parseLine(
  query: string,
): { line: number; col?: number } | undefined {
  const m = /^(\d+)(?::(\d+))?$/.exec(query.trim())
  if (!m) return
  const line = Number(m[1])
  const col = m[2] === undefined ? undefined : Number(m[2])
  if (line < 1 || (col !== undefined && col < 1)) return
  return { line, col }
}
