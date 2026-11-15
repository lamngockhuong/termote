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

// The server reads these agents' session files: the files a session
// changed are shown.
const SESSION_FILES_AGENTS = ['claude', 'codex']

export const sessionFilesAgent = (name?: string) =>
  !!name && SESSION_FILES_AGENTS.includes(name)

// These agents record a session's cost themselves, at the prices of the
// user's provider; termote's price table prices the others.
const REPORTED_COST_AGENTS = ['opencode']

export const reportedCostAgent = (name?: string) =>
  !!name && REPORTED_COST_AGENTS.includes(name)

// The server reads these agents' subagents: a card and the Chat view show
// the tree.
const SUBAGENT_AGENTS = ['claude', 'opencode']

export const subagentAgent = (name?: string) =>
  !!name && SUBAGENT_AGENTS.includes(name)

// The server serves the images of these agents' old sessions too (OpenCode:
// through its service), so the history's reader opens them.
const HISTORY_IMAGE_AGENTS = ['opencode']

export const historyImageAgent = (name?: string) =>
  !!name && HISTORY_IMAGE_AGENTS.includes(name)

export const chatAgent = (name?: string) => !!name && CHAT_AGENTS.includes(name)

export const chatInputAgent = (name?: string) =>
  !!name && CHAT_INPUT_AGENTS.includes(name)

// The agent's name as its users know it
export const agentLabel = (name?: string) =>
  (name && AGENT_LABELS[name]) || 'agent'
