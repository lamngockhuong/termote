// Commands offered by the Chat composer: the agent's built-ins after "/",
// plus the custom commands and skills of the project, the user, the enabled
// plugins and the agent itself (read by the server), after the agent's own
// trigger: "/" for Claude Code, "$" for Codex skills.

import { en, type MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'

export type SlashCommandSource =
  | 'builtin'
  | 'project'
  | 'user'
  | 'plugin'
  | 'system'

export type CommandTrigger = '/' | '$'

export interface SlashCommand {
  // Without the leading "/"
  name: string
  // What the agent says it does (a custom command or skill)
  description?: string
  // What a built-in does, in the app's words: read through t()
  descriptionKey?: MessageKey
  source: SlashCommandSource
  kind?: 'command' | 'skill'
  // Opens an interactive screen the Chat view cannot drive: sent, then the
  // terminal is shown
  terminal?: boolean
  // Asked before it is sent (it ends the agent)
  confirm?: boolean
  // Typed after this character; "/" when absent
  trigger?: CommandTrigger
}

const builtin = (
  name: string,
  descriptionKey: MessageKey,
  flags: Pick<SlashCommand, 'terminal' | 'confirm'> = {},
): SlashCommand => ({ name, descriptionKey, source: 'builtin', ...flags })

// The description a command shows: a built-in's in the app's language, an
// agent's own as it wrote it
export function commandDescription(
  c: SlashCommand,
  t: Translate<MessageKey>,
): string | undefined {
  return c.descriptionKey ? t(c.descriptionKey) : c.description
}

const T = { terminal: true }

// Claude Code 2.1.x built-ins (code.claude.com/docs/en/commands), without
// the removed ones and those hidden from its own menu. /exit comes first; the
// rest are in alphabetical order. A command missing here can still be typed.
export const CLAUDE_BUILTIN_COMMANDS: SlashCommand[] = [
  builtin('exit', 'chat.slash.claude.exit', { confirm: true }),
  builtin('add-dir', 'chat.slash.claude.addDir'),
  builtin('agents', 'chat.slash.claude.agents'),
  builtin('branch', 'chat.slash.claude.branch'),
  builtin('btw', 'chat.slash.claude.btw'),
  builtin('clear', 'chat.slash.claude.clear'),
  builtin('compact', 'chat.slash.claude.compact'),
  builtin('config', 'chat.slash.claude.config', T),
  builtin('context', 'chat.slash.claude.context'),
  builtin('copy', 'chat.slash.claude.copy', T),
  builtin('cost', 'chat.slash.claude.cost', T),
  builtin('diff', 'chat.slash.claude.diff', T),
  builtin('doctor', 'chat.slash.claude.doctor'),
  builtin('effort', 'chat.slash.claude.effort'),
  builtin('export', 'chat.slash.claude.export', T),
  builtin('fast', 'chat.slash.claude.fast'),
  builtin('feedback', 'chat.slash.claude.feedback', T),
  builtin('help', 'chat.slash.claude.help', T),
  builtin('hooks', 'chat.slash.claude.hooks', T),
  builtin('ide', 'chat.slash.claude.ide', T),
  builtin('init', 'chat.slash.claude.init'),
  builtin('login', 'chat.slash.claude.login', T),
  builtin('logout', 'chat.slash.claude.logout', T),
  builtin('mcp', 'chat.slash.claude.mcp', T),
  builtin('memory', 'chat.slash.claude.memory', T),
  builtin('model', 'chat.slash.claude.model', T),
  builtin('permissions', 'chat.slash.claude.permissions', T),
  builtin('plan', 'chat.slash.claude.plan'),
  builtin('plugin', 'chat.slash.claude.plugin', T),
  builtin('recap', 'chat.slash.claude.recap'),
  builtin('release-notes', 'chat.slash.claude.releaseNotes', T),
  builtin('reload-plugins', 'chat.slash.claude.reloadPlugins'),
  builtin('reload-skills', 'chat.slash.claude.reloadSkills'),
  builtin('rename', 'chat.slash.claude.rename'),
  builtin('resume', 'chat.slash.claude.resume', T),
  builtin('review', 'chat.slash.claude.review'),
  builtin('rewind', 'chat.slash.claude.rewind', T),
  builtin('security-review', 'chat.slash.claude.securityReview'),
  builtin('skills', 'chat.slash.claude.skills', T),
  builtin('status', 'chat.slash.claude.status', T),
  builtin('statusline', 'chat.slash.claude.statusline'),
  builtin('tasks', 'chat.slash.claude.tasks', T),
  builtin('theme', 'chat.slash.claude.theme', T),
  builtin('usage', 'chat.slash.claude.usage', T),
]

// Codex 0.162.0 built-ins (codex-rs/tui/src/slash_command.rs at tag
// rust-v0.162.0), without the aliases, /mention (it only types "@"), those
// tied to an OS, a host app or a feature flag (/app, /daybreak, /ide,
// /setup-default-sandbox, /voice) and the debug ones. /exit comes first; the
// rest are in alphabetical order. A command missing here can still be typed.
export const CODEX_BUILTIN_COMMANDS: SlashCommand[] = [
  builtin('exit', 'chat.slash.codex.exit', { confirm: true }),
  builtin('agents', 'chat.slash.codex.agents', T),
  builtin('approve', 'chat.slash.codex.approve', T),
  builtin('apps', 'chat.slash.codex.apps', T),
  builtin('archive', 'chat.slash.codex.archive', T),
  builtin('btw', 'chat.slash.codex.btw', T),
  builtin('cd', 'chat.slash.codex.cd'),
  builtin('clear', 'chat.slash.codex.clear'),
  builtin('compact', 'chat.slash.codex.compact'),
  builtin('copy', 'chat.slash.codex.copy', T),
  builtin('daemon', 'chat.slash.codex.daemon', T),
  builtin('debug-config', 'chat.slash.codex.debugConfig', T),
  builtin('delete', 'chat.slash.codex.delete', T),
  builtin('diff', 'chat.slash.codex.diff', T),
  builtin('experimental', 'chat.slash.codex.experimental', T),
  builtin('export', 'chat.slash.codex.export', T),
  builtin('feedback', 'chat.slash.codex.feedback', T),
  builtin('fork', 'chat.slash.codex.fork', T),
  builtin('goal', 'chat.slash.codex.goal'),
  builtin('hooks', 'chat.slash.codex.hooks', T),
  builtin('import', 'chat.slash.codex.import', T),
  builtin('init', 'chat.slash.codex.init'),
  builtin('keymap', 'chat.slash.codex.keymap', T),
  builtin('logout', 'chat.slash.codex.logout', { confirm: true }),
  builtin('mcp', 'chat.slash.codex.mcp', T),
  builtin('memories', 'chat.slash.codex.memories', T),
  builtin('model', 'chat.slash.codex.model', T),
  builtin('new', 'chat.slash.codex.new', T),
  builtin('permissions', 'chat.slash.codex.permissions', T),
  builtin('pets', 'chat.slash.codex.pets', T),
  builtin('plan', 'chat.slash.codex.plan'),
  builtin('plugins', 'chat.slash.codex.plugins', T),
  builtin('ps', 'chat.slash.codex.ps', T),
  builtin('pwd', 'chat.slash.codex.pwd', T),
  builtin('raw', 'chat.slash.codex.raw'),
  builtin('recap', 'chat.slash.codex.recap'),
  builtin('rename', 'chat.slash.codex.rename'),
  builtin('resume', 'chat.slash.codex.resume', T),
  builtin('review', 'chat.slash.codex.review'),
  builtin('side', 'chat.slash.codex.side', T),
  builtin('skills', 'chat.slash.codex.skills', T),
  builtin('status', 'chat.slash.codex.status', T),
  builtin('statusline', 'chat.slash.codex.statusline', T),
  builtin('stop', 'chat.slash.codex.stop'),
  builtin('subagents', 'chat.slash.codex.subagents', T),
  builtin('theme', 'chat.slash.codex.theme', T),
  builtin('title', 'chat.slash.codex.title', T),
  builtin('tui', 'chat.slash.codex.tui', T),
  builtin('usage', 'chat.slash.codex.usage', T),
  builtin('vim', 'chat.slash.codex.vim'),
  builtin('warnings', 'chat.slash.codex.warnings', T),
  builtin('worktree', 'chat.slash.codex.worktree', T),
]

// Built-ins per agent, by the name the server reports (session.agentName).
export const BUILTIN_COMMANDS: Record<string, SlashCommand[]> = {
  claude: CLAUDE_BUILTIN_COMMANDS,
  codex: CODEX_BUILTIN_COMMANDS,
}

// Another name an agent runs a built-in by, per agent: alias → command.
export const COMMAND_ALIASES: Record<string, Record<string, string>> = {
  claude: { quit: 'exit' },
  codex: { quit: 'exit', cwd: 'pwd', clean: 'stop', pet: 'pets' },
}

// The character an agent's custom commands and skills are typed after: Codex
// runs a skill named anywhere in a message as "$name", and has no custom "/"
// commands.
export const CUSTOM_TRIGGER: Record<string, CommandTrigger> = {
  claude: '/',
  codex: '$',
}

const triggerOf = (c: SlashCommand): CommandTrigger => c.trigger ?? '/'

// Built-ins first, then the project's, then the user's; a name met again
// after the same trigger is left out, as the first one is what the agent runs.
export function mergeSlashCommands(...lists: SlashCommand[][]): SlashCommand[] {
  const seen = new Set<string>()
  const out: SlashCommand[] = []
  for (const c of lists.flat()) {
    const key = triggerOf(c) + c.name
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

// A built-in's description in English, matched in any language: the words
// the agent itself shows
const ENGLISH: Record<string, string> = en

// Names starting with the query first, then those holding it in the name or
// the description; each group keeps the list's order.
export function filterSlashCommands(
  commands: SlashCommand[],
  query: string,
  t: Translate<MessageKey>,
): SlashCommand[] {
  const q = query.toLowerCase()
  if (!q) return commands
  const prefix: SlashCommand[] = []
  const rest: SlashCommand[] = []
  for (const c of commands) {
    const name = c.name.toLowerCase()
    if (name.startsWith(q)) prefix.push(c)
    else if (
      name.includes(q) ||
      [
        commandDescription(c, t),
        c.descriptionKey && ENGLISH[c.descriptionKey],
      ].some((d) => d?.toLowerCase().includes(q))
    ) {
      rest.push(c)
    }
  }
  return [...prefix, ...rest]
}

// The command or skill name being typed, and the range of text a pick
// replaces.
export interface CommandQuery {
  trigger: CommandTrigger
  // The text typed after the trigger
  query: string
  start: number
  end: number
}

// What is being typed: "/name" while the whole message is still only a
// command name (a command is recognized only at the start, and a space ends
// it); with dollar, also the "$name" word the caret ends, anywhere in the
// message. caret is null while text is selected, which opens no "$" list.
// A "$" word runs to the next space, so a pick in its middle replaces it all.
export function commandQuery(
  text: string,
  caret: number | null,
  dollar: boolean,
): CommandQuery | null {
  const slash = /^\/(\S*)$/.exec(text)
  if (slash) {
    return { trigger: '/', query: slash[1], start: 0, end: text.length }
  }
  if (!dollar || caret === null) return null
  const before = text.slice(0, caret)
  const start = before.search(/\S*$/)
  const head = before.slice(start)
  if (!/^\$[^\s$]*$/.test(head)) return null
  return {
    trigger: '$',
    query: head.slice(1),
    start,
    end: caret + text.slice(caret).search(/\s|$/),
  }
}

// The text after picking c for q: the typed word replaced by the trigger and
// the name, then a space (unless a space or a line break follows already),
// and the caret after that space, never past a line break. A Codex skill name
// with no space after it would be taken by Codex's own list on Enter, not sent.
export function applyPick(
  text: string,
  q: CommandQuery,
  c: SlashCommand,
): { text: string; caret: number } {
  const rest = text.slice(q.end)
  const word = `${q.trigger}${c.name}`
  const space = /^\s/.test(rest) ? '' : ' '
  const step = space || rest[0] === ' ' ? 1 : 0
  return {
    text: text.slice(0, q.start) + word + space + rest,
    caret: q.start + word.length + step,
  }
}

// A message for an agent whose skills follow "$", with a space added when it
// ends with a "$name": Codex's list opens on that word as the message is
// pasted, and would take the Enter that sends it.
export function closeTrailingSkill(text: string): string {
  return /(^|\s)\$[^\s$]+$/.test(text) ? `${text} ` : text
}

// The listed "/" command a message runs, if any: its first word after "/",
// an alias (from COMMAND_ALIASES) read as the command it names.
export function commandOf(
  text: string,
  commands: SlashCommand[],
  aliases: Record<string, string> = {},
): SlashCommand | undefined {
  const m = /^\s*\/(\S+)/.exec(text)
  if (!m) return undefined
  const own = Object.hasOwn(aliases, m[1])
  const name = own ? aliases[m[1]] : m[1]
  return commands.find((c) => triggerOf(c) === '/' && c.name === name)
}
