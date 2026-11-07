import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STREAM_PATH } from './fake-stream'
import { ROUTES, route } from './router'
import { THINK_MS } from './routes-agent'
import { createState, type DemoState } from './state'

// Every path under /api/mux the PWA's source names, read the way a person
// would: the literal paths and the helpers that build them
// (use-mux-api.ts). A new route in the PWA without a demo handler fails here.
const SOURCES = import.meta.glob<string>(
  ['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../demo/**'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
)

const HELPERS: Record<string, string> = {
  tabPath: '/tabs',
  groupPath: '/groups',
  panePath: '/panes',
}

function sourcePaths(sources: Record<string, string>): Set<string> {
  const found = new Set<string>()
  for (const raw of Object.values(sources)) {
    const src = raw
      .replace(/\$\{encodeURIComponent\([^)]*\)\}/g, '{id}')
      .replace(
        /\$\{(tabPath|groupPath|panePath)\([^)]*\)\}/g,
        (_, f) => `${HELPERS[f]}/{id}`,
      )
      .replace(/\$\{templatesPath\}/g, '/api/mux/templates')
      .replace(/\$\{userTasksPath\}/g, '/api/mux/tasks')
    const add = (p: string) => {
      // A path that ends in a variable (/agent/${op}) is read at its callers
      if (p && !p.endsWith('/')) found.add(p)
    }
    for (const m of src.matchAll(
      /(?:\$\{API_BASE\}|\$\{apiBase\(\)\}|\$\{LOCAL_API\}|\/api\/mux)((?:\/(?:[a-z-]+|\{id\}))*\/?)/g,
    ))
      add(m[1])
    for (const m of src.matchAll(/agentPath\([^,]+,\s*'([^']+)'\)/g))
      add(`/panes/{id}/agent/${m[1]}`)
    for (const m of src.matchAll(
      /(?:filesUrl|filesGet|trashPost)\(\s*(?:target|\{ paneId \}),\s*'([^']+)'/g,
    ))
      add(`/panes/{id}/files/${m[1]}`)
    for (const m of src.matchAll(/tasksUrl\(\s*\w+,\s*'([^']+)'\)/g))
      add(`/panes/{id}/tasks${m[1]}`)
    for (const m of src.matchAll(
      /(?:write|groupWrite|tabWrite|worktreeWrite)\(\s*'(?:POST|PATCH|DELETE)',\s*(?:['`]([^'`?]*)|(tabPath|groupPath|panePath)\()/g,
    ))
      add(m[1] ?? `${HELPERS[m[2]]}/{id}`)
  }
  return found
}

// Whether a route of the demo serves path, whatever the method
function served(path: string): boolean {
  const parts = path.split('/')
  return Object.keys(ROUTES).some((key) => {
    const segs = key.split(' ')[1].split('/')
    return (
      segs.length === parts.length &&
      segs.every(
        (s, i) => s === parts[i] || (s.startsWith('{') && parts[i] !== ''),
      )
    )
  })
}

describe('route coverage', () => {
  const paths = sourcePaths(SOURCES)

  it('reads the PWA source', () => {
    // A sample of each way a path is written, so a change in the source's
    // style that the reading misses is noticed
    for (const p of [
      '/snapshot',
      '/panes/{id}/agent/transcript',
      '/panes/{id}/files/commit/diff',
      '/panes/{id}/tasks/run',
      '/tabs/{id}/select',
      '/tabs/{id}',
      '/groups/{id}/move',
      '/templates/import',
      '/tasks/runs/{id}',
      '/uploads',
    ])
      expect(paths).toContain(p)
  })

  it('has a handler for every path the PWA calls', () => {
    // The stream is a WebSocket: fake-stream.ts stands in for it
    const stream = STREAM_PATH.replace('/api/mux', '')
    expect([...paths].filter((p) => !served(p) && p !== stream)).toEqual([])
  })

  it('notices a path without a handler', () => {
    expect(served('/panes/{id}/files/nothing')).toBe(false)
    // Source text, not a template: the placeholder is what is read
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text
    expect(sourcePaths({ x: 'fetch(`${API_BASE}/brand-new`)' })).toContain(
      '/brand-new',
    )
  })
})

// Any argument: a string, an object of any field, a function, an empty
// list, as each use-mux-api function reads it
const ANY: any = new Proxy(() => {}, {
  get: (_t, key) => {
    if (key === Symbol.toPrimitive || key === 'toJSON') return () => 'x'
    if (key === 'length') return 0
    if (key === Symbol.iterator) return [][Symbol.iterator]
    return ANY
  },
  apply: () => ANY,
})

// Every request the API client sends, method and path, by calling each of
// its functions with a fetch that records them
async function clientRequests(): Promise<Set<string>> {
  const api = await import('../hooks/use-mux-api')
  const sent = new Set<string>()
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://127.0.0.1')
    if (url.pathname.startsWith('/api/mux/'))
      sent.add(`${init?.method ?? 'GET'} ${url.pathname.slice(8)}`)
    return new Response('{}', { status: 200 })
  })
  try {
    // Each sends its request at once: started together, then given a moment
    for (const fn of Object.values(api))
      if (typeof fn === 'function' && fn.prototype === undefined)
        Promise.resolve()
          .then(() => (fn as (...a: unknown[]) => unknown)(ANY, ANY, ANY, ANY))
          .catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
  } finally {
    vi.unstubAllGlobals()
  }
  return sent
}

// Whether a route serves method and path (ids are 'x')
function handles(request: string): boolean {
  const [method, path] = request.split(' ')
  const parts = path.split('/')
  return Object.keys(ROUTES).some((key) => {
    const [m, p] = key.split(' ')
    const segs = p.split('/')
    return (
      m === method &&
      segs.length === parts.length &&
      segs.every((s, i) =>
        s.startsWith('{') ? parts[i] !== '' : s === parts[i],
      )
    )
  })
}

describe('client coverage', () => {
  it('has a handler for every request of the API client, by method', async () => {
    const sent = await clientRequests()
    expect(sent.size).toBeGreaterThan(60)
    expect([...sent].filter((r) => !handles(r))).toEqual([])
  })
})

const URL_BASE = 'http://127.0.0.1/api/mux'

describe('router', () => {
  let state: DemoState
  let now: number
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await route(
      state,
      method,
      new URL(URL_BASE + path),
      body === undefined ? undefined : JSON.stringify(body),
    )
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined }
  }
  const pane = (id: string) => `/panes/${encodeURIComponent(id)}`

  beforeEach(() => {
    now = Date.parse('2026-11-04T08:00:00Z')
    state = createState(() => now)
  })
  afterEach(() => vi.restoreAllMocks())

  it('answers the snapshot with the demo workspaces', async () => {
    const { status, body } = await call('GET', '/snapshot')
    expect(status).toBe(200)
    expect(body.backend).toBe('herdr')
    expect(body.groups.map((g: { name: string }) => g.name)).toEqual([
      'acme-api',
      'web',
      'infra',
    ])
  })

  it('reports an unhandled request and answers 501', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { status } = await call('GET', '/nothing-here')
    expect(status).toBe(501)
    expect(error).toHaveBeenCalledWith(
      'demo: unhandled',
      'GET',
      '/nothing-here',
    )
  })

  it('refuses what the demo cannot do with the unsupported code', async () => {
    const { status, body } = await call('POST', '/devices/pair', {})
    expect(status).toBe(501)
    expect(body.code).toBe('unsupported')
  })

  it('renames a pane and lists the new name', async () => {
    expect(
      (await call('PATCH', pane('w1:p2'), { name: 'dev server' })).status,
    ).toBe(200)
    const { body } = await call('GET', '/snapshot')
    expect(body.groups[0].tabs[0].panes[1].name).toBe('dev server')
    await call('PATCH', pane('w1:p2'), { name: '' })
    expect(
      (await call('GET', '/snapshot')).body.groups[0].tabs[0].panes[1].name,
    ).toBeUndefined()
  })

  it('saves a file and reads the saved text back', async () => {
    const read = await call(
      'GET',
      `${pane('w1:p1')}/files/content?path=README.md`,
    )
    expect(read.body.root).toBe('/home/dev/acme-api')
    const saved = await call(
      'PUT',
      `${pane('w1:p1')}/files/content?root=/home/dev/acme-api`,
      {
        path: 'README.md',
        baseHash: read.body.hash,
        text: '# acme-api\n',
        reveal: false,
      },
    )
    expect(saved.status).toBe(200)
    const again = await call(
      'GET',
      `${pane('w1:p1')}/files/content?path=README.md`,
    )
    expect(again.body.text).toBe('# acme-api\n')
    expect(again.body.hash).toBe(saved.body.hash)
    // Saved over a version it did not read
    const stale = await call('PUT', `${pane('w1:p1')}/files/content`, {
      path: 'README.md',
      baseHash: read.body.hash,
      text: 'other',
    })
    expect(stale.body.code).toBe('changed')
    // The save shows in Changes
    const changes = await call('GET', `${pane('w1:p1')}/files/changes`)
    expect(changes.body.entries).toContainEqual(
      expect.objectContaining({ path: 'README.md', unstaged: 'M' }),
    )
  })

  it('lists the agent changes and stages, unstages and discards them', async () => {
    const files = `${pane('w1:p1')}/files`
    const list = async () =>
      (await call('GET', `${files}/changes`)).body.entries
    expect(await list()).toEqual([
      { path: 'auth/login.go', staged: '', unstaged: 'M', sensitive: false },
      {
        path: 'auth/login_test.go',
        staged: '',
        unstaged: 'M',
        sensitive: false,
      },
      {
        path: 'auth/ratelimit.go',
        staged: '',
        unstaged: '?',
        sensitive: false,
      },
    ])
    await call('POST', `${files}/changes/apply`, {
      action: 'stage',
      path: 'auth/login.go',
    })
    expect((await list())[0]).toMatchObject({ staged: 'M', unstaged: '' })
    const staged = await call(
      'GET',
      `${files}/diff?path=auth/login.go&staged=1`,
    )
    expect(staged.body.hunks.length).toBeGreaterThan(0)
    await call('POST', `${files}/changes/apply`, {
      action: 'unstage',
      path: 'auth/login.go',
    })
    expect((await list())[0]).toMatchObject({ staged: '', unstaged: 'M' })
    const discarded = await call('POST', `${files}/changes/apply`, {
      action: 'discard',
      path: 'auth/ratelimit.go',
    })
    expect(discarded.body.trashId).toBeTruthy()
    expect((await list()).map((e: { path: string }) => e.path)).not.toContain(
      'auth/ratelimit.go',
    )
    // The discarded file waits in the trash
    const restored = await call('POST', `${files}/restore`, {
      trashId: discarded.body.trashId,
    })
    expect(restored.body.path).toBe('auth/ratelimit.go')
  })

  it('lists, finds and searches the files of a pane root', async () => {
    const files = `${pane('w1:p1')}/files`
    const root = await call('GET', `${files}/tree?path=`)
    expect(root.body.entries.map((e: { name: string }) => e.name)).toEqual([
      '.claude',
      'auth',
      'go.mod',
      'main.go',
      'Makefile',
      'README.md',
    ])
    const found = await call('GET', `${files}/find?q=login`)
    expect(found.body.results[0].path).toBe('auth/login.go')
    const hits = await call('GET', `${files}/search?q=limiter`)
    expect(hits.body.files.map((f: { path: string }) => f.path)).toEqual([
      'auth/login.go',
      'auth/login_test.go',
      'auth/ratelimit.go',
    ])
    const bad = await call('GET', `${files}/search?q=(&regex=1`)
    expect(bad.body.code).toBe('invalid_regex')
  })

  it('plays the agent turn: works, asks, answers', async () => {
    const agent = `${pane('w1:p1')}/agent`
    const first = await call('GET', `${agent}/transcript`)
    expect(first.body.entries).toHaveLength(5)
    expect(
      (
        await call('POST', `${agent}/message`, {
          text: 'run them',
          cursor: first.body.cursor,
        })
      ).status,
    ).toBe(204)
    expect((await call('GET', `${agent}/prompt`)).body.activity.label).toBe(
      'Incubating',
    )
    now += THINK_MS
    const asked = await call('GET', `${agent}/prompt`)
    expect(asked.body.prompt.kind).toBe('permission')
    const status = async () =>
      (await call('GET', '/snapshot')).body.groups[0].tabs[0].panes[0].agent
        .status
    expect(await status()).toBe('blocked')
    expect(
      (await call('POST', `${agent}/answer`, { promptId: 'stale', choice: 1 }))
        .body.code,
    ).toBe('prompt_expired')
    await call('POST', `${agent}/answer`, {
      promptId: asked.body.prompt.promptId,
      choice: 1,
    })
    now += 5000
    const next = await call(
      'GET',
      `${agent}/transcript?cursor=${first.body.cursor}`,
    )
    expect(next.body.reset).toBe(false)
    expect(next.body.entries.at(-1).parts[0].text).toContain('both tests pass')
    expect(await status()).toBe('done')
    const events = (await call('GET', '/activity?after=2')).body.events
    expect(events.map((e: { to: string }) => e.to)).toEqual([
      'working',
      'blocked',
      'working',
      'done',
    ])
  })

  it('opens a tab for a task run that exits', async () => {
    const run = await call('POST', `${pane('w1:p1')}/tasks/run`, {
      kind: 'go',
      name: 'test',
      root: '/home/dev/acme-api',
    })
    expect(run.status).toBe(200)
    expect(
      (await call('GET', `/tasks/runs/${run.body.runId}`)).body.state,
    ).toBe('running')
    now += 5000
    expect((await call('GET', `/tasks/runs/${run.body.runId}`)).body).toEqual({
      state: 'exited',
      code: 0,
    })
    const tasks = await call('GET', `${pane('w1:p1')}/tasks`)
    expect(tasks.body.runs['go:test'].state).toBe('exited')
  })

  it('keeps templates, refusing a stale change', async () => {
    const made = await call('POST', '/templates', {
      name: 'Ship',
      text: 'Ship it',
    })
    const id = made.body.template.id
    const stale = await call('PUT', `/templates/${id}`, {
      name: 'Ship',
      text: 'x',
      updated: 'old',
    })
    expect(stale.body.code).toBe('conflict')
    expect(
      (await call('POST', '/templates', { name: 'ship', text: 'y' })).body.code,
    ).toBe('name_taken')
    await call(
      'DELETE',
      `/templates/${id}?updated=${encodeURIComponent(made.body.template.updated)}`,
    )
    const left = (await call('GET', '/templates')).body.templates
    expect(left.map((t: { name: string }) => t.name)).toEqual([
      'Review',
      'Tests for a file',
    ])
  })

  it('creates, renames and closes groups and tabs', async () => {
    const g = await call('POST', '/groups', { name: 'docs', cwd: '~/docs' })
    const t = await call('POST', '/tabs', { groupId: g.body.id, name: 'notes' })
    await call('PATCH', `/tabs/${encodeURIComponent(t.body.id)}`, {
      name: 'todo',
    })
    let snap = (await call('GET', '/snapshot')).body
    const docs = snap.groups.find((x: { id: string }) => x.id === g.body.id)
    expect(docs.tabs.map((x: { name: string }) => x.name)).toEqual([
      '1',
      'todo',
    ])
    expect(docs.tabs[1].panes[0].process.cwd).toBe('/home/dev/docs')
    expect((await call('GET', '/recent-groups')).body.groups[0].cwd).toBe(
      '~/docs',
    )
    await call('DELETE', `/groups/${g.body.id}`)
    snap = (await call('GET', '/snapshot')).body
    expect(snap.groups).toHaveLength(3)
  })
})
