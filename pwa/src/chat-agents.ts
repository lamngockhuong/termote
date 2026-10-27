// Agents the Chat view knows, apart from app-views.ts so the chat components
// can ask about an agent without importing the registry that imports them.

// The server reads these agents' transcripts: the Chat view is offered.
export const CHAT_AGENTS = ['claude', 'codex']
// The server also reads these agents' screens: a message can be sent and a
// dialog answered. The others are read only.
export const CHAT_INPUT_AGENTS = ['claude', 'codex']

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

export const chatAgent = (name?: string) => !!name && CHAT_AGENTS.includes(name)

export const chatInputAgent = (name?: string) =>
  !!name && CHAT_INPUT_AGENTS.includes(name)

// The agent's name as its users know it
export const agentLabel = (name?: string) =>
  (name && AGENT_LABELS[name]) || 'agent'

// The column the conversation and the composer share: at most 896px wide,
// centred, so long lines stay readable on a wide screen and both edges line
// up. Here because the composer loads with the app and the Chat view lazily.
export const CHAT_COLUMN = 'mx-auto w-full max-w-4xl'
