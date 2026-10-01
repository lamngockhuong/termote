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
