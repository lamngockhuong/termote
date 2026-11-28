// The pieces of a message the user typed, as the Chat view shows it: the
// text as written, its http(s) links, and the commands and skills the agent
// knows by name. The user's words are never read as markdown: what they
// typed is what shows, line breaks included.

import { safeUrl } from './markdown-safety'
import type { SlashCommand } from './slash-commands'

export type UserMessageToken =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'command'; text: string; command: SlashCommand }

// A link runs to the next space or quote; punctuation that ends a sentence
// after it is not part of it, nor a closing bracket it did not open.
const LINK = /https?:\/\/[^\s<>"'`]+/g
// A command or skill word: its trigger at the start of a line or after a
// space, its name up to a space or the end. "/home/me" or "and/or" is none.
const WORD = /(^|\s)([/$@])([\w][\w:.-]*)(?=\s|$)/g

function trimLink(s: string): string {
  let end = s.length
  for (;;) {
    const c = s[end - 1]
    if (/[.,;:!?]/.test(c)) {
      end--
      continue
    }
    const open = { ')': '(', ']': '[', '}': '{' }[c as ')' | ']' | '}']
    if (open) {
      const body = s.slice(0, end)
      if (body.split(c).length > body.split(open).length) {
        end--
        continue
      }
    }
    return s.slice(0, end)
  }
}

interface Hit {
  start: number
  end: number
  token: UserMessageToken
}

// commands: the agent's commands and skills (each after its trigger); a
// word naming none stays text, so a path or a typo never looks like one.
export function userMessageTokens(
  text: string,
  commands: SlashCommand[],
): UserMessageToken[] {
  const hits: Hit[] = []
  for (const m of text.matchAll(LINK)) {
    const s = trimLink(m[0])
    const u = safeUrl(s)
    if (!u) continue
    hits.push({
      start: m.index,
      end: m.index + s.length,
      token: { kind: 'link', text: s, href: u.href },
    })
  }
  if (commands.length) {
    const known = new Map(commands.map((c) => [(c.trigger ?? '/') + c.name, c]))
    for (const m of text.matchAll(WORD)) {
      const start = m.index + m[1].length
      const word = m[2] + m[3]
      const command = known.get(word)
      if (!command) continue
      // A link holds no space, so a word after one is never inside it
      hits.push({
        start,
        end: start + word.length,
        token: { kind: 'command', text: word, command },
      })
    }
  }
  hits.sort((a, b) => a.start - b.start)
  const out: UserMessageToken[] = []
  let at = 0
  for (const h of hits) {
    if (h.start > at) out.push({ kind: 'text', text: text.slice(at, h.start) })
    out.push(h.token)
    at = h.end
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) })
  return out
}
