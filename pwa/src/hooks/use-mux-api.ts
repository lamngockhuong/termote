const API_BASE = '/api/mux'

// /api/mux/* version this bundle speaks; must match apiVersion in
// server/mux.go. A server reporting another version gets a reload.
export const MUX_API_VERSION = 1

export interface MuxAgent {
  name: string
  status: string
}

export interface MuxPane {
  id: string
  active: boolean
  title?: string
  agent?: MuxAgent
}

export interface MuxTab {
  id: string
  name: string
  active: boolean
  panes: MuxPane[]
}

export interface MuxGroup {
  id: string
  name: string
  tabs: MuxTab[]
}

export interface MuxSnapshot {
  apiVersion: number
  backend: string
  // scroll: history is scrolled by the backend (scrollPane), not by the
  // xterm.js scrollback, which only ever holds screen renders (herdr).
  caps: {
    clientSideSelect: boolean
    copyMode: boolean
    scroll?: boolean
    // The client can take over the pane size (herdr's control mode).
    driveSize?: boolean
    // The agent routes (/agent/*) work: transcript, message, prompt.
    agentChat?: boolean
    // The files routes (/files/*) work: the backend reports a pane's directory.
    files?: boolean
  }
  groups: MuxGroup[]
}

// State-changing calls always send JSON: the server rejects any other
// Content-Type on writes to block cross-site form posts.
async function write(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ ok?: boolean; id?: string }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json()
}

const tabPath = (id: string) => `/tabs/${encodeURIComponent(id)}`

export async function fetchSnapshot(): Promise<MuxSnapshot> {
  const res = await fetch(`${API_BASE}/snapshot`)
  return res.json()
}

export async function fetchHealth(): Promise<{ apiVersion?: number }> {
  const res = await fetch(`${API_BASE}/health`)
  return res.json()
}

export async function selectTab(id: string): Promise<boolean> {
  const data = await write('POST', `${tabPath(id)}/select`)
  return data.ok === true
}

// Resolves to the new tab's id, or null when the server refused.
export async function createTab(
  name?: string,
  groupId?: string,
): Promise<string | null> {
  const data = await write('POST', '/tabs', { groupId, name })
  return data.ok === true ? (data.id ?? '') : null
}

export async function closeTab(id: string): Promise<boolean> {
  const data = await write('DELETE', tabPath(id))
  return data.ok === true
}

export async function renameTab(id: string, name: string): Promise<boolean> {
  const data = await write('PATCH', tabPath(id), { name })
  return data.ok === true
}

// Closes one pane of a split tab (herdr); the tab stays with its other panes.
export async function closePane(paneId: string): Promise<boolean> {
  const data = await write('DELETE', `/panes/${encodeURIComponent(paneId)}`)
  return data.ok === true
}

export async function sendKeys(paneId: string, keys: string): Promise<boolean> {
  const data = await write(
    'POST',
    `/panes/${encodeURIComponent(paneId)}/keys`,
    { keys },
  )
  return data.ok === true
}

// Most rows one scrollPane call may move; the server rejects more.
export const MAX_SCROLL_LINES = 10000

// Moves the pane's view lines rows back into its history (negative: toward
// the live screen).
export async function scrollPane(
  paneId: string,
  lines: number,
): Promise<boolean> {
  const data = await write(
    'POST',
    `/panes/${encodeURIComponent(paneId)}/scroll`,
    { lines },
  )
  return data.ok === true
}

export async function fetchTerminalToken(): Promise<string> {
  const attempts = 3
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController()
    /* v8 ignore next */
    const timeout = setTimeout(() => ctrl.abort(), 5000)
    try {
      const res = await fetch(`${API_BASE}/stream-token`, {
        signal: ctrl.signal,
      })
      clearTimeout(timeout)
      const isRetryable =
        [502, 503, 504].includes(res.status) && i < attempts - 1
      if (isRetryable) {
        await delay(1000 * (i + 1))
        continue
      }
      if (!res.ok) throw new Error(`Token request failed: ${res.status}`)
      const data = await res.json()
      return data.token
    } catch (err) {
      clearTimeout(timeout)
      if (i < attempts - 1) {
        await delay(1000 * (i + 1))
        continue
      }
      throw err
    }
  }
  throw new Error('Token request failed after retries')
}

// Agent chat (/api/mux/panes/{id}/agent/*). Shapes match server/agent.go.

export interface TranscriptPart {
  kind: 'text' | 'thinking' | 'tool' | 'image'
  text?: string
  tool?: string
  toolId?: string
  // One-line summary of the tool input (a path, a command)
  input?: string
  result?: string
  isError?: boolean
  // A tool result whose call is not in this read; attached by toolId when
  // the call is known.
  orphan?: boolean
  clipped?: boolean
}

export interface TranscriptEntry {
  id: string
  ts?: string
  role: 'user' | 'assistant' | 'summary' | 'note'
  parts: TranscriptPart[]
}

export interface TranscriptPage {
  agent: string
  sessionId: string
  status: string
  entries: TranscriptEntry[]
  // Continues a forward read; empty on a reply to a before read
  cursor: string
  // Reads the entries older than this page; absent at the start
  before?: string
  // The entries replace everything held
  reset: boolean
}

// A refused agent request: the HTTP status and the server's stable code.
export class AgentRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly limit?: number,
    // prompt_changed: the dialog now on screen (null when none)
    readonly prompt?: AgentPrompt | null,
  ) {
    super(message)
  }
}

async function agentError(res: Response): Promise<AgentRequestError> {
  const body = await res.json().catch(() => ({}))
  return new AgentRequestError(
    res.status,
    body.code ?? '',
    body.error ?? `request failed: ${res.status}`,
    body.limit,
    body.prompt,
  )
}

const agentPath = (paneId: string, op: string) =>
  `${API_BASE}/panes/${encodeURIComponent(paneId)}/agent/${op}`

export async function fetchTranscript(
  paneId: string,
  query: { cursor?: string; before?: string } = {},
): Promise<TranscriptPage> {
  const params = new URLSearchParams()
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.before) params.set('before', query.before)
  const qs = params.toString()
  const res = await fetch(
    agentPath(paneId, 'transcript') + (qs ? `?${qs}` : ''),
  )
  if (!res.ok) throw await agentError(res)
  return res.json()
}

// Sends text to the agent as one message. Throws AgentRequestError when the
// server refuses (the screen is not an empty input box, the session changed).
export async function sendAgentMessage(
  paneId: string,
  text: string,
  cursor: string,
): Promise<void> {
  const res = await fetch(agentPath(paneId, 'message'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, cursor }),
  })
  if (!res.ok) throw await agentError(res)
}

// A dialog Claude Code has open. permission and select carry options and a
// single-use promptId; unsupported is shown only (answered in the terminal),
// as is a dialog whose id was just used.
export interface AgentPrompt {
  promptId?: string
  kind: 'permission' | 'select' | 'multiselect' | 'unsupported'
  title: string
  body?: string
  // checked: a multiSelect option ticked; its digit toggles it
  options?: {
    index: number
    label: string
    detail?: string
    checked?: boolean
  }[]
  // The tabs of a question with several parts, answered one tab at a time
  steps?: { label: string; answered?: boolean; current?: boolean }[]
}

export async function fetchAgentPrompt(
  paneId: string,
): Promise<AgentPrompt | null> {
  const res = await fetch(agentPath(paneId, 'prompt'))
  if (!res.ok) throw await agentError(res)
  return (await res.json()).prompt
}

// An answer to the dialog promptId names: an option's number, Escape, Right
// on a multiSelect tab, or another tab of a question in several parts
export type AgentChoice = number | 'cancel' | 'next' | { step: number }

export async function answerAgentPrompt(
  paneId: string,
  promptId: string,
  choice: AgentChoice,
): Promise<void> {
  const res = await fetch(agentPath(paneId, 'answer'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptId, choice }),
  })
  if (!res.ok) throw await agentError(res)
}
