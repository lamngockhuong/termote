// Commands offered by the Chat composer: the agent's built-ins after "/",
// plus the custom commands and skills of the project, the user, the enabled
// plugins and the agent itself (read by the server), after the agent's own
// trigger: "/" for Claude Code, "$" for Codex skills.

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
  description?: string
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
  description: string,
  flags: Pick<SlashCommand, 'terminal' | 'confirm'> = {},
): SlashCommand => ({ name, description, source: 'builtin', ...flags })
const T = { terminal: true }

// Claude Code 2.1.x built-ins (code.claude.com/docs/en/commands), without
// the removed ones and those hidden from its own menu. /exit comes first; the
// rest are in alphabetical order. A command missing here can still be typed.
export const CLAUDE_BUILTIN_COMMANDS: SlashCommand[] = [
  builtin('exit', 'Exit Claude Code', { confirm: true }),
  builtin('add-dir', 'Add a working directory for this session'),
  builtin('agents', 'Create or manage subagents'),
  builtin('branch', 'Branch the conversation at this point'),
  builtin('btw', 'Ask a side question about this session'),
  builtin('clear', 'Start a new conversation with empty context'),
  builtin('compact', 'Summarize the conversation to free up context'),
  builtin('config', 'Open the settings', T),
  builtin('context', 'Show current context usage'),
  builtin('copy', 'Copy the last response to the clipboard', T),
  builtin('cost', 'Show session cost and usage', T),
  builtin('diff', 'Review the changes in the working tree', T),
  builtin('doctor', 'Check the Claude Code setup'),
  builtin('effort', 'Set the effort level'),
  builtin('export', 'Export the conversation', T),
  builtin('fast', 'Toggle fast mode'),
  builtin('feedback', 'Send feedback about Claude Code', T),
  builtin('help', 'Show help and available commands', T),
  builtin('hooks', 'View hook configurations', T),
  builtin('ide', 'Manage IDE integrations', T),
  builtin('init', 'Initialize the project with a CLAUDE.md guide'),
  builtin('login', 'Sign in to your Anthropic account', T),
  builtin('logout', 'Sign out from your Anthropic account', T),
  builtin('mcp', 'Manage MCP servers', T),
  builtin('memory', 'Edit CLAUDE.md files and auto memory', T),
  builtin('model', 'Switch the model', T),
  builtin('permissions', 'Manage tool permission rules', T),
  builtin('plan', 'Enter plan mode'),
  builtin('plugin', 'Manage plugins', T),
  builtin('recap', 'Summarize this session in one line'),
  builtin('release-notes', 'View the changelog', T),
  builtin('reload-plugins', 'Reload active plugins'),
  builtin('reload-skills', 'Re-scan skills and commands'),
  builtin('rename', 'Rename this session'),
  builtin('resume', 'Resume another conversation', T),
  builtin('review', 'Review the current diff, a PR or a branch'),
  builtin('rewind', 'Rewind the conversation or code', T),
  builtin('security-review', 'Review the branch for security issues'),
  builtin('skills', 'List available skills', T),
  builtin('status', 'Show version, model and account', T),
  builtin('statusline', "Configure Claude Code's status line"),
  builtin('tasks', 'View and manage background work', T),
  builtin('theme', 'Change the color theme', T),
  builtin('usage', 'Show plan usage limits', T),
]

// Codex 0.162.0 built-ins (codex-rs/tui/src/slash_command.rs at tag
// rust-v0.162.0), without the aliases, /mention (it only types "@"), those
// tied to an OS, a host app or a feature flag (/app, /daybreak, /ide,
// /setup-default-sandbox, /voice) and the debug ones. /exit comes first; the
// rest are in alphabetical order. A command missing here can still be typed.
export const CODEX_BUILTIN_COMMANDS: SlashCommand[] = [
  builtin('exit', 'Exit Codex', { confirm: true }),
  builtin('agents', 'Open the agent command center', T),
  builtin('approve', 'Approve one retry of a recent auto-review denial', T),
  builtin('apps', 'Manage apps', T),
  builtin('archive', 'Archive this session', T),
  builtin('btw', 'Start a side conversation in an ephemeral fork', T),
  builtin('cd', 'Change the current working directory'),
  builtin('clear', 'Clear the terminal and start a new chat'),
  builtin('compact', 'Summarize the conversation to free up context'),
  builtin('copy', 'Copy the last response or part of it', T),
  builtin('daemon', 'Manage the local background server', T),
  builtin('debug-config', 'Show config layers and requirement sources', T),
  builtin('delete', 'Permanently delete this session', T),
  builtin('diff', 'Show the git diff, untracked files included', T),
  builtin('experimental', 'Toggle experimental features', T),
  builtin('export', 'Export the conversation as Markdown', T),
  builtin('feedback', 'Send logs to the maintainers', T),
  builtin('fork', 'Fork the current chat', T),
  builtin('goal', 'Set or view the goal of a long-running task'),
  builtin('hooks', 'View and manage lifecycle hooks', T),
  builtin('import', 'Import setup, this project and chats from Claude Code', T),
  builtin('init', 'Create an AGENTS.md file with instructions for Codex'),
  builtin('keymap', 'Remap TUI shortcuts', T),
  builtin('logout', 'Log out of Codex', { confirm: true }),
  builtin('mcp', 'List MCP tools', T),
  builtin('memories', 'Configure memory use and generation', T),
  builtin('model', 'Choose the model and reasoning effort', T),
  builtin('new', 'Start a new chat', T),
  builtin('permissions', 'Choose what Codex is allowed to do', T),
  builtin('pets', 'Choose or hide the terminal pet', T),
  builtin('plan', 'Switch to Plan mode'),
  builtin('plugins', 'Browse plugins', T),
  builtin('ps', 'List background terminals', T),
  builtin('pwd', 'Show the current working directory', T),
  builtin('raw', 'Toggle raw scrollback mode'),
  builtin('recap', 'Summarize the conversation now'),
  builtin('rename', 'Rename the current thread'),
  builtin('resume', 'Resume a saved chat', T),
  builtin('review', 'Review the current changes and find issues'),
  builtin('side', 'Start a side conversation in an ephemeral fork', T),
  builtin('skills', 'Use skills to improve how Codex performs tasks', T),
  builtin('status', 'Show the session configuration and token usage', T),
  builtin('statusline', 'Configure the items of the status line', T),
  builtin('stop', 'Stop all background terminals'),
  builtin('subagents', "Switch between this session's subagents", T),
  builtin('theme', 'Choose a syntax highlighting theme', T),
  builtin('title', 'Configure the items of the terminal title', T),
  builtin('tui', 'Choose the TUI mode for the next launch', T),
  builtin('usage', 'View account usage or use a usage limit reset', T),
  builtin('vim', 'Toggle Vim mode for the composer'),
  builtin('warnings', 'View retained warnings and diagnostic details', T),
  builtin('worktree', 'Start or continue a conversation in a new worktree', T),
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

// Names starting with the query first, then those holding it in the name or
// the description; each group keeps the list's order.
export function filterSlashCommands(
  commands: SlashCommand[],
  query: string,
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
      (c.description ?? '').toLowerCase().includes(q)
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
