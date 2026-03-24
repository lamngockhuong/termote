const API_BASE = '/api/tmux'

export interface TmuxWindow {
  id: number
  name: string
  active: boolean
}

export async function fetchWindows(): Promise<TmuxWindow[]> {
  const res = await fetch(`${API_BASE}/windows`)
  const data = await res.json()
  return data.windows || []
}

export async function selectWindow(id: number | string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/select/${id}`, { method: 'POST' })
  const data = await res.json()
  return data.ok === true
}

export async function createWindow(name?: string): Promise<boolean> {
  const url = name
    ? `${API_BASE}/new?name=${encodeURIComponent(name)}`
    : `${API_BASE}/new`
  const res = await fetch(url, { method: 'POST' })
  const data = await res.json()
  return data.ok === true
}

export async function killWindow(id: number | string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/kill/${id}`, { method: 'DELETE' })
  const data = await res.json()
  return data.ok === true
}

export async function renameWindow(
  id: number | string,
  name: string,
): Promise<boolean> {
  const res = await fetch(
    `${API_BASE}/rename/${id}?name=${encodeURIComponent(name)}`,
    { method: 'POST' },
  )
  const data = await res.json()
  return data.ok === true
}

export async function sendKeys(target: string, keys: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/send-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, keys }),
  })
  const data = await res.json()
  return data.ok === true
}

export async function fetchTerminalToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/terminal-token`)
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`)
  const data = await res.json()
  return data.token
}
