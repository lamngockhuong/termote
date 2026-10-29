import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRequestError,
  answerAgentPrompt,
  applyChange,
  checkFileDownload,
  closeGroup,
  closePane,
  closeTab,
  createFile,
  createGroup,
  createPairingCode,
  createTab,
  createTemplate,
  createUserTask,
  createWorktree,
  deleteFile,
  deleteTemplate,
  deleteTrashEntry,
  deleteUserTask,
  emptyTrash,
  fetchActivity,
  fetchAgentCommands,
  fetchAgentPrompt,
  fetchCommitDiff,
  fetchDevices,
  fetchFileContent,
  fetchFileDiff,
  fetchFileDocument,
  fetchFileDownload,
  fetchFileHash,
  fetchFileImage,
  fetchFilesTree,
  fetchGitChanges,
  fetchHealth,
  fetchLastCommit,
  fetchOverview,
  fetchPaneText,
  fetchSignins,
  fetchSnapshot,
  fetchSubagents,
  fetchTaskRun,
  fetchTasks,
  fetchTemplates,
  fetchTerminalToken,
  fetchTranscript,
  fetchTrash,
  fetchUserTasks,
  findFiles,
  getPushKey,
  importTemplates,
  listWorktrees,
  logout,
  moveGroup,
  moveTab,
  onViewOnlyRefusal,
  openWorktree,
  previewTemplateImport,
  REQUEST_TIMEOUT_MS,
  RequestError,
  removeWorktree,
  renameFile,
  renameGroup,
  renameTab,
  resizePane,
  restoreFile,
  revokeDevice,
  revokeOtherSignins,
  revokeSignin,
  runTask,
  SAVE_TIMEOUT_MS,
  saveFileContent,
  scrollPane,
  searchFiles,
  selectTab,
  sendAgentMessage,
  sendKeys,
  signInUrl,
  splitPane,
  subscribePush,
  swapPane,
  TASK_RUN_TIMEOUT_MS,
  unsubscribePush,
  updateTemplate,
  updateUserTask,
  WORKTREE_REQUEST_TIMEOUT_MS,
  zoomPane,
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

  it('reads the push key', async () => {
    const { calls } = mockFetch({ body: { publicKey: 'BKEY' } })
    expect(await getPushKey()).toBe('BKEY')
    expect(calls[0].url).toBe('/api/mux/push/key')
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
    mockFetch({ body: { error: 'x', code: 'push_unavailable' }, status: 503 })
    await expect(getPushKey()).rejects.toMatchObject({
      status: 503,
      code: 'push_unavailable',
    })
  })

  it('subscribes and unsubscribes this device for push', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    const keys = { p256dh: 'P', auth: 'A' }
    await subscribePush({ endpoint: 'https://e', keys, expirationTime: null })
    await unsubscribePush('https://e')
    expect(calls.map((c) => [c.url, c.init?.method, c.init?.body])).toEqual([
      [
        '/api/mux/push/subscribe',
        'POST',
        JSON.stringify({ endpoint: 'https://e', keys }),
      ],
      [
        '/api/mux/push/subscribe',
        'DELETE',
        JSON.stringify({ endpoint: 'https://e' }),
      ],
    ])
    expect(calls[0].init?.headers).toEqual(JSON_HEADERS)
    mockFetch({ body: { error: 'x', code: 'invalid_keys' }, status: 400 })
    await expect(subscribePush({ endpoint: 'https://e' })).rejects.toThrow(
      RequestError,
    )
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

  it("createTab throws the server's message when no client is attached", async () => {
    mockFetch({
      status: 409,
      body: { error: 'open this Zellij session first', code: 'no_client' },
    })
    const err = await createTab('t', 'zbWFpbg').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.code).toBe('no_client')
    expect(err.message).toBe('open this Zellij session first')
  })

  it('createTab names the refusal itself when the server gives no message', async () => {
    mockFetch({ status: 409, body: { code: 'no_client' } })
    const err = await createTab('t').catch((e) => e)
    expect(err.message).toBe('no client attached')
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

  it('closeTab and renameTab send the key; a changed tab throws', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    expect(await closeTab('2', '@5')).toBe(true)
    expect(calls[0].url).toBe('/api/mux/tabs/2?key=%405')
    expect(await renameTab('2', 'x', '@5')).toBe(true)
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      name: 'x',
      key: '@5',
    })
    mockFetch({
      body: { error: 'the tab changed', code: 'changed' },
      status: 409,
    })
    await expect(closeTab('2', '@5')).rejects.toMatchObject({
      status: 409,
      code: 'changed',
    })
  })

  it('moveTab and moveGroup post the index; a refusal throws its code', async () => {
    const { calls } = mockFetch(
      { body: { ok: true, id: '$3:0' } },
      { body: { ok: true } },
      { body: { ok: true, id: 'w2' } },
    )
    expect(await moveTab('$3:2', 0)).toBe('$3:0')
    expect(calls[0].url).toBe('/api/mux/tabs/%243%3A2/move')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ index: 0 })
    expect(await moveTab('w1:t2', 1)).toBe('w1:t2')
    await moveGroup('w2', 3)
    expect(calls[2].url).toBe('/api/mux/groups/w2/move')
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({ index: 3 })
    mockFetch({ body: { error: 'x', code: 'busy' }, status: 503 })
    await expect(moveGroup('w2', 0)).rejects.toMatchObject({ code: 'busy' })
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

  it('fetchPaneText reads the pane text route, and throws its refusal', async () => {
    const reply = { text: 'a\nb', lines: 2, truncated: false }
    const { calls } = mockFetch(
      { body: reply },
      { body: { error: 'view only', code: 'view_only' }, status: 403 },
    )
    const ctrl = new AbortController()
    expect(await fetchPaneText('w1:p2', 1000, ctrl.signal)).toEqual(reply)
    expect(calls[0].url).toBe('/api/mux/panes/w1%3Ap2/text?lines=1000')
    expect(calls[0].init?.signal).toBe(ctrl.signal)
    await expect(fetchPaneText('w1:p2', 5)).rejects.toMatchObject({
      status: 403,
      code: 'view_only',
    })
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

describe('group API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('creates, renames and closes a group with JSON writes', async () => {
    const { calls } = mockFetch(
      { body: { ok: true, id: '$3' } },
      { body: { ok: true } },
      { body: { ok: true } },
    )
    expect(await createGroup('api', '/srv/api')).toBe('$3')
    await renameGroup('$3', 'web')
    await closeGroup('$3')
    expect(calls.map((c) => [c.url, c.init?.method, c.init?.body])).toEqual([
      ['/api/mux/groups', 'POST', '{"name":"api","cwd":"/srv/api"}'],
      ['/api/mux/groups/%243', 'PATCH', '{"name":"web"}'],
      ['/api/mux/groups/%243', 'DELETE', undefined],
    ])
    expect(
      (calls[0].init!.headers as Record<string, string>)['Content-Type'],
    ).toBe('application/json')
  })

  it('sends an empty directory for the home directory', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    expect(await createGroup('home')).toBe('')
    expect(calls[0].init?.body).toBe('{"name":"home","cwd":""}')
  })

  it('throws the server code, or none from a guard', async () => {
    mockFetch({
      body: { error: 'no such directory', code: 'not_found' },
      status: 400,
    })
    await expect(createGroup('a', '/nope')).rejects.toMatchObject({
      status: 400,
      code: 'not_found',
      message: 'no such directory',
    })
    mockFetch({ body: { error: 'forbidden' }, status: 403 })
    const err = await closeGroup('w1').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.code).toBe('')
  })
})

describe('pane layout API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('posts each action as JSON to the pane, its id encoded', async () => {
    const { calls } = mockFetch(
      { body: { ok: true, id: '%9' } },
      { body: { ok: true, id: 'w1:p2' } },
      { body: { ok: true } },
      { body: { ok: true } },
      { body: { ok: true } },
      { body: { ok: true } },
    )
    expect(await splitPane('%3', 'right')).toBe('%9')
    expect(await splitPane('w1:p1', 'down', '/srv')).toBe('w1:p2')
    await zoomPane('%3', 'toggle')
    await swapPane('%3', 'next')
    await resizePane('%3', 'left', 5)
    expect(await splitPane('%3', 'down')).toBe('')
    expect(calls.map((c) => [c.url, c.init?.method, c.init?.body])).toEqual([
      ['/api/mux/panes/%253/split', 'POST', '{"direction":"right"}'],
      [
        '/api/mux/panes/w1%3Ap1/split',
        'POST',
        '{"direction":"down","cwd":"/srv"}',
      ],
      ['/api/mux/panes/%253/zoom', 'POST', '{"mode":"toggle"}'],
      ['/api/mux/panes/%253/swap', 'POST', '{"direction":"next"}'],
      ['/api/mux/panes/%253/resize', 'POST', '{"direction":"left","amount":5}'],
      ['/api/mux/panes/%253/split', 'POST', '{"direction":"down"}'],
    ])
  })

  it('throws the server code', async () => {
    mockFetch({
      body: { error: 'no pane on that side', code: 'no_neighbor' },
      status: 409,
    })
    await expect(swapPane('%3', 'next')).rejects.toMatchObject({
      status: 409,
      code: 'no_neighbor',
    })
  })
})

describe('fetchActivity', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reads every kept event, then the ones after a cursor', async () => {
    const page = { events: [], latest: 4, oldest: 1, serverNow: 'now' }
    const { calls } = mockFetch({ body: page }, { body: page })
    expect(await fetchActivity()).toEqual(page)
    await fetchActivity(4)
    expect(calls.map((c) => c.url)).toEqual([
      '/api/mux/activity',
      '/api/mux/activity?after=4',
    ])
  })

  it('throws the coded error of a refused read', async () => {
    mockFetch({
      body: { error: 'after must be…', code: 'invalid_after' },
      status: 400,
    })
    const err = await fetchActivity(-1).catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.code).toBe('invalid_after')
  })
})

describe('fetchOverview', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reads every agent summary at once', async () => {
    const body = { serverNow: 'now', panes: [{ paneId: 'p', key: 'k' }] }
    const { calls } = mockFetch({ body })
    expect(await fetchOverview()).toEqual(body)
    expect(calls[0].url).toBe('/api/mux/overview')
  })

  it('reads one pane alone', async () => {
    const { calls } = mockFetch({ body: { serverNow: 'now', panes: [] } })
    await fetchOverview('%3 x')
    expect(calls[0].url).toBe('/api/mux/overview?pane=%253%20x')
  })

  it('throws on a refused read', async () => {
    mockFetch({ body: { error: 'cross-site request rejected' }, status: 403 })
    const err = await fetchOverview().catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.status).toBe(403)
  })
})

describe('fetchSubagents', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("reads the pane's subagent tree", async () => {
    const body = {
      nodes: [{ id: 'a1', type: 't', status: 'done', depth: 1, children: [] }],
    }
    const { calls } = mockFetch({ body })
    expect(await fetchSubagents('%3')).toEqual(body)
    expect(calls[0].url).toBe('/api/mux/panes/%253/agent/subagents')
  })

  it('throws on a pane without an agent', async () => {
    mockFetch({ body: { error: 'no agent session in this pane' }, status: 404 })
    const err = await fetchSubagents('p').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.status).toBe(404)
  })
})

describe('worktree API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('lists, creates, opens and removes with JSON writes', async () => {
    const list = { repoName: 'repo', worktrees: [], branches: ['main'] }
    const { calls } = mockFetch(
      { body: list },
      { body: { ok: true, id: 'w2' } },
      { body: { ok: true, id: 'w3', alreadyOpen: true } },
      { body: { ok: true } },
    )
    expect(await listWorktrees('w1')).toEqual(list)
    const w = { groupId: 'w1', branch: 'feat/x', base: '', label: '' }
    expect(await createWorktree(w)).toBe('w2')
    expect(await openWorktree('w1', 'old')).toBe('w3')
    await removeWorktree('w2', {
      force: false,
      path: '/wt/x',
      branch: 'feat/x',
    })
    expect(calls.map((c) => [c.url, c.init?.method, c.init?.body])).toEqual([
      ['/api/mux/worktrees?groupId=w1', undefined, undefined],
      ['/api/mux/worktrees', 'POST', JSON.stringify(w)],
      ['/api/mux/worktrees/open', 'POST', '{"groupId":"w1","branch":"old"}'],
      [
        '/api/mux/worktrees/w2',
        'DELETE',
        '{"force":false,"path":"/wt/x","branch":"feat/x"}',
      ],
    ])
  })

  it('answers an empty id when the server sends none', async () => {
    mockFetch({ body: { ok: true } })
    expect(
      await createWorktree({ groupId: 'w1', branch: 'a', base: '', label: '' }),
    ).toBe('')
    mockFetch({ body: { ok: true } })
    expect(await openWorktree('w1', 'a')).toBe('')
  })

  it('throws the server code', async () => {
    mockFetch({ body: { error: 'x', code: 'not_git' }, status: 409 })
    await expect(listWorktrees('w1')).rejects.toMatchObject({
      code: 'not_git',
    })
    mockFetch({ body: { error: 'x', code: 'dirty' }, status: 409 })
    await expect(
      removeWorktree('w2', { force: false, path: '/p', branch: 'b' }),
    ).rejects.toMatchObject({ code: 'dirty' })
  })

  it('reports its own timeout or abort as unknown, and other failures as they are', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new DOMException('gone', name)
        }),
      )
      await expect(
        createWorktree({ groupId: 'w1', branch: 'a', base: '', label: '' }),
      ).rejects.toMatchObject({ status: 0, code: 'unknown' })
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network')
      }),
    )
    await expect(openWorktree('w1', 'a')).rejects.toThrow('network')
    expect(WORKTREE_REQUEST_TIMEOUT_MS).toBe(75_000)
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
    await expect(sendAgentMessage('1', 'hi\nthere', 'cur')).resolves.toEqual({
      queued: false,
    })
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
      JSON.stringify({ text: '', cursor: 'cur', images: ['a1', 'b2'], at: [] }),
    )
    // With where each image goes in the text
    await sendAgentMessage('1', 'a b', 'cur', ['a1', 'b2'], [1, 3])
    expect(calls[1].init?.body).toBe(
      JSON.stringify({
        text: 'a b',
        cursor: 'cur',
        images: ['a1', 'b2'],
        at: [1, 3],
      }),
    )
    mockFetch({
      body: { error: 'gone', code: 'invalid_request', images: ['b2'] },
      status: 400,
    })
    await expect(
      sendAgentMessage('1', '', 'cur', ['a1', 'b2']),
    ).rejects.toMatchObject({ code: 'invalid_request', images: ['b2'] })
  })

  it('202: the working agent queued the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 202 })),
    )
    await expect(sendAgentMessage('1', 'next', 'cur')).resolves.toEqual({
      queued: true,
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
    const activity = { label: 'Working', elapsed: 3 }
    const { calls } = mockFetch(
      { body: { prompt, activity: null } },
      { body: { prompt: null, activity } },
      { body: {} },
    )
    expect(await fetchAgentPrompt('%3')).toEqual({ prompt, activity: null })
    expect(await fetchAgentPrompt('%3')).toEqual({ prompt: null, activity })
    // An older server sends neither
    expect(await fetchAgentPrompt('%3')).toEqual({
      prompt: null,
      activity: null,
    })
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
    expect(await fetchFilesTree({ paneId: '%3' }, '')).toEqual(tree)
    await fetchFilesTree({ paneId: '%3' }, 'src/a b', '/r')
    expect(calls.map((c) => c.url)).toEqual([
      '/api/mux/panes/%253/files/tree',
      '/api/mux/panes/%253/files/tree?path=src%2Fa+b&root=%2Fr',
    ])
    // GETs: no method, no body
    expect(calls[0].init).toBeUndefined()
  })

  it('reads a file, revealing it only when asked', async () => {
    const { calls } = mockFetch({ body: { root: '/r', path: 'a', text: '' } })
    await fetchFileContent({ paneId: '1' }, 'a')
    await fetchFileContent({ paneId: '1' }, '.env', {
      root: '/r',
      reveal: true,
    })
    await fetchFileContent({ paneId: '1' }, 'j.txt', { encoding: 'shift_jis' })
    expect(calls.map((c) => c.url)).toEqual([
      '/api/mux/panes/1/files/content?path=a',
      '/api/mux/panes/1/files/content?path=.env&root=%2Fr&reveal=1',
      '/api/mux/panes/1/files/content?path=j.txt&encoding=shift_jis',
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
    expect(await saveFileContent({ paneId: '%1' }, save)).toEqual(saved)
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

  it('sends the encoding a file was read as, and a save as UTF-8', async () => {
    const { calls } = mockFetch({
      body: { root: '/r', path: 'a', size: 1, hash: 'h', encoding: 'utf-8' },
    })
    await saveFileContent(
      { paneId: '1' },
      {
        root: '/r',
        path: 'a',
        baseHash: 'b',
        text: 'x',
        reveal: false,
        encoding: 'shift_jis',
        saveAs: 'utf-8',
      },
    )
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      path: 'a',
      baseHash: 'b',
      text: 'x',
      reveal: false,
      encoding: 'shift_jis',
      saveAs: 'utf-8',
    })
  })

  it('a save refused for a character keeps its line and the character', async () => {
    mockFetch({
      body: { error: 'x', code: 'unencodable', line: 4, char: '😀' },
      status: 422,
    })
    const save = {
      root: '/r',
      path: 'a',
      baseHash: 'b',
      text: '',
      reveal: false,
    }
    await expect(saveFileContent({ paneId: '1' }, save)).rejects.toMatchObject({
      code: 'unencodable',
      line: 4,
      char: '😀',
    })
    mockFetch({
      body: { error: 'x', code: 'not_editable', reason: 'encoding-required' },
      status: 422,
    })
    await expect(saveFileContent({ paneId: '1' }, save)).rejects.toMatchObject({
      code: 'not_editable',
      reason: 'encoding-required',
    })
    // Fields of another shape are left out
    mockFetch({
      body: { error: 'x', code: 'unencodable', line: '4', char: 1, reason: 2 },
      status: 422,
    })
    const err = await saveFileContent({ paneId: '1' }, save).catch((e) => e)
    expect([err.line, err.char, err.reason]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  it('a refused save throws its code', async () => {
    mockFetch({ body: { error: 'x', code: 'changed' }, status: 409 })
    await expect(
      saveFileContent(
        { paneId: '1' },
        {
          root: '/r',
          path: 'a',
          baseHash: 'b',
          text: '',
          reveal: true,
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'changed' })
  })

  it('creates a file with POST, the root in the query, with a timeout', async () => {
    const created = { root: '/r', path: 'd/n.md' }
    const { calls } = mockFetch({ body: created, status: 201 })
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    expect(
      await createFile(
        { paneId: '%1' },
        { root: '/r', path: 'd/n.md', reveal: false },
      ),
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
    await expect(createFile({ paneId: '1' }, create)).rejects.toMatchObject({
      status: 409,
      code: 'exists',
      path: 'w/a',
    })
    await expect(createFile({ paneId: '1' }, create)).rejects.toMatchObject({
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
        { paneId: '%1' },
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
    await findFiles({ paneId: '1' }, { q: 'x', ignored: false, exclude: [] })
    expect(calls[1].url).toBe('/api/mux/panes/1/files/find?q=x')
  })

  it('a refused find throws its code', async () => {
    mockFetch({ body: { error: 'x', code: 'invalid_exclude' }, status: 400 })
    await expect(
      findFiles({ paneId: '1' }, { q: 'x', ignored: false, exclude: ['a/b'] }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_exclude' })
  })

  it('searches contents with the options, every glob and excluded name', async () => {
    const found = {
      root: '/r',
      isRepo: true,
      files: [],
      truncated: false,
      incomplete: false,
      skipped: { sensitive: 0, hidden: 0, binary: 0, tooLarge: 0 },
    }
    const { calls } = mockFetch({ body: found }, { body: found })
    const abort = new AbortController()
    expect(
      await searchFiles(
        { paneId: '%1' },
        {
          q: ' -e x',
          root: '/r',
          matchCase: true,
          wholeWord: true,
          regex: true,
          files: ['*.ts', 'src/'],
          skip: ['*.test.ts'],
          exclude: ['node_modules'],
          fresh: true,
        },
        abort.signal,
      ),
    ).toEqual(found)
    expect(calls[0].url).toBe(
      '/api/mux/panes/%251/files/search?q=+-e+x&root=%2Fr&case=1&word=1&regex=1&files=*.ts&files=src%2F&skip=*.test.ts&exclude=node_modules&fresh=1',
    )
    expect(calls[0].init?.signal).toBe(abort.signal)
    await searchFiles(
      { paneId: '1' },
      {
        q: 'x',
        matchCase: false,
        wholeWord: false,
        regex: false,
        files: [],
        skip: [],
        exclude: [],
      },
    )
    expect(calls[1].url).toBe('/api/mux/panes/1/files/search?q=x')
  })

  it('a refused search throws its code', async () => {
    mockFetch({ body: { error: 'x', code: 'invalid_regex' }, status: 400 })
    await expect(
      searchFiles(
        { paneId: '1' },
        {
          q: '(',
          matchCase: false,
          wholeWord: false,
          regex: true,
          files: [],
          skip: [],
          exclude: [],
        },
      ),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_regex' })
  })

  it('reads a hash without the contents', async () => {
    const { calls } = mockFetch({ body: { root: '/r', path: 'a', size: 1 } })
    await fetchFileHash({ paneId: '1' }, 'a')
    await fetchFileHash({ paneId: '1' }, '.env', '/r')
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
      await deleteFile(
        { paneId: '%1' },
        {
          root: '/r',
          path: 'a',
          kind: 'file',
          baseHash: 'h',
          reveal: false,
          permanent: false,
        },
      ),
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
      await restoreFile(
        { paneId: '%1' },
        { root: '/r', trashId: 'x', reveal: true },
      ),
    ).toEqual({ root: '/r', path: 'a' })
    expect(calls[1].url).toBe('/api/mux/panes/%251/files/restore?root=%2Fr')
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      trashId: 'x',
      reveal: true,
    })
    expect(timeout).toHaveBeenCalledWith(SAVE_TIMEOUT_MS)
    timeout.mockRestore()
  })

  it('renames with POST, the root in the query, with a timeout', async () => {
    const { calls } = mockFetch({ body: { root: '/r', path: 'x/b' } })
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    expect(
      await renameFile(
        { paneId: '%1' },
        {
          root: '/r',
          path: 'a',
          newPath: 'x/b',
          reveal: true,
        },
      ),
    ).toEqual({ root: '/r', path: 'x/b' })
    expect(calls[0].url).toBe('/api/mux/panes/%251/files/rename?root=%2Fr')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      path: 'a',
      newPath: 'x/b',
      reveal: true,
    })
    expect(timeout).toHaveBeenCalledWith(SAVE_TIMEOUT_MS)
    timeout.mockRestore()
  })

  it('a refused rename throws its code and the path it names', async () => {
    mockFetch({
      body: { error: 'x', code: 'exists', path: 'b' },
      status: 409,
    })
    await expect(
      renameFile(
        { paneId: '%1' },
        { root: '/r', path: 'a', newPath: 'b', reveal: false },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'exists', path: 'b' })
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
    await expect(deleteFile({ paneId: '1' }, del)).rejects.toMatchObject({
      code: 'changed',
      trashId: 'id',
    })
    await expect(
      restoreFile({ paneId: '1' }, { root: '/r', trashId: 'x', reveal: false }),
    ).rejects.toMatchObject({ code: 'exists', path: 'a' })
  })

  it('lists the trash with the root, and changes it with POST', async () => {
    const entry = {
      trashId: 'a'.repeat(32),
      path: 'x/a.txt',
      kind: 'file',
      deletedAt: '2026-10-28T10:00:00Z',
      expiresAt: '2026-11-04T10:00:00Z',
      size: 3,
    }
    const { calls } = mockFetch(
      { body: { root: '/r', entries: [entry] } },
      { body: { root: '/r', trashId: 'x' } },
      { body: { root: '/r', removed: 2, failed: 0 } },
    )
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    expect(await fetchTrash({ paneId: '%1', place: 'p1' }, '/r')).toEqual({
      root: '/r',
      entries: [entry],
    })
    expect(calls[0].url).toBe(
      '/api/mux/panes/%251/files/trash?root=%2Fr&place=p1',
    )
    expect(calls[0].init?.method).toBeUndefined()
    expect(
      await deleteTrashEntry({ paneId: '%1' }, { root: '/r', trashId: 'x' }),
    ).toEqual({ root: '/r', trashId: 'x' })
    expect(calls[1].url).toBe(
      '/api/mux/panes/%251/files/trash/delete?root=%2Fr',
    )
    expect(calls[1].init?.method).toBe('POST')
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ trashId: 'x' })
    expect(
      await emptyTrash({ paneId: '%1' }, { root: '/r', trashIds: ['x', 'y'] }),
    ).toEqual({ root: '/r', removed: 2, failed: 0 })
    expect(calls[2].url).toBe('/api/mux/panes/%251/files/trash/empty?root=%2Fr')
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({
      trashIds: ['x', 'y'],
    })
    expect(timeout).toHaveBeenCalledWith(SAVE_TIMEOUT_MS)
    timeout.mockRestore()
  })

  it('a refused trash request throws its code and the root it moved to', async () => {
    mockFetch(
      { body: { error: 'x', code: 'view_only' }, status: 403 },
      { body: { error: 'x', code: 'not_in_trash' }, status: 404 },
      { body: { error: 'root changed', root: '/n' }, status: 409 },
    )
    await expect(fetchTrash({ paneId: '1' }, '/r')).rejects.toMatchObject({
      status: 403,
      code: 'view_only',
    })
    await expect(
      deleteTrashEntry({ paneId: '1' }, { root: '/r', trashId: 'x' }),
    ).rejects.toMatchObject({ status: 404, code: 'not_in_trash' })
    await expect(
      emptyTrash({ paneId: '1' }, { root: '/r', trashIds: ['x'] }),
    ).rejects.toMatchObject({ status: 409, root: '/n' })
  })

  it('applies a change with POST, the root in the query, with a timeout', async () => {
    const { calls } = mockFetch(
      { body: { root: '/r', path: 'a', trashId: 'x' } },
      { body: { error: 'x', code: 'stale_hunk' }, status: 409 },
    )
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    expect(
      await applyChange('%1', {
        root: '/r',
        action: 'discard',
        path: 'a',
        hunk: 'h1',
        reveal: false,
      }),
    ).toEqual({ root: '/r', path: 'a', trashId: 'x' })
    expect(calls[0].url).toBe(
      '/api/mux/panes/%251/files/changes/apply?root=%2Fr',
    )
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      action: 'discard',
      path: 'a',
      hunk: 'h1',
      reveal: false,
    })
    expect(timeout).toHaveBeenCalledWith(SAVE_TIMEOUT_MS)
    timeout.mockRestore()
    await expect(
      applyChange('1', {
        root: '/r',
        action: 'stage',
        path: 'a',
        reveal: false,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'stale_hunk' })
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

  it('reads the last commit and one file of it', async () => {
    const { calls } = mockFetch({ body: {} })
    await fetchLastCommit('1')
    await fetchLastCommit('1', '/r')
    await fetchCommitDiff('1', 'abc', { path: 'b' }, {})
    await fetchCommitDiff(
      '1',
      'abc',
      { path: 'b', orig: 'a' },
      { root: '/r', reveal: true },
    )
    expect(calls.map((c) => c.url)).toEqual([
      '/api/mux/panes/1/files/commit',
      '/api/mux/panes/1/files/commit?root=%2Fr',
      '/api/mux/panes/1/files/commit/diff?commit=abc&path=b',
      '/api/mux/panes/1/files/commit/diff?commit=abc&path=b&orig=a&reveal=1&root=%2Fr',
    ])
  })

  it('reads an image as a blob, with the version asked for', async () => {
    const spy = vi.fn(async () => new Response('png'))
    vi.stubGlobal('fetch', spy)
    const ctl = new AbortController()
    expect(await (await fetchFileImage({ paneId: '1' }, 'a.png')).text()).toBe(
      'png',
    )
    await fetchFileImage(
      { paneId: '1' },
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

  it('reads a document as a blob', async () => {
    const spy = vi.fn(
      async () => new Response('%PDF-', { headers: { 'Content-Length': '5' } }),
    )
    vi.stubGlobal('fetch', spy)
    const ctl = new AbortController()
    expect(
      await (await fetchFileDocument({ paneId: '1' }, 'a.pdf')).text(),
    ).toBe('%PDF-')
    await fetchFileDocument(
      { paneId: '1' },
      'd/b.docx',
      { reveal: true, root: '/r' },
      ctl.signal,
    )
    expect(spy.mock.calls).toEqual([
      ['/api/mux/panes/1/files/document?path=a.pdf', { signal: undefined }],
      [
        '/api/mux/panes/1/files/document?path=d%2Fb.docx&reveal=1&root=%2Fr',
        { signal: ctl.signal },
      ],
    ])
  })

  it('reads a document without a Content-Length', async () => {
    const res = new Response('PK')
    res.headers.delete('Content-Length')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    )
    expect((await fetchFileDocument({ paneId: '1' }, 'a.xlsx')).size).toBe(2)
  })

  it('ignores the length of a compressed document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('%PDF-1.7', {
            headers: { 'Content-Length': '3', 'Content-Encoding': 'gzip' },
          }),
      ),
    )
    expect((await fetchFileDocument({ paneId: '1' }, 'a.pdf')).size).toBe(8)
  })

  it('a document cut short is interrupted, not damaged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('%PDF', { headers: { 'Content-Length': '10' } }),
      ),
    )
    await expect(
      fetchFileDocument({ paneId: '1' }, 'a.pdf'),
    ).rejects.toMatchObject({
      status: 0,
      code: 'interrupted',
    })
    const broken = new Response('x')
    broken.blob = () => Promise.reject(new TypeError('network error'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => broken),
    )
    await expect(
      fetchFileDocument({ paneId: '1' }, 'a.pdf'),
    ).rejects.toMatchObject({
      code: 'interrupted',
    })
  })

  it('an aborted document read rejects with the abort', async () => {
    const ctl = new AbortController()
    const res = new Response('x')
    const abort = new DOMException('aborted', 'AbortError')
    res.blob = () => {
      ctl.abort()
      return Promise.reject(abort)
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    )
    await expect(
      fetchFileDocument({ paneId: '1' }, 'a.pdf', {}, ctl.signal),
    ).rejects.toBe(abort)
  })

  it('a refused document carries the code and the size', async () => {
    mockFetch({
      body: { error: 'too large', code: 'too_large', size: 31457281 },
      status: 413,
    })
    await expect(
      fetchFileDocument({ paneId: '1' }, 'a.pdf'),
    ).rejects.toMatchObject({
      status: 413,
      code: 'too_large',
      size: 31457281,
    })
    mockFetch({
      body: { error: 'x', code: 'encrypted', size: 'big' },
      status: 415,
    })
    const err = await fetchFileDocument({ paneId: '1' }, 'a.xlsx').catch(
      (e) => e,
    )
    expect(err).toMatchObject({ code: 'encrypted' })
    expect(err.size).toBeUndefined()
  })

  it('checks a download, then reads its bytes', async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ root: '/r', path: 'a', size: 1 })),
    )
    vi.stubGlobal('fetch', spy)
    const ctl = new AbortController()
    expect(
      await checkFileDownload({ paneId: '1' }, 'd/a b', {
        root: '/r',
        reveal: true,
      }),
    ).toEqual({ root: '/r', path: 'a', size: 1 })
    await checkFileDownload({ paneId: '1' }, 'a')
    expect(await (await fetchFileDownload('/x', ctl.signal)).text()).toContain(
      'root',
    )
    expect(spy.mock.calls).toEqual([
      [
        '/api/mux/panes/1/files/download?path=d%2Fa+b&reveal=1&root=%2Fr&check=1',
      ],
      ['/api/mux/panes/1/files/download?path=a&check=1'],
      ['/x', { signal: ctl.signal }],
    ])
  })

  it.each([
    ['check', () => checkFileDownload({ paneId: '1' }, 'a')],
    ['read', () => fetchFileDownload('/x')],
  ])('a refused download %s carries the server code', async (_, call) => {
    mockFetch({ body: { error: 'too large', code: 'too_large' }, status: 413 })
    await expect(call()).rejects.toMatchObject({
      status: 413,
      code: 'too_large',
    })
  })

  it('a refused image carries the server code', async () => {
    mockFetch({ body: { error: 'too large', code: 'too_large' }, status: 413 })
    await expect(
      fetchFileImage({ paneId: '1' }, 'a.png'),
    ).rejects.toMatchObject({
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
    const err = await fetchFilesTree({ paneId: '1' }, '').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    // The agent routes' name is the same class
    expect(err).toBeInstanceOf(AgentRequestError)
    expect(err).toMatchObject({ status, ...want })
  })
})

describe('view-only refusals and paired devices', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('sends the /pair page to the sign-in page, which it never returns to', () => {
    window.history.replaceState(null, '', '/pair?code=ABCDE-FGHIJ')
    expect(signInUrl()).toBe('/login')
    window.history.replaceState(null, '', '/pair/x')
    expect(signInUrl()).toBe(`/login?next=${encodeURIComponent('/pair/x')}`)
    window.history.replaceState(null, '', '/pairs?x=1')
    expect(signInUrl()).toBe(`/login?next=${encodeURIComponent('/pairs?x=1')}`)
  })

  it('tells every listener once when a write is refused as view-only', async () => {
    mockFetch({ body: { error: 'view only', code: 'view_only' }, status: 403 })
    const heard = vi.fn()
    const off = onViewOnlyRefusal(heard)
    expect(await selectTab('0')).toBe(false)
    expect(heard).toHaveBeenCalledTimes(1)
    off()
    mockFetch({ body: { error: 'view only', code: 'view_only' }, status: 403 })
    await selectTab('0')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('does not tell about a write refused for another reason', async () => {
    mockFetch({ body: { error: 'forbidden', code: 'forbidden' }, status: 403 })
    const heard = vi.fn()
    const off = onViewOnlyRefusal(heard)
    await selectTab('0')
    off()
    expect(heard).not.toHaveBeenCalled()
  })

  it('tells about a request refused as view-only, except a read', async () => {
    const heard = vi.fn()
    const off = onViewOnlyRefusal(heard)
    mockFetch({ body: { error: 'view only', code: 'view_only' }, status: 403 })
    const err = await fetchDevices().catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err.code).toBe('view_only')
    expect(heard).toHaveBeenCalledTimes(1)

    mockFetch({ body: { error: 'view only', code: 'view_only' }, status: 403 })
    const read = await fetchFilesTree({ paneId: '1' }, '').catch((e) => e)
    expect(read.code).toBe('view_only')
    off()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('lists the paired devices, or none when the answer has no list', async () => {
    const devices = [
      {
        id: 'd1',
        name: 'Phone',
        role: 'view',
        createdAt: '2026-10-01T00:00:00Z',
        lastUsedAt: '2026-10-02T00:00:00Z',
        current: true,
      },
    ]
    const { calls } = mockFetch({ body: { devices } })
    expect(await fetchDevices()).toEqual(devices)
    expect(calls[0].url).toBe('/api/mux/devices')
    mockFetch({ body: {} })
    expect(await fetchDevices()).toEqual([])
  })

  it('a refused device list carries the server code', async () => {
    mockFetch({
      body: { error: 'unsupported', code: 'unsupported' },
      status: 501,
    })
    await expect(fetchDevices()).rejects.toMatchObject({
      status: 501,
      code: 'unsupported',
    })
  })

  it('makes a pairing code from the role and name', async () => {
    const made = {
      code: 'ABCDE-FGHIJ',
      expiresAt: '2026-10-09T00:05:00Z',
      url: 'https://h/pair?code=ABCDE-FGHIJ',
    }
    const { calls } = mockFetch({ body: made })
    expect(await createPairingCode('view', 'Phone')).toEqual(made)
    expect(calls[0].url).toBe('/api/mux/devices/pair')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      role: 'view',
      name: 'Phone',
    })
  })

  it('sends validFor only when the device gets a limit', async () => {
    const { calls } = mockFetch({ body: { code: 'ABCDE-FGHIJ' } })
    await createPairingCode('view', '', 86400)
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      role: 'view',
      name: '',
      validFor: 86400,
    })
    await createPairingCode('view', '', null)
    expect(JSON.parse(calls[1].init?.body as string)).not.toHaveProperty(
      'validFor',
    )
  })

  it('a refused pairing code carries the server code', async () => {
    mockFetch({
      body: { error: 'too many', code: 'too_many_codes' },
      status: 429,
    })
    await expect(createPairingCode('full', '')).rejects.toMatchObject({
      status: 429,
      code: 'too_many_codes',
    })
  })

  it('revokes a device by its id, answering every id revoked', async () => {
    const { calls } = mockFetch({ body: { ok: true, revoked: ['a/b', 'c'] } })
    expect(await revokeDevice('a/b')).toEqual(['a/b', 'c'])
    expect(calls[0].url).toBe('/api/mux/devices/a%2Fb')
    expect(calls[0].init?.method).toBe('DELETE')
    // An older server answers no list: the device alone
    mockFetch({ body: { ok: true } })
    expect(await revokeDevice('x')).toEqual(['x'])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 })),
    )
    expect(await revokeDevice('y')).toEqual(['y'])
  })

  it('a device not revoked throws the server code', async () => {
    mockFetch({
      body: { error: 'unknown', code: 'unknown_device' },
      status: 404,
    })
    await expect(revokeDevice('x')).rejects.toMatchObject({
      status: 404,
      code: 'unknown_device',
    })
  })

  it('lists the signed-in browsers and whether this client signs them out', async () => {
    const sessions = [
      {
        id: '0123456789abcdef',
        createdAt: '2026-10-01T00:00:00Z',
        lastUsedAt: '2026-10-02T00:00:00Z',
        expiresAt: '2026-10-02T00:00:00Z',
        via: 'form',
        ip: '192.0.2.9',
        userAgent: 'Firefox',
        current: true,
      },
    ]
    const { calls } = mockFetch({ body: { sessions, canRevoke: true } })
    expect(await fetchSignins()).toEqual({ sessions, canRevoke: true })
    expect(calls[0].url).toBe('/api/mux/signins')
    mockFetch({ body: {} })
    expect(await fetchSignins()).toEqual({ sessions: [], canRevoke: false })
    mockFetch({ body: { error: 'view only', code: 'view_only' }, status: 403 })
    await expect(fetchSignins()).rejects.toMatchObject({ code: 'view_only' })
  })

  it('signs one browser out by its id', async () => {
    const { calls } = mockFetch({ body: { ok: true } })
    await revokeSignin('a/b')
    expect(calls[0].url).toBe('/api/mux/signins/a%2Fb')
    expect(calls[0].init?.method).toBe('DELETE')
    mockFetch({
      body: { error: 'no such sign-in', code: 'unknown_session' },
      status: 404,
    })
    await expect(revokeSignin('x')).rejects.toMatchObject({
      code: 'unknown_session',
    })
  })

  it('signs the other browsers out, answering how many went', async () => {
    const { calls } = mockFetch({ body: { ok: true, revoked: 3 } })
    expect(await revokeOtherSignins()).toBe(3)
    expect(calls[0].url).toBe('/api/mux/signins')
    expect(calls[0].init?.method).toBe('DELETE')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 })),
    )
    expect(await revokeOtherSignins()).toBe(0)
    mockFetch({
      body: { error: 'x', code: 'full_needs_password' },
      status: 403,
    })
    await expect(revokeOtherSignins()).rejects.toMatchObject({
      code: 'full_needs_password',
    })
  })
})

describe('prompt templates API', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const tpl = {
    id: '0123456789abcdef',
    name: 'Review',
    text: 'Review {{file}}',
    updated: '2026-10-26T00:00:00Z',
  }

  it('lists the templates, or none from an answer without a list', async () => {
    const { calls } = mockFetch(
      { body: { templates: [tpl], readOnly: false } },
      { body: { readOnly: true } },
    )
    expect(await fetchTemplates()).toEqual({
      templates: [tpl],
      readOnly: false,
    })
    expect(calls[0].url).toBe('/api/mux/templates')
    expect(await fetchTemplates()).toEqual({ templates: [], readOnly: true })
  })

  it('a refused list is a read: no view-only toast', async () => {
    const heard = vi.fn()
    const off = onViewOnlyRefusal(heard)
    mockFetch({ body: { code: 'templates_unavailable' }, status: 503 })
    await expect(fetchTemplates()).rejects.toMatchObject({
      status: 503,
      code: 'templates_unavailable',
    })
    off()
    expect(heard).not.toHaveBeenCalled()
  })

  it('creates, updates and deletes as JSON', async () => {
    const { calls } = mockFetch(
      { body: { template: tpl }, status: 201 },
      { body: { template: tpl } },
      { body: { ok: true } },
    )
    expect(await createTemplate({ name: 'Review', text: 't' })).toEqual(tpl)
    expect(calls[0]).toMatchObject({
      url: '/api/mux/templates',
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    })
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      name: 'Review',
      text: 't',
    })
    await updateTemplate('a/b', { name: 'n', text: 't', updated: 'u' })
    expect(calls[1].url).toBe('/api/mux/templates/a%2Fb')
    expect(calls[1].init?.method).toBe('PUT')
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      name: 'n',
      text: 't',
      updated: 'u',
    })
    await deleteTemplate(tpl.id, '2026-10-26T00:00:00.5+07:00')
    expect(calls[2].url).toBe(
      `/api/mux/templates/${tpl.id}?updated=2026-10-26T00%3A00%3A00.5%2B07%3A00`,
    )
    expect(calls[2].init).toMatchObject({ method: 'DELETE', body: undefined })
  })

  it('a conflict carries the template as it is now', async () => {
    mockFetch({
      body: { code: 'conflict', error: 'changed', template: tpl },
      status: 409,
    })
    const err = await updateTemplate(tpl.id, {
      name: 'n',
      text: 't',
      updated: 'old',
    }).catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err).toMatchObject({ status: 409, code: 'conflict', template: tpl })
  })

  it('an invalid template names its place and field', async () => {
    mockFetch({
      body: { code: 'invalid_template', error: 'x', index: 3, field: 'text' },
      status: 400,
    })
    await expect(previewTemplateImport([])).rejects.toMatchObject({
      code: 'invalid_template',
      index: 3,
      field: 'text',
    })
  })

  it('previews an import, then imports with what it replaces', async () => {
    const list = [{ name: 'a', text: 'b' }]
    const { calls } = mockFetch(
      { body: { added: ['a'], replaced: [] } },
      { body: {} },
      { body: { added: 1, replaced: 0 } },
      { body: {} },
    )
    expect(await previewTemplateImport(list)).toEqual({
      added: ['a'],
      replaced: [],
    })
    expect(calls[0].url).toBe('/api/mux/templates/import?dryRun=1')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      templates: list,
    })
    expect(await previewTemplateImport(list)).toEqual({
      added: [],
      replaced: [],
    })
    expect(await importTemplates(list, ['x'])).toEqual({
      added: 1,
      replaced: 0,
    })
    expect(calls[2].url).toBe('/api/mux/templates/import')
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({
      templates: list,
      replace: ['x'],
    })
    expect(await importTemplates(list, [])).toEqual({ added: 0, replaced: 0 })
  })
})

describe('tasks API', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const task = {
    id: '0123456789abcdef',
    name: 'Lint',
    command: 'pnpm lint',
    updated: '2026-10-26T00:00:00Z',
  }
  const run = {
    runId: 'r1',
    tabId: 't1',
    paneId: 'p1',
    nonce: 'n1',
    state: 'running',
  }

  it('lists a pane tasks, with the root the client saw when it has one', async () => {
    const full = {
      root: '/repo',
      packageManager: 'pnpm',
      scripts: [{ name: 'test', command: 'vitest' }],
      makefile: 'Makefile',
      makeTargets: [{ name: 'build' }],
      userTasks: [task],
      toolGroups: [
        {
          tool: 'go',
          label: 'Go',
          file: 'go.mod',
          tasks: [{ name: 'test', command: 'go test ./...' }],
        },
      ],
      runs: { 'script:test': run },
      skipped: 2,
      tooLarge: ['package.json'],
      unreadable: ['Cargo.toml'],
    }
    const { calls } = mockFetch({ body: full }, { body: full })
    expect(await fetchTasks('%1')).toEqual(full)
    expect(calls[0].url).toBe('/api/mux/panes/%251/tasks')
    expect(await fetchTasks('%1', '/re po&x')).toEqual(full)
    expect(calls[1].url).toBe('/api/mux/panes/%251/tasks?root=%2Fre+po%26x')
  })

  it('fills what the answer leaves out', async () => {
    mockFetch({ body: {} })
    expect(await fetchTasks('p')).toEqual({
      root: '',
      packageManager: '',
      scripts: [],
      makefile: '',
      makeTargets: [],
      userTasks: [],
      toolGroups: [],
      runs: {},
      skipped: 0,
      tooLarge: [],
      unreadable: [],
    })
  })

  it('reads a null tool list or unreadable list as empty', async () => {
    mockFetch({ body: { toolGroups: null, unreadable: null } })
    const got = await fetchTasks('p')
    expect(got.toolGroups).toEqual([])
    expect(got.unreadable).toEqual([])
  })

  it('a refused listing is a read (no view-only toast) and carries the new root', async () => {
    const heard = vi.fn()
    const off = onViewOnlyRefusal(heard)
    mockFetch({
      body: { code: 'root_changed', error: 'moved', root: '/other' },
      status: 409,
    })
    const err = await fetchTasks('p', '/old').catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err).toMatchObject({
      status: 409,
      code: 'root_changed',
      root: '/other',
    })
    mockFetch({ body: { code: 'view_only' }, status: 403 })
    await expect(fetchTasks('p')).rejects.toMatchObject({ status: 403 })
    off()
    expect(heard).not.toHaveBeenCalled()
  })

  it('runs a task by name or id as JSON and returns the run', async () => {
    const start = {
      runId: 'r1',
      tabId: 't1',
      paneId: 'p1',
      nonce: 'n1',
      reused: false,
    }
    const { calls } = mockFetch({ body: start }, { body: start })
    const req = { kind: 'script' as const, name: 'test', root: '/repo' }
    expect(await runTask('%1', req)).toEqual(start)
    expect(calls[0]).toMatchObject({
      url: '/api/mux/panes/%251/tasks/run',
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    })
    expect(JSON.parse(calls[0].init?.body as string)).toEqual(req)
    const user = {
      kind: 'user' as const,
      id: task.id,
      root: '/r',
      newTab: true,
    }
    await runTask('p', user)
    expect(JSON.parse(calls[1].init?.body as string)).toEqual(user)
  })

  it('waits longer for a run than for a read', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    mockFetch({ body: {} }, { body: {} })
    await runTask('p', { kind: 'make', name: 'b', root: '/' })
    expect(timeout).toHaveBeenLastCalledWith(TASK_RUN_TIMEOUT_MS)
    expect(TASK_RUN_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS)
    await fetchTaskRun('r')
    expect(timeout).toHaveBeenLastCalledWith(REQUEST_TIMEOUT_MS)
  })

  it('a task still running carries its run and tab', async () => {
    mockFetch({
      body: { code: 'task_running', error: 'busy', runId: 'r9', tabId: 't9' },
      status: 409,
    })
    const err = await runTask('p', {
      kind: 'make',
      name: 'b',
      root: '/',
    }).catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err).toMatchObject({
      status: 409,
      code: 'task_running',
      runId: 'r9',
      tabId: 't9',
    })
  })

  it('a refused run is a write: a view-only device is told', async () => {
    const heard = vi.fn()
    const off = onViewOnlyRefusal(heard)
    mockFetch({ body: { code: 'view_only' }, status: 403 })
    await expect(
      runTask('p', { kind: 'make', name: 'b', root: '/' }),
    ).rejects.toMatchObject({ status: 403, code: 'view_only' })
    off()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('reads a run state, with its exit code', async () => {
    const { calls } = mockFetch(
      { body: { state: 'exited', code: 2 } },
      { body: { state: 'running' } },
    )
    expect(await fetchTaskRun('a/b')).toEqual({ state: 'exited', code: 2 })
    expect(calls[0].url).toBe('/api/mux/tasks/runs/a%2Fb')
    expect(await fetchTaskRun('r')).toEqual({ state: 'running' })
  })

  it('a run the server forgot is a read refusal with its code', async () => {
    const heard = vi.fn()
    const off = onViewOnlyRefusal(heard)
    mockFetch(
      { body: { code: 'run_not_found', error: 'gone' }, status: 404 },
      { body: { code: 'view_only' }, status: 403 },
    )
    await expect(fetchTaskRun('r')).rejects.toMatchObject({
      status: 404,
      code: 'run_not_found',
    })
    await expect(fetchTaskRun('r')).rejects.toMatchObject({ status: 403 })
    off()
    expect(heard).not.toHaveBeenCalled()
  })

  it('lists the user tasks, or none from an answer without a list', async () => {
    const { calls } = mockFetch(
      { body: { tasks: [task], readOnly: false } },
      { body: { readOnly: true } },
      { body: {} },
    )
    expect(await fetchUserTasks()).toEqual({ tasks: [task], readOnly: false })
    expect(calls[0].url).toBe('/api/mux/tasks')
    expect(await fetchUserTasks()).toEqual({ tasks: [], readOnly: true })
    expect(await fetchUserTasks()).toEqual({ tasks: [], readOnly: false })
  })

  it('lists with the signal it is given', async () => {
    const { spy } = mockFetch({ body: {} })
    const ctl = new AbortController()
    await fetchUserTasks(ctl.signal)
    expect(spy.mock.calls[0][1]?.signal).toBe(ctl.signal)
  })

  it('a refused user tasks list is a read: no view-only toast', async () => {
    const heard = vi.fn()
    const off = onViewOnlyRefusal(heard)
    mockFetch({ body: { code: 'tasks_unavailable' }, status: 503 })
    await expect(fetchUserTasks()).rejects.toMatchObject({
      status: 503,
      code: 'tasks_unavailable',
    })
    off()
    expect(heard).not.toHaveBeenCalled()
  })

  it('creates, updates and deletes user tasks as JSON', async () => {
    const { calls } = mockFetch(
      { body: { task }, status: 201 },
      { body: { task } },
      { body: { ok: true } },
    )
    expect(
      await createUserTask({ name: 'Lint', command: 'pnpm lint' }),
    ).toEqual(task)
    expect(calls[0]).toMatchObject({
      url: '/api/mux/tasks',
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    })
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      name: 'Lint',
      command: 'pnpm lint',
    })
    expect(
      await updateUserTask('a/b', { name: 'n', command: 'c', updated: 'u' }),
    ).toEqual(task)
    expect(calls[1].url).toBe('/api/mux/tasks/a%2Fb')
    expect(calls[1].init?.method).toBe('PUT')
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      name: 'n',
      command: 'c',
      updated: 'u',
    })
    await expect(
      deleteUserTask(task.id, '2026-10-26T00:00:00.5+07:00'),
    ).resolves.toBeUndefined()
    expect(calls[2].url).toBe(
      `/api/mux/tasks/${task.id}?updated=2026-10-26T00%3A00%3A00.5%2B07%3A00`,
    )
    expect(calls[2].init).toMatchObject({ method: 'DELETE', body: undefined })
  })

  it('a conflict carries the task as it is now', async () => {
    mockFetch({
      body: { code: 'conflict', error: 'changed', task },
      status: 409,
    })
    const err = await updateUserTask(task.id, {
      name: 'n',
      command: 'c',
      updated: 'old',
    }).catch((e) => e)
    expect(err).toBeInstanceOf(RequestError)
    expect(err).toMatchObject({ status: 409, code: 'conflict', task })
  })

  it('an invalid task names its field, and a write refusal reaches the toast', async () => {
    const heard = vi.fn()
    const off = onViewOnlyRefusal(heard)
    mockFetch(
      {
        body: { code: 'invalid_task', error: 'x', field: 'command' },
        status: 400,
      },
      { body: { code: 'view_only' }, status: 403 },
    )
    await expect(
      createUserTask({ name: '', command: '' }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_task',
      field: 'command',
    })
    await expect(deleteUserTask('i', 'u')).rejects.toMatchObject({
      code: 'view_only',
    })
    off()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('RequestError keeps task, runId and tabId from its details', () => {
    const err = new RequestError(409, 'task_running', 'busy', {
      task,
      runId: 'r',
      tabId: 't',
    })
    expect(err).toMatchObject({ status: 409, task, runId: 'r', tabId: 't' })
    const bare = new RequestError(500, 'x', 'y')
    expect(bare.task).toBeUndefined()
    expect(bare.runId).toBeUndefined()
    expect(bare.tabId).toBeUndefined()
  })
})
