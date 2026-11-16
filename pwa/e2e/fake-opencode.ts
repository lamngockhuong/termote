import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'

// A stand-in for the OpenCode 2.x background service (`opencode serve
// --service`), for the E2E specs of an OpenCode pane: the routes termote
// reads and writes, with the shapes recorded from a real OpenCode 2.3.0
// (server/testdata/opencode, the fixtures of the server's own tests), HTTP
// Basic auth with the user name "opencode", and paging of messages by an
// opaque cursor. It runs in the Playwright worker, on a loopback port this
// user holds, and writes the service.json termote reads into the state dir
// of the server under test: termote checks the service as it checks a real
// one (the file, /api/info naming the same pid and version, the password,
// the owner of the port), with no shortcut of its own.
//
// It needs no model: a message sent is recorded, and answered with a reply
// that quotes it, so the Chat view shows it went through.

const FIXTURES = path.resolve(import.meta.dirname, '../../server/testdata/opencode')

export type Json = Record<string, unknown>

// A recorded fixture, with @ROOT@ (the session's directory the recordings
// hid) made root
export function fixture(name: string, root = ''): Json {
  const raw = readFileSync(path.join(FIXTURES, name), 'utf-8')
  const q = JSON.stringify(root).slice(1, -1)
  return JSON.parse(raw.replaceAll('@ROOT@', q)) as Json
}

// The `data` list of a fixture
export function fixtureList(name: string, root = ''): Json[] {
  return fixture(name, root).data as Json[]
}

// A recorded page of messages as the session's messages, oldest first
export function fixtureMessages(name: string, root = ''): Json[] {
  const page = [...fixtureList(name, root)]
  const created = (m: Json) => ((m.time as Json | undefined)?.created as number) ?? 0
  if (page.length > 1 && created(page[0]) > created(page[page.length - 1])) page.reverse()
  return page
}

// Moves every time of a recording (the ms numbers of each "time" object)
// by delta, so a recording made on one day reads as made today
export function shiftTimes<T>(v: T, delta: number): T {
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, delta)) as T
  if (v && typeof v === 'object') {
    const out: Json = {}
    for (const [k, x] of Object.entries(v as Json)) {
      if (k === 'time' && x && typeof x === 'object' && !Array.isArray(x)) {
        const t: Json = {}
        for (const [tk, tv] of Object.entries(x as Json)) {
          t[tk] = typeof tv === 'number' ? tv + delta : tv
        }
        out[k] = t
      } else {
        out[k] = shiftTimes(x, delta)
      }
    }
    return out as T
  }
  return v
}

// Every sessionID field of a recording made the one given
export function withSession<T>(v: T, id: string): T {
  if (Array.isArray(v)) return v.map((x) => withSession(x, id)) as T
  if (v && typeof v === 'object') {
    const out: Json = {}
    for (const [k, x] of Object.entries(v as Json)) {
      out[k] = k === 'sessionID' ? id : withSession(x, id)
    }
    return out as T
  }
  return v
}

export interface Recorded {
  method: string
  path: string
  query: URLSearchParams
  body: string
}

// One port and password for every spec: the server keeps a service it
// checked for 30 s, so a spec after another finds the same one there
const PORT = Number(process.env.TERMOTE_E2E_OPENCODE_PORT) || 7689

export class FakeOpencode {
  readonly password = 'e2e-opencode-password'
  readonly version = '2.3.0'
  readonly pid = process.pid
  private server?: Server
  private stateDir = ''
  url = ''
  // Sessions running a turn now
  active = new Set<string>()
  // Messages per session, oldest first; a session absent answers 404
  messages = new Map<string, Json[]>()
  // Pending permissions and forms per session
  permissions = new Map<string, Json[]>()
  forms = new Map<string, Json[]>()
  // session.get per session
  sessions = new Map<string, Json>()
  // session.list, newest first
  list: Json[] = []
  commandList: Json = fixture('command-list.json')
  skillList: Json = fixture('skill-list.json')
  modelList: Json = fixture('model-list.json')
  // Every request but /api/info, in order
  requests: Recorded[] = []
  private ids = 0

  // Starts the service and writes its service.json into state, the
  // XDG_STATE_HOME of the server under test
  async start(state: string): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          this.serve(req, res, Buffer.concat(chunks).toString('utf-8'))
        } catch (e) {
          res.writeHead(500).end(String(e))
        }
      })
    })
    this.stateDir = path.join(state, 'opencode')
    // Never replaces the service.json of a real service: the state dir must
    // be the throwaway one of the server under test
    const file = path.join(this.stateDir, 'service.json')
    if (existsSync(file) && (JSON.parse(readFileSync(file, 'utf-8')) as Json).id !== 'e2e') {
      throw new Error(`${file} belongs to a real OpenCode service: give the server its own XDG_STATE_HOME`)
    }
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(PORT, '127.0.0.1', resolve)
    })
    this.url = `http://127.0.0.1:${PORT}`
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      path.join(this.stateDir, 'service.json'),
      JSON.stringify({ id: 'e2e', version: this.version, url: this.url, pid: this.pid, password: this.password }),
      { mode: 0o600 },
    )
  }

  async stop(): Promise<void> {
    if (this.stateDir) rmSync(path.join(this.stateDir, 'service.json'), { force: true })
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  // The write requests to path suffix (e.g. "/prompt"), in order
  writes(suffix: string): Recorded[] {
    return this.requests.filter((r) => r.method !== 'GET' && r.path.endsWith(suffix))
  }

  // A new message id, as OpenCode makes them
  nextId(prefix = 'msg'): string {
    this.ids++
    return `${prefix}_e2e${String(this.ids).padStart(4, '0')}`
  }

  private reply(res: ServerResponse, status: number, v?: unknown) {
    if (v === undefined) {
      res.writeHead(status).end()
      return
    }
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
  }

  private notFound(res: ServerResponse) {
    this.reply(res, 404, { _tag: 'SessionNotFoundError', message: 'Session not found' })
  }

  private serve(req: IncomingMessage, res: ServerResponse, body: string) {
    const u = new URL(req.url ?? '/', this.url)
    const method = req.method ?? 'GET'
    const want = `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`
    if (req.headers.authorization !== want) {
      this.reply(res, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' })
      return
    }
    const p = u.pathname
    if (p === '/api/info') {
      this.reply(res, 200, { version: this.version, pid: this.pid, hostname: 'e2e', urls: [this.url] })
      return
    }
    this.requests.push({ method, path: p, query: u.searchParams, body })
    if (p === '/api/command') return this.reply(res, 200, this.commandList)
    if (p === '/api/skill') return this.reply(res, 200, this.skillList)
    if (p === '/api/model') return this.reply(res, 200, this.modelList)
    if (p === '/api/session/active') {
      const data: Json = {}
      for (const id of this.active) data[id] = { type: 'running' }
      return this.reply(res, 200, { data })
    }
    if (p === '/api/session' && method === 'GET') return this.serveList(res, u.searchParams)
    const rest = p.startsWith('/api/session/') ? p.slice('/api/session/'.length) : undefined
    if (rest === undefined) return this.notFound(res)
    const [id, ...sub] = rest.split('/')
    if (method !== 'GET') return this.write(res, method, id, sub, body)
    switch (sub[0] ?? '') {
      case '': {
        const s = this.sessions.get(id)
        return s ? this.reply(res, 200, { data: s }) : this.notFound(res)
      }
      case 'permission':
        return this.reply(res, 200, { data: this.permissions.get(id) ?? [] })
      case 'form':
        return this.reply(res, 200, { data: this.forms.get(id) ?? [] })
      case 'message':
        return this.serveMessages(res, id, sub[1], u.searchParams)
      default:
        return this.notFound(res)
    }
  }

  // session.message.list, newest first from a cursor; session.message.get
  private serveMessages(res: ServerResponse, id: string, msgID: string | undefined, q: URLSearchParams) {
    let msgs = this.messages.get(id)
    if (msgID) {
      const m = msgs?.find((x) => x.id === msgID)
      if (m) return this.reply(res, 200, { data: m })
      return this.reply(res, 404, fixture('message-not-found.json'))
    }
    if (!msgs) return this.notFound(res)
    const kind = q.get('type')
    if (kind) msgs = msgs.filter((m) => m.type === kind)
    const limit = Number(q.get('limit')) || 50
    let end = msgs.length
    const c = q.get('cursor')
    if (c) {
      const n = Number(c.replace(/^older-/, ''))
      if (!Number.isInteger(n) || n < 0 || n > msgs.length) return this.reply(res, 400)
      end = n
    }
    const start = Math.max(0, end - limit)
    const page = msgs.slice(start, end).reverse()
    this.reply(res, 200, { data: page, cursor: { previous: 'newer', next: `older-${start}` } })
  }

  // session.list: parentID=null keeps root sessions, parentID=<id> its
  // children, directory one directory exactly
  private serveList(res: ServerResponse, q: URLSearchParams) {
    const parent = q.get('parentID')
    const all = this.list.filter((s) => {
      if (parent === 'null' && s.parentID) return false
      if (parent && parent !== 'null' && s.parentID !== parent) return false
      if (q.has('directory') && (s.location as Json | undefined)?.directory !== q.get('directory')) return false
      return true
    })
    const start = Number((q.get('cursor') ?? '').replace(/^next-/, '')) || 0
    const limit = Number(q.get('limit')) || 50
    const page = all.slice(start, start + limit)
    const cursor = page.length
      ? { previous: `prev-${start}`, next: `next-${start + page.length}` }
      : { previous: null, next: null }
    this.reply(res, 200, { data: page, cursor })
  }

  private write(res: ServerResponse, method: string, id: string, sub: string[], body: string) {
    const msgs = this.messages.get(id)
    if (method === 'POST' && sub.length === 1 && sub[0] === 'prompt') {
      if (!msgs) return this.notFound(res)
      const prompt = JSON.parse(body || '{}') as Json
      const text = String(prompt.text ?? '')
      const delivery = this.active.has(id) ? 'queue' : 'steer'
      const user = { id: this.nextId(), time: { created: Date.now() }, text, type: 'user' }
      msgs.push(user)
      if (!this.active.has(id)) {
        msgs.push(this.answer(`You said: ${text}`))
      }
      return this.reply(res, 200, {
        data: { id: user.id, sessionID: id, time: user.time, type: 'user', payload: { text }, delivery },
      })
    }
    if (method === 'POST' && sub.length === 1 && sub[0] === 'command') {
      if (!msgs) return this.notFound(res)
      const cmd = JSON.parse(body || '{}') as Json
      const known = (this.commandList.data as Json[]).some((c) => c.name === cmd.name)
      if (!known) return this.reply(res, 404, fixture('command-not-found.json'))
      msgs.push(this.answer(`Ran /${cmd.name}`))
      return this.reply(res, 204)
    }
    const kind = sub[0]
    if (kind === 'permission' || kind === 'form') {
      const src = kind === 'form' ? this.forms : this.permissions
      const answer = sub.length === 3 && sub[2] === 'reply' && method === 'POST'
      const cancel = sub.length === 2 && kind === 'form' && method === 'DELETE'
      if (!answer && !cancel) return this.notFound(res)
      const list = src.get(id) ?? []
      const i = list.findIndex((x) => x.id === sub[1])
      if (i < 0) return this.notFound(res)
      const [done] = list.splice(i, 1)
      // The tool call that asked ends, and the message holding it
      const source = (done.source ?? (done.metadata as Json | undefined)?.tool) as Json | undefined
      const m = msgs?.find((x) => x.id === source?.messageID)
      if (m) {
        const refused = cancel || (kind === 'permission' && JSON.parse(body || '{}').decision === 'reject')
        const status = refused ? 'error' : 'completed'
        m.time = { ...(m.time as Json), completed: Date.now() }
        m.content = ((m.content as Json[] | undefined) ?? []).map((c) =>
          c.type === 'tool' && c.id === source?.id ? { ...c, state: { ...(c.state as Json), status } } : c,
        )
      }
      return this.reply(res, 204)
    }
    this.notFound(res)
  }

  // Ends the turn session id runs: every message still open completes, and
  // the session goes idle
  settle(id: string) {
    this.active.delete(id)
    for (const m of this.messages.get(id) ?? []) {
      const time = m.time as Json
      if (m.type === 'assistant' && !time.completed) {
        m.time = { ...time, completed: Date.now() }
        delete m.retry
      }
    }
  }

  // A finished assistant message holding text
  answer(text: string): Json {
    const now = Date.now()
    return {
      id: this.nextId(),
      time: { created: now, completed: now },
      type: 'assistant',
      agent: 'build',
      model: { id: 'm1', providerID: 'fake' },
      content: [{ type: 'text', text }],
      finish: 'stop',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
  }
}
