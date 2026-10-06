import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRequestError,
  answerAgentPrompt,
  closePane,
  closeTab,
  createFile,
  createTab,
  deleteFile,
  fetchAgentCommands,
  fetchAgentPrompt,
  fetchFileContent,
  fetchFileDiff,
  fetchFileHash,
  fetchFileImage,
  fetchFilesTree,
  fetchGitChanges,
  fetchHealth,
  fetchSnapshot,
  fetchTerminalToken,
  fetchTranscript,
  findFiles,
  logout,
  REQUEST_TIMEOUT_MS,
  RequestError,
  renameTab,
  restoreFile,
  SAVE_TIMEOUT_MS,
  saveFileContent,
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

  it('opens the sign-in page with the current path when the session ended', async () => {
    window.history.replaceState(null, '', '/?view=chat&pane=%251#x')
    for (const read of [fetchSnapshot, fetchHealth]) {
      mockFetch({ body: 'Unauthorized', status: 401 })
      const signIn = vi.fn()
      await expect(read(signIn)).rejects.toMatchObject({
        status: 401,
        code: 'unauthorized',
      })
      expect(signIn).toHaveBeenCalledWith(
        '/login?next=%2F%3Fview%3Dchat%26pane%3D%25251%23x',
      )
    }
    window.history.replaceState(null, '', '/')
  })

  it('signs in through a page load by default', async () => {
    mockFetch({ body: 'Unauthorized', status: 401 })
    const assign = vi.fn()
    const real = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/', search: '', hash: '', assign },
    })
    try {
      await expect(fetchSnapshot()).rejects.toMatchObject({ status: 401 })
      expect(assign).toHaveBeenCalledWith('/login?next=%2F')
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: real,
      })
    }
  })

  it('fetchSnapshot rejects a failed read instead of returning its body', async () => {
    mockFetch({ body: { error: 'mux command failed' }, status: 500 })
    await expect(fetchSnapshot()).rejects.toMatchObject({
      status: 500,
      message: 'mux command failed',
    })
  })

  it('fetchHealth reads the health route', async () => {
    const { calls } = mockFetch({ body: { status: 'ok', apiVersion: 1 } })
    expect(await fetchHealth()).toEqual({ status: 'ok', apiVersion: 1 })
    expect(calls[0].url).toBe('/api/mux/health')
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('fetchSnapshot gives up on a reply that never arrives', async () => {
    const timedOut = AbortSignal.abort(
      new DOMException('signal timed out', 'TimeoutError'),
    )
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timedOut)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        throw init?.signal?.reason
      }),
    )
    await expect(fetchSnapshot()).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS)
  })

  it('logout posts JSON to the logout route and reads its status', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const statuses = [204, 404]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return new Response(null, { status: statuses[calls.length - 1] })
      }),
    )
    expect(await logout()).toBe(true)
    expect(calls[0].url).toBe('/api/mux/logout')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.headers).toEqual(JSON_HEADERS)
    expect(calls[0].init?.body).toBe('{}')
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
    expect(await logout()).toBe(false)
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

  it('closePane sends JSON DELETE to the encoded pane', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    expect(await closePane('w1:p2')).toBe(true)
    expect(calls[0].url).toBe('/api/mux/panes/w1%3Ap2')
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

  it('sends the image ids with the text; a refusal names the bad ones', async () => {
    const calls: { init?: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ init })
        return new Response(null, { status: 204 })
      }),
    )
    await sendAgentMessage('1', '', 'cur', ['a1', 'b2'])
    expect(calls[0].init?.body).toBe(
      JSON.stringify({ text: '', cursor: 'cur', images: ['a1', 'b2'] }),
    )
    mockFetch({
      body: { error: 'gone', code: 'invalid_request', images: ['b2'] },
      status: 400,
    })
    await expect(
      sendAgentMessage('1', '', 'cur', ['a1', 'b2']),
    ).rejects.toMatchObject({ code: 'invalid_request', images: ['b2'] })
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

  it('reads the custom commands of a pane', async () => {
    const commands = [{ name: 'deploy', source: 'project', kind: 'command' }]
    const { calls } = mockFetch({ body: { commands } }, { body: {} })
    expect(await fetchAgentCommands('%3')).toEqual(commands)
    expect(await fetchAgentCommands('%3')).toEqual([])
    expect(calls[0].url).toBe('/api/mux/panes/%253/agent/commands')
    mockFetch({ body: { error: 'agent not available' }, status: 404 })
    await expect(fetchAgentCommands('1')).rejects.toMatchObject({ status: 404 })
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

describe('files API client', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads a directory, sending the root it saw', async () => {
    const tree = { root: '/r', path: '', entries: [], truncated: false }
    const { calls } = mockFetch({ body: tree })
    expect(await fetchFilesTree('%3', '')).toEqual(tree)
    await fetchFilesTree('%3', 'src/a b', '/r')
    expect(calls.map((c) => c.url)).toEqual([
      '/api/mux/panes/%253/files/tree',
      '/api/mux/panes/%253/files/tree?path=src%2Fa+b&root=%2Fr',
    ])
    // GETs: no method, no body
    expect(calls[0].init).toBeUndefined()
  })

  it('reads a file, revealing it only when asked', async () => {
    const { calls } = mockFetch({ body: { root: '/r', path: 'a', text: '' } })
    await fetchFileContent('1', 'a')
    await fetchFileContent('1', '.env', { root: '/r', reveal: true })
    expect(calls.map((c) => c.url)).toEqual([
      '/api/mux/panes/1/files/content?path=a',
      '/api/mux/panes/1/files/content?path=.env&root=%2Fr&reveal=1',
    ])
  })

  it('saves a file with PUT, the root in the query, with a timeout', async () => {
    const saved = { root: '/r', path: 'a', size: 1, hash: 'h' }
    const { calls } = mockFetch({ body: saved })
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const save = {
      root: '/r',
      path: 'a',
      baseHash: 'b',
      text: 'x',
      reveal: false,
    }
    expect(await saveFileContent('%1', save)).toEqual(saved)
    expect(calls[0].url).toBe('/api/mux/panes/%251/files/content?root=%2Fr')
    expect(calls[0].init?.method).toBe('PUT')
    expect(new Headers(calls[0].init?.headers).get('Content-Type')).toBe(
      'application/json',
    )
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      path: 'a',
      baseHash: 'b',
      text: 'x',
      reveal: false,
    })
    expect(timeout).toHaveBeenCalledWith(SAVE_TIMEOUT_MS)
    timeout.mockRestore()
  })

  it('a refused save throws its code', async () => {
    mockFetch({ body: { error: 'x', code: 'changed' }, status: 409 })
    await expect(
      saveFileContent('1', {
        root: '/r',
        path: 'a',
        baseHash: 'b',
        text: '',
        reveal: true,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'changed' })
  })

  it('creates a file with POST, the root in the query, with a timeout', async () => {
    const created = { root: '/r', path: 'd/n.md' }
    const { calls } = mockFetch({ body: created, status: 201 })
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    expect(
      await createFile('%1', { root: '/r', path: 'd/n.md', reveal: false }),
    ).toEqual(created)
    expect(calls[0].url).toBe('/api/mux/panes/%251/files/create?root=%2Fr')
    expect(calls[0].init?.method).toBe('POST')
    expect(new Headers(calls[0].init?.headers).get('Content-Type')).toBe(
      'application/json',
    )
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      path: 'd/n.md',
      reveal: false,
    })
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS)
    timeout.mockRestore()
  })

  it('a refused create throws its code, or the root it moved to', async () => {
    mockFetch(
      { body: { error: 'x', code: 'exists', path: 'w/a' }, status: 409 },
      { body: { error: 'root changed', root: '/n' }, status: 409 },
    )
    const create = { root: '/r', path: 'a', reveal: true }
    await expect(createFile('1', create)).rejects.toMatchObject({
      status: 409,
      code: 'exists',
      path: 'w/a',
    })
    await expect(createFile('1', create)).rejects.toMatchObject({
      status: 409,
      root: '/n',
    })
  })

  it('finds files with the query, the switch and every excluded name', async () => {
    const found = {
      root: '/r',
      isRepo: true,
      results: [],
      truncated: false,
      incomplete: false,
    }
    const { calls } = mockFetch({ body: found })
    const abort = new AbortController()
    expect(
      await findFiles(
        '%1',
        {
          q: 'ma in',
          root: '/r',
          ignored: true,
          exclude: ['node_modules', 'dist'],
          fresh: true,
        },
        abort.signal,
      ),
    ).toEqual(found)
    expect(calls[0].url).toBe(
      '/api/mux/panes/%251/files/find?q=ma+in&root=%2Fr&ignored=1&exclude=node_modules&exclude=dist&fresh=1',
    )
    expect(calls[0].init?.signal).toBe(abort.signal)
    await findFiles('1', { q: 'x', ignored: false, exclude: [] })
    expect(calls[1].url).toBe('/api/mux/panes/1/files/find?q=x')
  })

  it('a refused find throws its code', async () => {
    mockFetch({ body: { error: 'x', code: 'invalid_exclude' }, status: 400 })
    await expect(
      findFiles('1', { q: 'x', ignored: false, exclude: ['a/b'] }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_exclude' })
  })

  it('reads a hash without the contents', async () => {
    const { calls } = mockFetch({ body: { root: '/r', path: 'a', size: 1 } })
    await fetchFileHash('1', 'a')
    await fetchFileHash('1', '.env', '/r')
    expect(calls.map((c) => c.url)).toEqual([
      '/api/mux/panes/1/files/content?path=a&hash=1',
      '/api/mux/panes/1/files/content?path=.env&root=%2Fr&hash=1',
    ])
  })

  it('deletes and restores with POST, the root in the query, with a timeout', async () => {
    const { calls } = mockFetch(
      { body: { root: '/r', path: 'a', trashId: 'f'.repeat(32) } },
      { body: { root: '/r', path: 'a' } },
    )
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    expect(
      await deleteFile('%1', {
        root: '/r',
        path: 'a',
        kind: 'file',
        baseHash: 'h',
        reveal: false,
        permanent: false,
      }),
    ).toEqual({ root: '/r', path: 'a', trashId: 'f'.repeat(32) })
    expect(calls[0].url).toBe('/api/mux/panes/%251/files/delete?root=%2Fr')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      path: 'a',
      kind: 'file',
      baseHash: 'h',
      reveal: false,
      permanent: false,
    })
    expect(
      await restoreFile('%1', { root: '/r', trashId: 'x', reveal: true }),
    ).toEqual({ root: '/r', path: 'a' })
    expect(calls[1].url).toBe('/api/mux/panes/%251/files/restore?root=%2Fr')
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      trashId: 'x',
      reveal: true,
    })
    expect(timeout).toHaveBeenCalledWith(SAVE_TIMEOUT_MS)
    timeout.mockRestore()
  })

  it('a refused delete or restore throws its code and a kept trashId', async () => {
    mockFetch(
      { body: { error: 'x', code: 'changed', trashId: 'id' }, status: 409 },
      { body: { error: 'x', code: 'exists', path: 'a' }, status: 409 },
    )
    const del = {
      root: '/r',
      path: 'a',
      kind: 'dir' as const,
      reveal: false,
      permanent: true,
    }
    await expect(deleteFile('1', del)).rejects.toMatchObject({
      code: 'changed',
      trashId: 'id',
    })
    await expect(
      restoreFile('1', { root: '/r', trashId: 'x', reveal: false }),
    ).rejects.toMatchObject({ code: 'exists', path: 'a' })
  })

  it('reads the changes and the diff of one side of an entry', async () => {
    const { calls } = mockFetch({ body: {} })
    await fetchGitChanges('1')
    await fetchGitChanges('1', '/r')
    await fetchFileDiff('1', { path: 'b' }, { staged: false })
    await fetchFileDiff(
      '1',
      { path: 'b', orig: 'a' },
      { staged: true, root: '/r', reveal: true },
    )
    expect(calls.map((c) => c.url)).toEqual([
      '/api/mux/panes/1/files/changes',
      '/api/mux/panes/1/files/changes?root=%2Fr',
      '/api/mux/panes/1/files/diff?path=b',
      '/api/mux/panes/1/files/diff?path=b&orig=a&staged=1&reveal=1&root=%2Fr',
    ])
  })

  it('reads an image as a blob, with the version asked for', async () => {
    const spy = vi.fn(async () => new Response('png'))
    vi.stubGlobal('fetch', spy)
    const ctl = new AbortController()
    expect(await (await fetchFileImage('1', 'a.png')).text()).toBe('png')
    await fetchFileImage(
      '1',
      'b.png',
      { side: 'old', staged: true, orig: 'a.png', reveal: true, root: '/r' },
      ctl.signal,
    )
    expect(spy.mock.calls).toEqual([
      ['/api/mux/panes/1/files/raw?path=a.png', { signal: undefined }],
      [
        '/api/mux/panes/1/files/raw?path=b.png&orig=a.png&side=old&staged=1&reveal=1&root=%2Fr',
        { signal: ctl.signal },
      ],
    ])
  })

  it('a refused image carries the server code', async () => {
    mockFetch({ body: { error: 'too large', code: 'too_large' }, status: 413 })
    await expect(fetchFileImage('1', 'a.png')).rejects.toMatchObject({
      status: 413,
      code: 'too_large',
    })
  })

  it.each([
    [409, { error: 'root changed', root: '/new' }, { root: '/new' }],
    [403, { error: 'path not allowed' }, { message: 'path not allowed' }],
    [501, { error: 'not supported' }, { message: 'not supported' }],
  ])('turns a %i into a RequestError', async (status, body, want) => {
    mockFetch({ body, status })
    const err = await fetchFilesTree('1', '').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    // The agent routes' name is the same class
    expect(err).toBeInstanceOf(AgentRequestError)
    expect(err).toMatchObject({ status, ...want })
  })
})
