// Characters that can make text read as something it is not: C0 and C1
// controls, the bidi marks, embeddings, overrides and isolates (U+202E makes
// "0001" read "1000"), and the zero-width spaces. The zero-width joiner and
// non-joiner stay: they join emoji (👩‍💻) and shape Indic and Persian text. A notification strips them
// from a name (cleanName in agent-notify.ts, and public/notify-sw.js, which
// cannot import this); the table view shows them as ⟨U+XXXX⟩.
const INVISIBLE =
  '\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060\\u2066-\\u2069\\ufeff'

export const UNSAFE_CHARS = new RegExp(
  `[\\u0000-\\u001f\\u007f-\\u009f${INVISIBLE}]`,
  'g',
)

// The same, less tab and line feed, which a value may hold as text
const SHOWN = new RegExp(
  `[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f${INVISIBLE}]`,
  'g',
)

function mark(c: string): string {
  return `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`
}

// value with every unsafe character written as ⟨U+XXXX⟩. On one line (a
// table cell) a line break is ↵; multiline keeps it, CRLF as one break.
export function visibleUnsafe(value: string, multiline = false): string {
  const lines = multiline
    ? value.replace(/\r\n/g, '\n')
    : value.replace(/\r?\n/g, '↵')
  return lines.replace(SHOWN, mark)
}

// value cut into plain runs and the unsafe characters between them (tab and
// line feed count as plain), each with its ⟨U+XXXX⟩ mark, so a view can show
// the mark and still copy the character itself
export function splitUnsafe(
  value: string,
): Array<{ text: string; mark?: string }> {
  const parts: Array<{ text: string; mark?: string }> = []
  let last = 0
  for (const m of value.matchAll(SHOWN)) {
    if (m.index > last) parts.push({ text: value.slice(last, m.index) })
    parts.push({ text: m[0], mark: mark(m[0]) })
    last = m.index + m[0].length
  }
  if (last < value.length) parts.push({ text: value.slice(last) })
  return parts
}
