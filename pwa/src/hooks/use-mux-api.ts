const API_BASE = '/api/mux'

// /api/mux/* version this bundle speaks; must match apiVersion in
// server/mux.go. A server reporting another version gets a reload.
export const MUX_API_VERSION = 2

// A read the network swallows (a stalled connection, replies dropped on the
// way) fails after this long, body included, instead of waiting forever.
export const REQUEST_TIMEOUT_MS = 10_000

export interface MuxAgent {
  name: string
  status: string
}

// A pane's foreground process: the first word of its name (never its
// arguments) and its directory.
export interface MuxProcess {
  name: string
  cwd?: string
}

export interface MuxPane {
  id: string
  active: boolean
  title?: string
  agent?: MuxAgent
  process?: MuxProcess
}

export interface MuxTab {
  id: string
  // Names the same tab while its id changes (a tmux window id, @N: a move
  // shifts window indexes); Herdr's is the id. Absent from an older server.
  key?: string
  name: string
  active: boolean
  panes: MuxPane[]
  // Every pane's process, in pane order, when panes lists only some of them
  // (tmux: only the window's active pane).
  processes?: MuxProcess[]
}

// A group's place in a Herdr worktree group: a linked worktree, or the
// repository's own checkout. branch is read in the background, so it can
// be missing for a moment.
export interface MuxGroupWorktree {
  linked: boolean
  branch?: string
}

export interface MuxGroup {
  id: string
  name: string
  tabs: MuxTab[]
  worktree?: MuxGroupWorktree
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
    // A pane's history and screen can be read as plain text (/panes/{id}/text);
    // not for a view-only client.
    paneText?: boolean
    // The client can take over the pane size (herdr's control mode).
    driveSize?: boolean
    // The agent routes (/agent/*) work: transcript, message, prompt.
    agentChat?: boolean
    // The files routes (/files/*) work: the backend reports a pane's directory.
    files?: boolean
    // The server takes image uploads (/uploads).
    uploads?: boolean
    // The server keeps deleted files for an Undo (files/delete, files/restore).
    trash?: boolean
    // Sign-in is on: the session can be ended (/logout).
    auth?: boolean
    // Groups (tmux sessions, Herdr workspaces) can be created, renamed and
    // closed (/groups).
    groups?: boolean
    // The server sends Web Push when an agent needs the user (/push).
    push?: boolean
    // Claude Code can be started in a pane that shows only its shell
    // (/agent/start): Herdr 0.8.2 or later.
    agentStart?: boolean
    // Git worktree workspaces can be listed, created, opened and removed
    // (/worktrees): Herdr 0.9.2 or later, not on Windows.
    worktrees?: boolean
    // Codex can be started too (it has a Chat view on this server's OS).
    agentStartCodex?: boolean
    // A tab can be moved within its group (/tabs/{id}/move): Herdr 0.8.0
    // or later, tmux 3.2 or later, not psmux nor Herdr on Windows.
    reorderTabs?: boolean
    // A group can be moved (/groups/{id}/move): Herdr only.
    reorderGroups?: boolean
    // What this client may do: "view" changes nothing on the server (every
    // write is refused with 403 view_only). Absent without sign-in.
    role?: 'full' | 'view'
    // Devices can be paired, listed and revoked (/api/mux/devices*).
    devices?: boolean
    // The browsers signed in with the password can be listed and signed
    // out (/api/mux/signins*): sign-in is on.
    signins?: boolean
    // View-only role: the backend can stream a pane to it (tmux 3.2 or
    // later, Herdr); off, the stream is refused.
    viewStream?: boolean
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
  const data = await res.json()
  if (res.status === 403 && data?.code === 'view_only') reportViewOnly()
  return data
}

// A write the server refused because this device is view-only: the UI hides
// every way to write, so this only fires for one it missed, told once here
// instead of by each caller.
const viewOnlyRefusals = new EventTarget()

function reportViewOnly() {
  viewOnlyRefusals.dispatchEvent(new Event('refused'))
}

export function onViewOnlyRefusal(listener: () => void): () => void {
  viewOnlyRefusals.addEventListener('refused', listener)
  return () => viewOnlyRefusals.removeEventListener('refused', listener)
}

const tabPath = (id: string) => `/tabs/${encodeURIComponent(id)}`

// The session ended (24h, or a server restart) and the page was served by
// the service worker, so the server could not ask for credentials itself.
// An iOS home-screen app never shows the Basic auth prompt either: open the
// server's sign-in page, which comes back here once signed in.
export function signInUrl(): string {
  const { pathname, search, hash } = window.location
  // The pairing page is never a place to come back to: its code is spent.
  if (pathname === '/pair') return '/login'
  return `/login?next=${encodeURIComponent(pathname + search + hash)}`
}

async function readJSON<T>(
  res: Response,
  signIn: (url: string) => void,
): Promise<T> {
  if (res.status === 401) {
    signIn(signInUrl())
    throw new RequestError(401, 'unauthorized', 'sign-in required')
  }
  // A failed read ({"error": ...}) is no snapshot: reading it as one would
  // crash on the missing caps instead of reporting the server unreachable.
  if (!res.ok) throw await requestError(res)
  return res.json()
}

const openSignIn = (url: string) => window.location.assign(url)

// The snapshot is polled and the health read on load, so a session that
// ended is noticed within one poll.
export async function fetchSnapshot(signIn = openSignIn): Promise<MuxSnapshot> {
  return readJSON(
    await fetch(`${API_BASE}/snapshot`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    signIn,
  )
}

// How the server was installed, which names the way to update it.
export type InstallKind = 'release' | 'checkout' | 'container' | 'unknown'

export interface Health {
  apiVersion?: number
  // The server binary's version (absent before 1.14)
  version?: string
  install?: InstallKind
}

export async function fetchHealth(signIn = openSignIn): Promise<Health> {
  return readJSON(
    await fetch(`${API_BASE}/health`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    signIn,
  )
}

// Ends this browser's session on the server and expires its cookie.
// Resolves to whether the server did.
export async function logout(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return res.ok
}

// The server's Web Push key (caps.push): a subscription's
// applicationServerKey, base64url.
export async function getPushKey(): Promise<string> {
  const res = await fetch(`${API_BASE}/push/key`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
  const body = await res.json()
  return body.publicKey
}

async function pushWrite(
  method: 'POST' | 'DELETE',
  body: unknown,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/push/subscribe`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw await requestError(res)
}

// Stores this device's subscription on the server (repeating it is no
// harm). Throws RequestError when refused (invalid_endpoint, invalid_keys,
// push_unavailable).
export function subscribePush(
  sub: PushSubscriptionJSON,
  signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
): Promise<void> {
  return pushWrite('POST', { endpoint: sub.endpoint, keys: sub.keys }, signal)
}

// Removes this device's subscription from the server.
export function unsubscribePush(
  endpoint: string,
  signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
): Promise<void> {
  return pushWrite('DELETE', { endpoint }, signal)
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

// A close or rename of a tab: with its key, the server acts only while the
// id still names that tab, else throws RequestError 'changed' (409).
async function tabWrite(
  method: 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<boolean> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 409) throw await requestError(res)
  const data = await res.json()
  return data.ok === true
}

export function closeTab(id: string, key?: string): Promise<boolean> {
  const query = key ? `?key=${encodeURIComponent(key)}` : ''
  return tabWrite('DELETE', tabPath(id) + query)
}

export function renameTab(
  id: string,
  name: string,
  key?: string,
): Promise<boolean> {
  return tabWrite('PATCH', tabPath(id), { name, key })
}

// A move answers within the server's 5 s wait for another move plus 5 s
// for its own: the client waits a little longer, so a move that worked is
// never reported as failed.
export const MOVE_REQUEST_TIMEOUT_MS = 15_000

// Moves a tab to position index (0-based) of its group and resolves to its
// id afterwards (a tmux id is a window index, which a move changes).
// Refusals throw RequestError (invalid_index, busy, unsupported, ...).
export async function moveTab(id: string, index: number): Promise<string> {
  const data = await groupWrite(
    'POST',
    `${tabPath(id)}/move`,
    { index },
    MOVE_REQUEST_TIMEOUT_MS,
  )
  return data.id ?? id
}

const groupPath = (id: string) => `/groups/${encodeURIComponent(id)}`

// A group (or move) write; a refusal throws RequestError with the server's code (empty
// when a guard in front of the route answered).
async function groupWrite(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ id?: string; alreadyOpen?: boolean }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw await requestError(res)
  return res.json()
}

// Opens a group (tmux session, Herdr workspace) starting in cwd (the host's
// home directory when empty) and returns its id.
export async function createGroup(name: string, cwd = ''): Promise<string> {
  const data = await groupWrite('POST', '/groups', { name, cwd })
  return data.id ?? ''
}

export async function renameGroup(id: string, name: string): Promise<void> {
  await groupWrite('PATCH', groupPath(id), { name })
}

// Ends the group and everything running in it.
export async function closeGroup(id: string): Promise<void> {
  await groupWrite('DELETE', groupPath(id))
}

// Moves a group to position index (0-based) among the groups that can move
// (not a Herdr linked worktree, which moves with its repository's).
export async function moveGroup(id: string, index: number): Promise<void> {
  await groupWrite(
    'POST',
    `${groupPath(id)}/move`,
    { index },
    MOVE_REQUEST_TIMEOUT_MS,
  )
}

// A create or remove answers once git is done: the server waits up to 5s
// for another change, then 60s for git.
export const WORKTREE_REQUEST_TIMEOUT_MS = 75_000

// One checkout of a workspace's repository, its main one included.
// openable: a linked worktree on a branch, which Open worktree can open.
// groupId: the workspace showing it, when one does.
export interface Worktree {
  path: string
  branch?: string
  linked: boolean
  openable: boolean
  groupId?: string
}

export interface WorktreeList {
  repoName: string
  worktrees: Worktree[]
  // Local branches, most recently committed first: bases of a new branch.
  branches: string[]
}

// The worktrees of the workspace's repository and its local branches.
export async function listWorktrees(groupId: string): Promise<WorktreeList> {
  const res = await fetch(
    `${API_BASE}/worktrees?groupId=${encodeURIComponent(groupId)}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  )
  if (!res.ok) throw await requestError(res)
  return res.json()
}

// A worktree change that ran out of time may still finish in Herdr: the
// client cannot tell, so it is reported as the server's unknown.
async function worktreeWrite(
  method: 'POST' | 'DELETE',
  path: string,
  body: unknown,
  timeoutMs: number,
) {
  try {
    return await groupWrite(method, path, body, timeoutMs)
  } catch (err) {
    const name = (err as Error)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new RequestError(0, 'unknown', 'no answer in time')
    }
    throw err
  }
}

// Checks out branch in a new worktree of the workspace's repository, made
// from base ('' for the current HEAD) when it is a new branch, and returns
// the new workspace's id.
export async function createWorktree(w: {
  groupId: string
  branch: string
  base: string
  label: string
}): Promise<string> {
  const data = await worktreeWrite(
    'POST',
    '/worktrees',
    w,
    WORKTREE_REQUEST_TIMEOUT_MS,
  )
  return data.id ?? ''
}

// Opens the existing worktree of branch and returns its workspace's id.
export async function openWorktree(
  groupId: string,
  branch: string,
): Promise<string> {
  const data = await worktreeWrite(
    'POST',
    '/worktrees/open',
    { groupId, branch },
    REQUEST_TIMEOUT_MS,
  )
  return data.id ?? ''
}

// Deletes the worktree workspace groupId shows and closes it. path and
// branch are what the user confirmed: the server removes nothing else.
export async function removeWorktree(
  groupId: string,
  w: { force: boolean; path: string; branch: string },
): Promise<void> {
  await worktreeWrite(
    'DELETE',
    `/worktrees/${encodeURIComponent(groupId)}`,
    w,
    WORKTREE_REQUEST_TIMEOUT_MS,
  )
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

// Default and largest history a pane text read asks for (server/mux_pane_text.go)
export const PANE_TEXT_LINES = 1000
export const PANE_TEXT_MAX_LINES = 5000

export interface PaneText {
  text: string
  lines: number
  // The oldest lines were cut at the server's size limit
  truncated: boolean
  // The pane holds history past what was read
  more?: boolean
}

// A pane's plain text: lines rows of history and its screen
export async function fetchPaneText(
  paneId: string,
  lines: number,
  signal?: AbortSignal,
): Promise<PaneText> {
  const res = await fetch(
    `${API_BASE}/panes/${encodeURIComponent(paneId)}/text?lines=${lines}`,
    { signal },
  )
  if (!res.ok) throw await requestError(res, true)
  return res.json()
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
  // What a tool call's card shows beyond the one-line input
  detail?: ToolDetail
}

export interface ToolDetail {
  // The description the model gave the call
  description?: string
  // A command whole (Bash, a Codex command)
  command?: string
  // Replacements of an edit; a new file (Write) has only new
  edits?: { old?: string; new?: string }[]
  clipped?: boolean
  // The edits of a sensitive file were left out
  hidden?: boolean
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

// A refused request: the HTTP status and the server's stable code.
export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly limit?: number,
    // prompt_changed: the dialog now on screen (null when none)
    readonly prompt?: AgentPrompt | null,
    // files 409: the pane's root now
    readonly root?: string,
    // message 400: the attached upload ids the server no longer has
    readonly images?: string[],
    // files/create 409 exists: the name taken, as the server cleaned it
    readonly path?: string,
    // files/delete 409 changed: a swapped file that stayed in the trash
    readonly trashId?: string,
  ) {
    super(message)
  }
}

// The agent routes' name for it, kept for their callers
export { RequestError as AgentRequestError }

// read: a refusal of a read, which its view tells in place (a view-only
// device reads files in a git repository only), never in the toast that a
// poll would repeat.
async function requestError(
  res: Response,
  read = false,
): Promise<RequestError> {
  const body = await res.json().catch(() => ({}))
  if (!read && res.status === 403 && body.code === 'view_only') {
    reportViewOnly()
  }
  return new RequestError(
    res.status,
    body.code ?? '',
    body.error ?? `request failed: ${res.status}`,
    body.limit,
    body.prompt,
    body.root,
    body.images,
    body.path,
    body.trashId,
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
  if (!res.ok) throw await requestError(res)
  return res.json()
}

// Sends text, after the uploaded images (ids from /uploads), to the agent as
// one message. Throws AgentRequestError when the server refuses (the screen
// is not an empty input box, the session changed, an image is gone).
export async function sendAgentMessage(
  paneId: string,
  text: string,
  cursor: string,
  images: string[] = [],
): Promise<void> {
  const res = await fetch(agentPath(paneId, 'message'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      images.length > 0 ? { text, cursor, images } : { text, cursor },
    ),
  })
  if (!res.ok) throw await requestError(res)
}

// The agents a pane can start, with the arguments the server picks.
export type StartAgentKind = 'claude' | 'codex'

// How a start goes: starting until the agent is ready for a message, asks
// something first (blocked), ends (exited) or never gets ready (timeout).
export type AgentStartState =
  | 'starting'
  | 'ready'
  | 'blocked'
  | 'exited'
  | 'timeout'

// A start may wait for a shell and make several Herdr calls (about 22 s at
// worst on the server): waited for longer than a read.
export const START_REQUEST_TIMEOUT_MS = 30_000

// Asks the server to start kind in the pane's shell. Resolves once the
// command is typed, not once the agent is ready (agentStartState). Throws
// RequestError when refused (pane_busy, starting, unsupported, ...).
export async function startAgent(
  paneId: string,
  kind: StartAgentKind,
): Promise<void> {
  const res = await fetch(agentPath(paneId, 'start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind }),
    signal: AbortSignal.timeout(START_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
}

// The state of this server's latest start in the pane. Throws RequestError
// no_start (404) when there is none.
export async function agentStartState(
  paneId: string,
): Promise<{ kind: StartAgentKind; state: AgentStartState }> {
  const res = await fetch(agentPath(paneId, 'start'), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
  return res.json()
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
  // The question's "Type something" option, empty: answered with text
  freeText?: { index: number; label: string }
}

export async function fetchAgentPrompt(
  paneId: string,
): Promise<AgentPrompt | null> {
  const res = await fetch(agentPath(paneId, 'prompt'))
  if (!res.ok) throw await requestError(res)
  return (await res.json()).prompt
}

// A custom command or skill of the pane's project, its user or an enabled
// plugin, as listed by /agent/commands: never the file's body.
export interface AgentCommand {
  name: string
  description?: string
  source: 'project' | 'user' | 'plugin'
  kind: 'command' | 'skill'
}

export async function fetchAgentCommands(
  paneId: string,
): Promise<AgentCommand[]> {
  const res = await fetch(agentPath(paneId, 'commands'))
  if (!res.ok) throw await requestError(res)
  return (await res.json()).commands ?? []
}

// An answer to the dialog promptId names: an option's number, Escape, Right
// on a multiSelect tab, another tab of a question in several parts, or text
// typed into the question's free-text option
export type AgentChoice =
  | number
  | 'cancel'
  | 'next'
  | { step: number }
  | { text: string }

// The server's limit on a typed answer, in UTF-8 bytes
export const MAX_FREE_TEXT_BYTES = 1024

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
  if (!res.ok) throw await requestError(res)
}

// Files and changes (/api/mux/panes/{id}/files/*): reads, saves of a text
// file (saveFileContent) and creates of an empty one (createFile). Shapes match
// server/files.go and server/files_git.go. Every response carries the pane's
// root; a request sent with the root it saw gets a 409 with the new one once
// the pane's directory moves.

export interface FileEntry {
  name: string
  type: 'dir' | 'file' | 'symlink' | 'other'
  // What a symlink inside the root leads to; absent when it leaves the root
  target?: 'dir' | 'file' | 'other'
  size: number
  sensitive: boolean
}

export interface FilesTree {
  root: string
  isRepo: boolean
  path: string
  entries: FileEntry[]
  truncated: boolean
}

// A text file. hash: the sha256 of its bytes, sent back as a save's
// baseHash. editable: a save would be taken; notEditable says why not
// (symlink, hardlink, not-writable, other-owner, mixed-eol, nul,
// denied-write, ...).
export interface TextFileContent {
  root: string
  path: string
  size: number
  text: string
  hash: string
  editable: boolean
  notEditable?: string
}

export type FileContent =
  | TextFileContent
  | {
      root: string
      path: string
      size: number
      previewable: false
      reason: 'binary' | 'too-large' | 'not-regular'
    }
  // A file that usually holds secrets, asked for without reveal
  | { root: string; path: string; sensitive: true }

export interface ChangeEntry {
  path: string
  // The source of a rename or copy
  orig?: string
  // Index against HEAD (M A D R C T); worktree against the index (M D T, or
  // ? untracked). "" is unchanged on that side.
  staged: string
  unstaged: string
  conflict?: boolean
  sensitive: boolean
}

export interface GitChanges {
  root: string
  isRepo: boolean
  branch?: string
  entries: ChangeEntry[]
  truncated: boolean
}

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del'
  old?: number
  new?: number
  text: string
  noNewline?: boolean
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface FileDiff {
  root: string
  path: string
  binary?: boolean
  conflict?: boolean
  truncated: boolean
  sensitive?: boolean
  // A file read whole (untracked, conflict) that cannot be shown
  reason?: 'too-large' | 'not-regular'
  hunks: DiffHunk[] | null
}

// A list sends the parameter once per value (exclude=a&exclude=b)
function filesUrl(
  paneId: string,
  op: string,
  query: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query))
    for (const one of Array.isArray(v) ? v : [v]) if (one) params.append(k, one)
  const qs = params.toString()
  return `${API_BASE}/panes/${encodeURIComponent(paneId)}/files/${op}${qs ? `?${qs}` : ''}`
}

async function filesGet<T>(
  paneId: string,
  op: string,
  query: Record<string, string | undefined>,
): Promise<T> {
  const res = await fetch(filesUrl(paneId, op, query))
  if (!res.ok) throw await requestError(res, true)
  return res.json()
}

// One directory ("" is the root). root: the root the client saw, if any.
export function fetchFilesTree(
  paneId: string,
  path: string,
  root?: string,
): Promise<FilesTree> {
  return filesGet(paneId, 'tree', { path, root })
}

export function fetchFileContent(
  paneId: string,
  path: string,
  opts: { root?: string; reveal?: boolean } = {},
): Promise<FileContent> {
  return filesGet(paneId, 'content', {
    path,
    root: opts.root,
    reveal: opts.reveal ? '1' : undefined,
  })
}

// A save gets longer than a read: up to 6 MiB of JSON from a slow link.
export const SAVE_TIMEOUT_MS = 30_000

export interface SavedFile {
  root: string
  path: string
  size: number
  hash: string
}

// Replaces the whole text of path, read with baseHash, under root (the root
// it was read from: a 409 with the new one once it moved). A refusal is a
// RequestError with the server's code (changed, sensitive, permission,
// not_editable, not_text, too_large, busy); a timeout or a dropped
// connection throws something else, after which the save may or may not
// have been made (saving again is safe: the same text is not a conflict).
export async function saveFileContent(
  paneId: string,
  save: {
    root: string
    path: string
    baseHash: string
    text: string
    reveal: boolean
  },
): Promise<SavedFile> {
  const { root, ...body } = save
  const res = await fetch(filesUrl(paneId, 'content', { root }), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
  return res.json()
}

export interface CreatedFile {
  root: string
  path: string
}

// Creates path under root as an empty file, with the directories missing
// above it; never replaces anything. The text then goes through
// saveFileContent. A refusal is a RequestError with the server's code
// (exists, not_directory, symlink, not_allowed, sensitive, permission,
// invalid_name, busy), or a 409 with the root once it moved; a timeout or a
// dropped connection throws something else, after which the file may or may
// not have been made.
export async function createFile(
  paneId: string,
  create: { root: string; path: string; reveal: boolean },
): Promise<CreatedFile> {
  const { root, ...body } = create
  const res = await fetch(filesUrl(paneId, 'create', { root }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
  return res.json()
}

// One path files/find matched: ignored (a repo's ignored file, searched
// with ignored), sensitive (a name that usually holds secrets).
export interface FindResult {
  path: string
  ignored: boolean
  sensitive: boolean
}

// truncated: more than the 200 results matched. incomplete: the search
// stopped early in a large tree, so some files may be missing.
export interface FindResponse {
  root: string
  isRepo: boolean
  results: FindResult[]
  truncated: boolean
  incomplete: boolean
}

export interface FindQuery {
  q: string
  root?: string
  // A repo's ignored files too
  ignored: boolean
  // Directory names never searched for ignored files, nor outside a repo
  exclude: string[]
  // Read the file list again (the user refreshed)
  fresh?: boolean
}

// Files under the pane's root whose path matches q, best first
export async function findFiles(
  paneId: string,
  query: FindQuery,
  signal?: AbortSignal,
): Promise<FindResponse> {
  const url = filesUrl(paneId, 'find', {
    q: query.q,
    root: query.root,
    ignored: query.ignored ? '1' : undefined,
    exclude: query.exclude,
    fresh: query.fresh ? '1' : undefined,
  })
  const res = await fetch(url, { signal })
  if (!res.ok) throw await requestError(res, true)
  return res.json()
}

// A file's size and the sha256 a delete takes as its baseHash, never its
// contents (a sensitive file's too). hash is absent past 512 MiB, or for
// something other than a regular file.
export interface FileHash {
  root: string
  path: string
  size: number
  hash?: string
}

export function fetchFileHash(
  paneId: string,
  path: string,
  root?: string,
): Promise<FileHash> {
  return filesGet(paneId, 'content', { path, root, hash: '1' })
}

export interface DeletedFile {
  root: string
  path: string
  // In the trash under this id, for restoreFile; absent for a permanent delete
  trashId?: string
  size?: number
  permanent?: boolean
}

// Deletes path under root: a file (read with baseHash) goes to the trash, an
// empty directory is removed. permanent: the trash is on another file system
// and the user said to delete the file for good. A refusal is a
// RequestError with the server's code (cross_device, changed, not_empty,
// symlink, not_allowed, sensitive, permission, read_only, hardlink,
// too_large, busy, trash_unavailable), or a 409 with the root once it moved.
export async function deleteFile(
  paneId: string,
  del: {
    root: string
    path: string
    kind: 'file' | 'dir'
    baseHash?: string
    reveal: boolean
    permanent: boolean
  },
): Promise<DeletedFile> {
  const { root, ...body } = del
  const res = await fetch(filesUrl(paneId, 'delete', { root }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
  return res.json()
}

// Puts a deleted file (or directory) back at its path, never replacing
// anything there (409 exists).
export async function restoreFile(
  paneId: string,
  restore: { root: string; trashId: string; reveal: boolean },
): Promise<CreatedFile> {
  const { root, ...body } = restore
  const res = await fetch(filesUrl(paneId, 'restore', { root }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
  return res.json()
}

export function fetchGitChanges(
  paneId: string,
  root?: string,
): Promise<GitChanges> {
  return filesGet(paneId, 'changes', { root })
}

// The diff of one entry of fetchGitChanges, from its staged or unstaged side
export function fetchFileDiff(
  paneId: string,
  entry: { path: string; orig?: string },
  opts: { staged: boolean; root?: string; reveal?: boolean },
): Promise<FileDiff> {
  return filesGet(paneId, 'diff', {
    path: entry.path,
    orig: entry.orig,
    staged: opts.staged ? '1' : undefined,
    reveal: opts.reveal ? '1' : undefined,
    root: opts.root,
  })
}

// Which version of an image files/raw reads. Without side, the file in the
// working tree (Files view); with it, one side of a git status entry, as
// fetchFileDiff picks the entry (Changes view).
export interface ImageQuery {
  root?: string
  reveal?: boolean
  side?: 'old' | 'new'
  staged?: boolean
  orig?: string
}

// An image under the pane's root (server/files_raw.go), for a blob: URL.
// A refusal is a RequestError with the server's code (too_large,
// too_many_pixels, not_image, lfs_pointer, busy, no_version, sensitive).
export async function fetchFileImage(
  paneId: string,
  path: string,
  opts: ImageQuery = {},
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await fetch(
    filesUrl(paneId, 'raw', {
      path,
      orig: opts.orig,
      side: opts.side,
      staged: opts.staged ? '1' : undefined,
      reveal: opts.reveal ? '1' : undefined,
      root: opts.root,
    }),
    { signal },
  )
  if (!res.ok) throw await requestError(res, true)
  return res.blob()
}

// A paired device as /api/mux/devices lists it (never its token).
export interface PairedDevice {
  id: string
  name: string
  role: 'full' | 'view'
  createdAt: string
  lastUsedAt: string
  // The device this page runs on
  current: boolean
  // When it stops signing in (RFC 3339), null without a limit
  validUntil: string | null
  // Past validUntil: refused until revoked
  expired: boolean
  // "password" (a password sign-in, the CLI or a terminal), "unknown" (paired
  // before this was kept) or the id of the device that paired it
  pairedBy: string
  // That device's name, while it is still paired
  pairedByName?: string
}

// A pairing code: shown once, spent by the first device that enters it.
export interface PairingCode {
  // XXXXX-XXXXX
  code: string
  expiresAt: string
  // Seconds left when the server answered: counted from the reply, not
  // against this device's clock
  expiresIn?: number
  // /pair?code=… on the host this page reached
  url: string
  // The link as a QR code (data:image/png), drawn by the server
  qr?: string
  // How long the new device stays signed in once paired, in seconds, as the
  // server accepted it (cut to this device's own limit); 0 is no limit
  validFor?: number
}

// Lists the paired devices. Throws RequestError when refused (view_only,
// unsupported without sign-in or a usable state dir).
export async function fetchDevices(
  signal?: AbortSignal,
): Promise<PairedDevice[]> {
  const res = await fetch(`${API_BASE}/devices`, {
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
  return (await res.json()).devices ?? []
}

// Makes a code another device signs in with, for 5 minutes. An empty name
// lets that device name itself; validFor (seconds, null: no limit) is how
// long that device stays signed in. Throws RequestError (too_many_codes,
// invalid_name, invalid_role, invalid_validity, full_needs_password).
export async function createPairingCode(
  role: 'full' | 'view',
  name: string,
  validFor: number | null = null,
): Promise<PairingCode> {
  const res = await fetch(`${API_BASE}/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      validFor === null ? { role, name } : { role, name, validFor },
    ),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
  return res.json()
}

// A browser signed in with the password, as /api/mux/signins lists it
// (never its token or cookie).
export interface SignedInBrowser {
  // 16 hex characters
  id: string
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  // How it signed in: the sign-in form, Basic auth or a link from the CLI
  via: 'form' | 'basic' | 'link'
  // The address it signed in from (behind tailscale serve: loopback)
  ip: string
  // Cleaned by the server: no control or format characters, 200 bytes
  userAgent: string
  // The browser this page runs in
  current: boolean
}

export interface SignedInBrowsers {
  sessions: SignedInBrowser[]
  // This client may sign browsers out: a paired device only lists them
  canRevoke: boolean
}

// Lists the browsers signed in with the password. Throws RequestError when
// refused (view_only, unsupported without sign-in).
export async function fetchSignins(
  signal?: AbortSignal,
): Promise<SignedInBrowsers> {
  const res = await fetch(`${API_BASE}/signins`, {
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
  const body = await res.json()
  return { sessions: body.sessions ?? [], canRevoke: body.canRevoke === true }
}

// Signs one browser out: its next request is refused and its streams close.
// Throws RequestError (unknown_session, full_needs_password).
export async function revokeSignin(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/signins/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
}

// Signs out every browser but this one. Resolves to how many went.
export async function revokeOtherSignins(): Promise<number> {
  const res = await fetch(`${API_BASE}/signins`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
  const body = await res.json().catch(() => ({}))
  return typeof body.revoked === 'number' ? body.revoked : 0
}

// Revokes a device and every device it paired: their next requests are
// refused and their streams close. Resolves to the ids revoked, id first.
export async function revokeDevice(id: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw await requestError(res)
  const body = await res.json().catch(() => ({}))
  return Array.isArray(body.revoked) ? body.revoked : [id]
}
