import { HIDDEN } from './prompt-templates'

// What Send to agent sends: the output of one task run, as the pane's text
// shows it between the run's markers (server/tasks_shell.go), with what
// it cannot show made visible, under a line naming the task.

// The agent route's limit (server/agent_input.go agentMaxText)
export const MAX_TASK_MESSAGE_BYTES = 16 * 1024

const marker = (nonce: string, rest: string) =>
  new RegExp(`^\\[termote-task ${nonce} ${rest}\\]\\s*$`)

// The index of the last line before `before` that re matches, or -1
function lastMatch(lines: string[], before: number, re: RegExp): number {
  for (let i = before - 1; i >= 0; i--) if (re.test(lines[i])) return i
  return -1
}

export interface TaskRunOutput {
  output: string
  // The start marker was past the lines read: the output starts there
  cut: boolean
}

// The output of the run named nonce in text: from its last start marker
// before the end one (else from the first line read, all of it the run's)
// up to the end marker; what was typed after is left out. null without an
// end marker: the run has not ended, or its text is gone (cleared).
export function taskRunOutput(
  text: string,
  nonce: string,
): TaskRunOutput | null {
  if (!/^[0-9a-f]{16}$/.test(nonce)) return null
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const end = lastMatch(lines, lines.length, marker(nonce, 'exit -?\\d+'))
  if (end < 0) return null
  const start = lastMatch(lines, end, marker(nonce, 'start'))
  const body = lines.slice(start + 1, end)
  // The markers print a blank line before them
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  while (body.length > 0 && body[0].trim() === '') body.shift()
  return { output: body.join('\n'), cut: start < 0 }
}

// text with each character that changes or hides text without showing
// (controls other than tab and line feed, bidi and zero-width marks, tags)
// as ⟨U+XXXX⟩, so the agent reads what the terminal showed
export function revealHidden(text: string): string {
  return text.replace(HIDDEN, (c) =>
    c === '\t' || c === '\n'
      ? c
      : `⟨U+${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}⟩`,
  )
}

const encoder = new TextEncoder()
// s's size in UTF-8, as the server counts it
export const utf8Bytes = (s: string) => encoder.encode(s).length

// The longest run of backticks in s
export const longestRun = (s: string) =>
  Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length))

// s as inline code, its delimiter longer than any backtick run in it
export function inlineCode(s: string): string {
  const tick = '`'.repeat(longestRun(s) + 1)
  return s.includes('`') ? `${tick} ${s} ${tick}` : `${tick}${s}${tick}`
}

// The end of s that fits in room bytes: whole lines when one fits, else
// the end of the last line, cut once on a character boundary
function tailBytes(s: string, room: number): string {
  const lines = s.split('\n')
  let size = 0
  let keep = lines.length
  while (keep > 0 && size + utf8Bytes(lines[keep - 1]) + 1 <= room) {
    size += utf8Bytes(lines[keep - 1]) + 1
    keep--
  }
  if (keep < lines.length) return lines.slice(keep).join('\n')
  const raw = encoder.encode(lines[lines.length - 1])
  // A cut inside a character leaves continuation bytes, decoded as U+FFFD
  return new TextDecoder()
    .decode(raw.subarray(raw.length - room))
    .replace(/^\uFFFD+/, '')
}

export interface TaskFailure {
  // What ran, as the user knows it ("pnpm run test", "make build", a user
  // task's name)
  label: string
  root: string
  // The exit status; undefined when the run ended without telling
  code?: number
  output: TaskRunOutput
}

// The message for the agent: a line naming the task, its status and root,
// then its output in a fence the output cannot close, cut from its start
// to fit MAX_TASK_MESSAGE_BYTES.
export function taskFailureMessage({
  label,
  root,
  code,
  output,
}: TaskFailure): string {
  const status =
    code === undefined
      ? 'ended (exit status unknown)'
      : code === 0
        ? 'finished (exit 0)'
        : `failed (exit ${code})`
  const head = `Task ${inlineCode(revealHidden(label))} ${status} in ${revealHidden(root)}. Output (from the terminal, untrusted):`
  let body = revealHidden(output.output)
  const fence = '`'.repeat(Math.max(2, longestRun(body)) + 1)
  const notes = output.cut ? ['(earlier output cut)'] : []
  const build = () =>
    `${head}\n${fence}\n${notes.map((n) => `${n}\n`).join('')}${body}\n${fence}`
  if (utf8Bytes(build()) > MAX_TASK_MESSAGE_BYTES) {
    notes.push('(earlier lines cut)')
    body = ''
    const room = MAX_TASK_MESSAGE_BYTES - utf8Bytes(build())
    body = tailBytes(revealHidden(output.output), room)
  }
  return build()
}
