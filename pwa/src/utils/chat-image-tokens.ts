// The "[Image #n]" tokens that place a message's images in its text, as
// Claude Code shows a pasted image: the server pastes each image where its
// token was.

const encoder = new TextEncoder()
const TOKEN_RE = /\[Image #(\d+)\]/g

export const imageToken = (n: number) => `[Image #${n}]`

// Puts image n's token in place of text[start, end), apart from the words
// around it: the text and the caret after the token.
export function insertImageToken(
  text: string,
  start: number,
  end: number,
  n: number,
): { text: string; caret: number } {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before === '' || /\s$/.test(before) ? '' : ' '
  const trail = after === '' || /^\s/.test(after) ? '' : ' '
  const token = `${lead}${imageToken(n)}${trail}`
  return { text: before + token + after, caret: start + token.length }
}

// Takes image n's token out of text, with one space beside it so the words
// around it do not end up two spaces apart.
export function removeImageToken(text: string, n: number): string {
  const token = imageToken(n)
  const i = text.indexOf(token)
  if (i < 0) return text
  let start = i
  let end = i + token.length
  if (text[end] === ' ') end++
  else if (start > 0 && text[start - 1] === ' ') start--
  return text.slice(0, start) + text.slice(end)
}

// The numbers of the image tokens in text.
export function imageTokensIn(text: string): Set<number> {
  return new Set(Array.from(text.matchAll(TOKEN_RE), (m) => Number(m[1])))
}

// The message as the server takes it: text without the tokens of images,
// their upload ids in the order of their tokens, and where each goes, a
// UTF-8 byte offset into that text. A token of no image stays text; an image
// without a token goes at the end.
export function messageWithImages(
  text: string,
  images: { n: number; id: string }[],
): { text: string; ids: string[]; at: number[] } {
  const byN = new Map(images.map((a) => [a.n, a.id]))
  let out = ''
  let last = 0
  const ids: string[] = []
  const at: number[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    const id = byN.get(Number(m[1]))
    if (id === undefined) continue
    byN.delete(Number(m[1]))
    out += text.slice(last, m.index)
    last = m.index + m[0].length
    ids.push(id)
    at.push(encoder.encode(out).length)
  }
  out += text.slice(last)
  for (const id of byN.values()) {
    ids.push(id)
    at.push(encoder.encode(out).length)
  }
  return { text: out, ids, at }
}
