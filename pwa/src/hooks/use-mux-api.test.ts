import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRequestError,
  answerAgentPrompt,
  closeTab,
  createTab,
  fetchAgentPrompt,
  fetchHealth,
  fetchSnapshot,
  fetchTerminalToken,
  fetchTranscript,
  renameTab,
  scrollPane,
  selectTab,
  sendAgentMessage,
  sendKeys,
} from './use-mux-api'

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

describe('mux API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const JSON_HEADERS = { 'Content-Type': 'application/json' }
  const tab = (id: string, name: string, active = false) => ({
    id,
    name,
    active,
    panes: [{ id, active }],
  })

  it('fetchSnapshot returns the snapshot', async () => {
    const snap = {
      apiVersion: 1,
      backend: 'tmux',
      caps: { clientSideSelect: false, copyMode: true },
      groups: [{ id: 'main', name: 'main', tabs: [tab('0', 'shell', true)] }],
    }
    const { calls } = mockFetch({ body: snap })
    expect(await fetchSnapshot()).toEqual(snap)
    expect(calls[0].url).toBe('/api/mux/snapshot')
  })

  it('fetchHealth reads the health route', async () => {
    const { calls } = mockFetch({ body: { status: 'ok', apiVersion: 1 } })
    expect(await fetchHealth()).toEqual({ status: 'ok', apiVersion: 1 })
    expect(calls[0].url).toBe('/api/mux/health')
  })

  it('selectTab sends JSON POST to the tab select route', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    expect(await selectTab('1')).toBe(true)
    expect(calls[0].url).toBe('/api/mux/tabs/1/select')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.headers).toEqual(JSON_HEADERS)
    expect(calls[0].init?.body).toBeUndefined()
  })

  it('selectTab encodes ids containing ":"', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    await selectTab('w1M:t2')
    expect(calls[0].url).toBe('/api/mux/tabs/w1M%3At2/select')
  })

  it('createTab posts name and group in the JSON body', async () => {
    const { calls } = mockFetch({ body: { ok: true, id: '3' } })
    expect(await createTab('my session', 'main')).toBe('3')
    expect(calls[0].url).toBe('/api/mux/tabs')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      groupId: 'main',
      name: 'my session',
    })
  })

  it('createTab without name sends an empty object', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    expect(await createTab()).toBe('')
    expect(calls[0].init?.body).toBe('{}')
  })

  it('createTab resolves to null when the server refuses', async () => {
    mockFetch({ body: { error: 'invalid tab name' } })
    expect(await createTab('bad name')).toBeNull()
  })

  it('closeTab sends JSON DELETE', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    expect(await closeTab('2')).toBe(true)
    expect(calls[0].url).toBe('/api/mux/tabs/2')
    expect(calls[0].init?.method).toBe('DELETE')
    expect(calls[0].init?.headers).toEqual(JSON_HEADERS)
  })

  it('renameTab sends PATCH with name in body', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    expect(await renameTab('1', 'new name')).toBe(true)
    expect(calls[0].url).toBe('/api/mux/tabs/1')
    expect(calls[0].init?.method).toBe('PATCH')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      name: 'new name',
    })
  })

  it('write calls report false when server does not return ok', async () => {
    mockFetch({ body: { error: 'invalid tab id' }, status: 400 })
    expect(await renameTab('-x', 'y')).toBe(false)
  })

  it('sendKeys posts keys to the pane route', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    expect(await sendKeys('0', 'ls -la')).toBe(true)
    expect(calls[0].url).toBe('/api/mux/panes/0/keys')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.headers).toEqual(JSON_HEADERS)
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      keys: 'ls -la',
    })
  })

  it('scrollPane posts the rows to the pane route', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    expect(await scrollPane('w1:p2', -5)).toBe(true)
    expect(calls[0].url).toBe('/api/mux/panes/w1%3Ap2/scroll')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.headers).toEqual(JSON_HEADERS)
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ lines: -5 })
  })

  it('fetchTerminalToken uses the stream-token route', async () => {
    const { calls } = mockFetch({ body: { token: 'abc123' } })
    await fetchTerminalToken()
    expect(calls[0].url).toBe('/api/mux/stream-token')
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

describe('agent API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reads a transcript with or without a position', async () => {
    const page = { agent: 'claude', entries: [], cursor: 'c', reset: true }
    const { calls } = mockFetch({ body: page })
    expect(await fetchTranscript('%3')).toEqual(page)
    await fetchTranscript('%3', { cursor: 'a b' })
    await fetchTranscript('%3', { before: 'x' })
    expect(calls.map((c) => c.url)).toEqual([
      '/api/mux/panes/%253/agent/transcript',
      '/api/mux/panes/%253/agent/transcript?cursor=a+b',
      '/api/mux/panes/%253/agent/transcript?before=x',
    ])
  })

  it('turns a refusal into an AgentRequestError with its code', async () => {
    mockFetch({ body: { error: 'no agent session in this pane' }, status: 404 })
    const err = await fetchTranscript('1').catch((e) => e)
    expect(err).toBeInstanceOf(AgentRequestError)
    expect(err).toMatchObject({
      status: 404,
      code: '',
      message: 'no agent session in this pane',
    })
  })

  it('a refusal without a JSON body still has a status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 502 })),
    )
    const err = await fetchTranscript('1').catch((e) => e)
    expect(err).toMatchObject({
      status: 502,
      code: '',
      message: 'request failed: 502',
    })
  })

  it('sends a message as JSON with its cursor', async () => {
    const { calls } = mockFetch({ body: {}, status: 204 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return new Response(null, { status: 204 })
      }),
    )
    await sendAgentMessage('1', 'hi\nthere', 'cur')
    expect(calls[0].url).toBe('/api/mux/panes/1/agent/message')
    expect(calls[0].init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi\nthere', cursor: 'cur' }),
    })
  })

  it('a refused message carries code and limit', async () => {
    mockFetch({
      body: {
        error: 'text is longer than 16 KB',
        code: 'text_too_long',
        limit: 16384,
      },
      status: 413,
    })
    await expect(sendAgentMessage('1', 'x', 'c')).rejects.toMatchObject({
      status: 413,
      code: 'text_too_long',
      limit: 16384,
    })
  })

  it('reads the open dialog, null when none', async () => {
    const prompt = { promptId: 'p', kind: 'permission', title: 'Bash command' }
    const { calls } = mockFetch(
      { body: { prompt } },
      { body: { prompt: null } },
    )
    expect(await fetchAgentPrompt('%3')).toEqual(prompt)
    expect(await fetchAgentPrompt('%3')).toBeNull()
    expect(calls[0].url).toBe('/api/mux/panes/%253/agent/prompt')
  })

  it('a prompt read can be refused', async () => {
    mockFetch({ body: { error: 'agent not available' }, status: 404 })
    await expect(fetchAgentPrompt('1')).rejects.toMatchObject({ status: 404 })
  })

  it('answers with the promptId and the choice', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return new Response(null, { status: 204 })
      }),
    )
    await answerAgentPrompt('1', 'pid', 2)
    await answerAgentPrompt('1', 'pid', 'cancel')
    expect(calls[0].url).toBe('/api/mux/panes/1/agent/answer')
    expect(calls[0].init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptId: 'pid', choice: 2 }),
    })
    expect(calls[1].init?.body).toBe(
      JSON.stringify({ promptId: 'pid', choice: 'cancel' }),
    )
  })

  it('a changed dialog comes back with the refusal', async () => {
    const prompt = { promptId: 'p2', kind: 'permission', title: 'Bash command' }
    mockFetch({
      body: { error: 'the screen changed', code: 'prompt_changed', prompt },
      status: 409,
    })
    await expect(answerAgentPrompt('1', 'p1', 1)).rejects.toMatchObject({
      status: 409,
      code: 'prompt_changed',
      prompt,
    })
  })
})
