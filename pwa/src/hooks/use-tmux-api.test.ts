import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWindow,
  fetchTerminalToken,
  fetchWindows,
  killWindow,
  renameWindow,
  selectWindow,
  sendKeys,
} from './use-tmux-api'

// Helper: create a mock fetch that captures calls and returns responses
function mockFetch(...responses: Array<{ body: unknown; status?: number }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let callIndex = 0
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    const resp = responses[Math.min(callIndex++, responses.length - 1)]
    return new Response(JSON.stringify(resp.body), {
      status: resp.status ?? 200,
    })
  })
  vi.stubGlobal('fetch', spy)
  return { spy, calls }
}

describe('tmux API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('fetchWindows returns windows array', async () => {
    const mockWindows = [
      { id: 0, name: 'shell', active: true },
      { id: 1, name: 'dev', active: false },
    ]
    const { calls } = mockFetch({ body: { windows: mockWindows } })
    const result = await fetchWindows()
    expect(result).toEqual(mockWindows)
    expect(calls[0].url).toBe('/api/tmux/windows')
  })

  it('fetchWindows returns empty array when no windows key', async () => {
    mockFetch({ body: {} })
    const result = await fetchWindows()
    expect(result).toEqual([])
  })

  it('selectWindow sends POST request', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    const result = await selectWindow(1)
    expect(result).toBe(true)
    expect(calls[0].url).toBe('/api/tmux/select/1')
    expect(calls[0].init?.method).toBe('POST')
  })

  it('createWindow with name encodes URL', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    await createWindow('my session')
    expect(calls[0].url).toBe('/api/tmux/new?name=my%20session')
    expect(calls[0].init?.method).toBe('POST')
  })

  it('createWindow without name uses base URL', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    await createWindow()
    expect(calls[0].url).toBe('/api/tmux/new')
  })

  it('killWindow sends DELETE request', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    const result = await killWindow(2)
    expect(result).toBe(true)
    expect(calls[0].url).toBe('/api/tmux/kill/2')
    expect(calls[0].init?.method).toBe('DELETE')
  })

  it('renameWindow sends POST with encoded name', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    await renameWindow(1, 'new name')
    expect(calls[0].url).toBe('/api/tmux/rename/1?name=new%20name')
    expect(calls[0].init?.method).toBe('POST')
  })

  it('sendKeys sends POST with JSON body', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    await sendKeys('0', 'ls -la')
    expect(calls[0].url).toBe('/api/tmux/send-keys')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.headers).toEqual({
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      target: '0',
      keys: 'ls -la',
    })
  })

  it('fetchTerminalToken returns token string', async () => {
    mockFetch({ body: { token: 'abc123' } })
    const token = await fetchTerminalToken()
    expect(token).toBe('abc123')
  })

  it('fetchTerminalToken retries on 503', async () => {
    const { spy } = mockFetch(
      { body: {}, status: 503 },
      { body: { token: 'retry-ok' }, status: 200 },
    )
    const token = await fetchTerminalToken()
    expect(token).toBe('retry-ok')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('fetchTerminalToken throws on non-retryable error', async () => {
    mockFetch({ body: {}, status: 401 })
    await expect(fetchTerminalToken()).rejects.toThrow(
      'Token request failed: 401',
    )
  })

  it('fetchTerminalToken throws after max retries', async () => {
    const { spy } = mockFetch({ body: {}, status: 503 })
    await expect(fetchTerminalToken()).rejects.toThrow(
      'Token request failed: 503',
    )
    expect(spy).toHaveBeenCalledTimes(3)
  })
})
