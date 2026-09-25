const API_BASE = '/api/mux'

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
  caps: { clientSideSelect: boolean; copyMode: boolean }
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

// Tabs of every group, flattened (tmux has exactly one group).
export async function fetchTabs(): Promise<MuxTab[]> {
  const snap = await fetchSnapshot()
  return (snap.groups || []).flatMap((g) => g.tabs)
}

export async function selectTab(id: string): Promise<boolean> {
  const data = await write('POST', `${tabPath(id)}/select`)
  return data.ok === true
}

export async function createTab(
  name?: string,
  groupId?: string,
): Promise<boolean> {
  const data = await write('POST', '/tabs', { groupId, name })
  return data.ok === true
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
