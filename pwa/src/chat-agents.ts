// Agents the Chat view knows, apart from app-views.ts so the chat components
// can ask about an agent without importing the registry that imports them.

// The server reads these agents' transcripts: the Chat view is offered.
export const CHAT_AGENTS = ['claude', 'codex', 'opencode']
// The server also reads these agents' screens (OpenCode: its service's API):
// a message can be sent and a dialog answered. The others are read only.
export const CHAT_INPUT_AGENTS = ['claude', 'codex', 'opencode']

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

// The server reads these agents' session files: their tokens and the files
// a session changed are shown.
const SESSION_FILES_AGENTS = ['claude', 'codex']

export const sessionFilesAgent = (name?: string) =>
  !!name && SESSION_FILES_AGENTS.includes(name)

export const chatAgent = (name?: string) => !!name && CHAT_AGENTS.includes(name)

export const chatInputAgent = (name?: string) =>
  !!name && CHAT_INPUT_AGENTS.includes(name)

// The agent's name as its users know it
export const agentLabel = (name?: string) =>
  (name && AGENT_LABELS[name]) || 'agent'
