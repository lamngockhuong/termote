const API_BASE = '/api/mux'

// /api/mux/* version this bundle speaks; must match apiVersion in
// server/mux.go. A server reporting another version gets a reload.
export const MUX_API_VERSION = 1

// A read the network swallows (a stalled connection, replies dropped on the
// way) fails after this long, body included, instead of waiting forever.
export const REQUEST_TIMEOUT_MS = 10_000

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
    // The server takes image uploads (/uploads).
    uploads?: boolean
    // Sign-in is on: the session can be ended (/logout).
    auth?: boolean
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

// The session ended (24h, or a server restart) and the page was served by
// the service worker, so the server could not ask for credentials itself.
// An iOS home-screen app never shows the Basic auth prompt either: open the
// server's sign-in page, which comes back here once signed in.
export function signInUrl(): string {
  const { pathname, search, hash } = window.location
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

export async function fetchHealth(
  signIn = openSignIn,
): Promise<{ apiVersion?: number }> {
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
  ) {
    super(message)
  }
}

// The agent routes' name for it, kept for their callers
export { RequestError as AgentRequestError }

async function requestError(res: Response): Promise<RequestError> {
  const body = await res.json().catch(() => ({}))
  return new RequestError(
    res.status,
    body.code ?? '',
    body.error ?? `request failed: ${res.status}`,
    body.limit,
    body.prompt,
    body.root,
    body.images,
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

function filesUrl(
  paneId: string,
  op: string,
  query: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, v)
  const qs = params.toString()
  return `${API_BASE}/panes/${encodeURIComponent(paneId)}/files/${op}${qs ? `?${qs}` : ''}`
}

async function filesGet<T>(
  paneId: string,
  op: string,
  query: Record<string, string | undefined>,
): Promise<T> {
  const res = await fetch(filesUrl(paneId, op, query))
  if (!res.ok) throw await requestError(res)
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
  if (!res.ok) throw await requestError(res)
  return res.blob()
}
