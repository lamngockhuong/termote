// Slash commands offered by the Chat composer: the agent's built-ins plus the
// custom commands and skills of the project, the user and the enabled plugins
// (read by the server).

export type SlashCommandSource = 'builtin' | 'project' | 'user' | 'plugin'

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

// Built-ins per agent, by the name the server reports (session.agentName).
export const BUILTIN_COMMANDS: Record<string, SlashCommand[]> = {
  claude: CLAUDE_BUILTIN_COMMANDS,
}

// Built-ins first, then the project's, then the user's; a name met again is
// left out, as the first one is what the agent runs.
export function mergeSlashCommands(...lists: SlashCommand[][]): SlashCommand[] {
  const seen = new Set<string>()
  const out: SlashCommand[] = []
  for (const c of lists.flat()) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
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

// The text typed after "/" while the message is still only a command name,
// else null: a command is recognized only at the start, and a space ends it.
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text)
  return m ? m[1] : null
}

// The listed command a message runs, if any: its first word after "/".
export function commandOf(
  text: string,
  commands: SlashCommand[],
): SlashCommand | undefined {
  const m = /^\s*\/(\S+)/.exec(text)
  if (!m) return undefined
  // /quit is Claude Code's alias of /exit
  const name = m[1] === 'quit' ? 'exit' : m[1]
  return commands.find((c) => c.name === name)
}
