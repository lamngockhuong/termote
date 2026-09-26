import http from 'node:http'
import { test, expect, type APIRequestContext, type TestInfo } from '@playwright/test'

// The browser WebSocket API cannot set Origin or Host, so the handshakes here
// are sent with node:http and judged by the status the server answers with.

type Handshake = { status: number; upgraded: boolean }

function authHeader(testInfo: TestInfo): Record<string, string> {
  const creds = testInfo.project.use.httpCredentials
  if (!creds?.password) return {}
  const basic = Buffer.from(`${creds.username}:${creds.password}`).toString('base64')
  return { Authorization: `Basic ${basic}` }
}

function handshake(
  testInfo: TestInfo,
  path: string,
  headers: Record<string, string> = {},
): Promise<Handshake> {
  const base = new URL(testInfo.project.use.baseURL ?? 'http://localhost:7680')
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: base.hostname,
      port: base.port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('termote-e2e-key!').toString('base64'),
        ...authHeader(testInfo),
        ...headers,
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode ?? 0, upgraded: true })
    })
    req.on('response', (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0, upgraded: false })
    })
    req.on('error', reject)
    req.end()
  })
}

async function streamToken(request: APIRequestContext): Promise<string> {
  const res = await request.get('/api/mux/stream-token')
  expect(res.ok()).toBe(true)
  return (await res.json()).token
}

async function firstPane(request: APIRequestContext): Promise<string> {
  const snap = await (await request.get('/api/mux/snapshot')).json()
  return snap.groups[0].tabs[0].panes[0].id
}

test.describe('stream WebSocket guards', () => {
  test('same-origin handshake with a fresh token upgrades', async ({ request }, testInfo) => {
    const pane = await firstPane(request)
    const token = await streamToken(request)
    const origin = new URL(testInfo.project.use.baseURL ?? '').origin
    const res = await handshake(testInfo, `/api/mux/stream?pane=${pane}&token=${token}`, {
      Origin: origin,
    })
    expect(res).toEqual({ status: 101, upgraded: true })
  })

  test('a foreign Origin is rejected', async ({ request }, testInfo) => {
    const pane = await firstPane(request)
    const token = await streamToken(request)
    const res = await handshake(testInfo, `/api/mux/stream?pane=${pane}&token=${token}`, {
      Origin: 'https://evil.example',
    })
    expect(res).toEqual({ status: 403, upgraded: false })
  })

  test('a cross-site fetch context is rejected', async ({ request }, testInfo) => {
    const pane = await firstPane(request)
    const token = await streamToken(request)
    const res = await handshake(testInfo, `/api/mux/stream?pane=${pane}&token=${token}`, {
      'Sec-Fetch-Site': 'cross-site',
    })
    expect(res).toEqual({ status: 403, upgraded: false })
  })

  test('a missing token is rejected', async ({ request }, testInfo) => {
    const pane = await firstPane(request)
    const res = await handshake(testInfo, `/api/mux/stream?pane=${pane}`)
    expect(res).toEqual({ status: 401, upgraded: false })
  })

  test('a token works only once', async ({ request }, testInfo) => {
    const pane = await firstPane(request)
    const token = await streamToken(request)
    const path = `/api/mux/stream?pane=${pane}&token=${token}`
    expect((await handshake(testInfo, path)).upgraded).toBe(true)
    expect(await handshake(testInfo, path)).toEqual({ status: 401, upgraded: false })
  })

  test('the token endpoint refuses direct navigation', async ({ request }) => {
    const res = await request.get('/api/mux/stream-token', {
      headers: { 'Sec-Fetch-Dest': 'document' },
    })
    expect(res.status()).toBe(403)
  })
})

test.describe('write guards on send-keys', () => {
  const keysPath = async (request: APIRequestContext) =>
    `/api/mux/panes/${encodeURIComponent(await firstPane(request))}/keys`

  test('text/plain body is rejected', async ({ request }) => {
    const res = await request.post(await keysPath(request), {
      headers: { 'Content-Type': 'text/plain' },
      data: '{"keys":"echo csrf"}',
    })
    expect(res.status()).toBe(415)
  })

  test('cross-site request is rejected even with JSON', async ({ request }) => {
    const res = await request.post(await keysPath(request), {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
      data: { keys: 'echo csrf' },
    })
    expect(res.status()).toBe(403)
  })

  test('foreign Origin is rejected', async ({ request }) => {
    const res = await request.post(await keysPath(request), {
      headers: { Origin: 'https://evil.example' },
      data: { keys: 'echo csrf' },
    })
    expect(res.status()).toBe(403)
  })

  test('same-origin JSON is accepted', async ({ request }) => {
    const res = await request.post(await keysPath(request), { data: { keys: '' } })
    expect(res.ok()).toBe(true)
  })
})

test.describe('host allowlist', () => {
  test('a Host outside the allowlist is rejected', async ({ request }) => {
    const res = await request.get('/api/mux/health', { headers: { Host: 'rebind.example' } })
    expect(res.status()).toBe(403)
  })
})

test.describe('0.x client meets the 1.0 server', () => {
  test('the old /terminal/ iframe gets 410 JSON, not the app', async ({ request }) => {
    const res = await request.get('/terminal/')
    expect(res.status()).toBe(410)
    expect(res.headers()['content-type']).toContain('application/json')
  })

  test('old /api/tmux calls get JSON, never index.html', async ({ request }) => {
    for (const path of ['/api/tmux/windows', '/api/tmux/select/0', '/api/tmux/health']) {
      const res = await request.get(path)
      expect(res.status(), path).toBe(404)
      expect(res.headers()['content-type'], path).toContain('application/json')
    }
  })
})
