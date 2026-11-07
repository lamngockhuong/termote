import type { BlameRange, FileEntry, SearchFile } from '../hooks/use-mux-api'
import { LAST_COMMIT } from './fixtures/changes'
import { type DemoRequest, fail, type Handler, json, unsupported } from './http'
import { diffHunks } from './line-diff'
import { entryDiff, gitStatus, worktreeText } from './repo'
import {
  byteSize,
  type DemoState,
  findPane,
  iso,
  newId,
  paneRoot,
  REPO_ROOT,
  repoPath,
  textHash,
} from './state'

// Files and Changes (/panes/{id}/files/*) over the demo's files in memory:
// reads, saves, creates, renames, the trash, and acme-api's git status.

const TRASH_DAYS = 7

interface Target {
  root: string
  isRepo: boolean
}

// The pane's root, or the refusal to send instead
function target(req: DemoRequest): Target | Response {
  const ref = findPane(req.state, req.params.id)
  if (!ref) return fail(404, 'unknown_pane', 'unknown pane')
  if (req.query.get('place')) return fail(404, 'unknown_place', 'unknown place')
  const root = paneRoot(ref)
  return {
    root,
    isRepo: root === REPO_ROOT || root.startsWith(`${REPO_ROOT}/`),
  }
}

// A handler of a pane's files, given its root
function withRoot(fn: (req: DemoRequest, t: Target) => Response): Handler {
  return (req) => {
    const t = target(req)
    return t instanceof Response ? t : fn(req, t)
  }
}

// A path under the root as the client sends it, cleaned; null when it
// leaves the root
function clean(path: unknown): string | null {
  const parts: string[] = []
  for (const p of String(path ?? '').split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') return null
    parts.push(p)
  }
  return parts.join('/')
}

// Paths in the order the server lists them: by UTF-16 code unit, not locale
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const abs = (t: Target, rel: string) => (rel ? `${t.root}/${rel}` : t.root)

const invalidPath = () => fail(400, 'invalid_path', 'invalid path')
const notFound = () => fail(404, 'not_found', 'not found')

// Every file under the root, by path under it
function under(state: DemoState, t: Target): [string, string][] {
  const out: [string, string][] = []
  for (const [p, text] of state.files)
    if (p.startsWith(`${t.root}/`)) out.push([p.slice(t.root.length + 1), text])
  return out.sort(([a], [b]) => byCodeUnit(a, b))
}

const isDir = (state: DemoState, t: Target, rel: string) =>
  rel === '' || under(state, t).some(([p]) => p.startsWith(`${rel}/`))

const tree = withRoot((req, t) => {
  const rel = clean(req.query.get('path'))
  if (rel === null) return invalidPath()
  if (!isDir(req.state, t, rel)) return notFound()
  const entries = new Map<string, FileEntry>()
  const prefix = rel ? `${rel}/` : ''
  for (const [p, text] of under(req.state, t)) {
    if (!p.startsWith(prefix)) continue
    const [name, ...rest] = p.slice(prefix.length).split('/')
    entries.set(name, {
      name,
      type: rest.length ? 'dir' : 'file',
      size: rest.length ? 0 : byteSize(text),
      sensitive: false,
    })
  }
  const sorted = [...entries.values()].sort(
    (a, b) =>
      Number(b.type === 'dir') - Number(a.type === 'dir') ||
      byCodeUnit(a.name.toLowerCase(), b.name.toLowerCase()),
  )
  return json({
    root: t.root,
    isRepo: t.isRepo,
    path: rel || '.',
    entries: sorted,
    truncated: false,
  })
})

const readContent = withRoot((req, t) => {
  const rel = clean(req.query.get('path'))
  if (rel === null) return invalidPath()
  const text = req.state.files.get(abs(t, rel))
  if (text === undefined) return notFound()
  const size = byteSize(text)
  const hash = textHash(text)
  if (req.query.get('hash'))
    return json({ root: t.root, path: rel, size, hash })
  return json({
    root: t.root,
    path: rel,
    size,
    text,
    hash,
    encoding: 'utf-8',
    editable: true,
  })
})

const saveContent = withRoot(({ state, body }, t) => {
  const rel = clean(body?.path)
  if (!rel) return invalidPath()
  const file = abs(t, rel)
  const now = state.files.get(file)
  if (now === undefined) return notFound()
  const text = String(body?.text ?? '')
  if (now !== text && body?.baseHash !== textHash(now))
    return fail(409, 'changed', 'the file changed since it was read')
  state.files.set(file, text)
  return json({
    root: t.root,
    path: rel,
    size: byteSize(text),
    hash: textHash(text),
    encoding: 'utf-8',
  })
})

const createFile = withRoot(({ state, body }, t) => {
  const rel = clean(body?.path)
  if (!rel) return fail(400, 'invalid_name', 'invalid name')
  if (state.files.has(abs(t, rel)) || isDir(state, t, rel))
    return fail(409, 'exists', 'already exists', { path: rel })
  state.files.set(abs(t, rel), '')
  return json({ root: t.root, path: rel })
})

const renameFile = withRoot(({ state, body }, t) => {
  const from = clean(body?.path)
  const to = clean(body?.newPath)
  if (!from || !to) return invalidPath()
  const text = state.files.get(abs(t, from))
  if (text === undefined) return notFound()
  if (state.files.has(abs(t, to)) || isDir(state, t, to))
    return fail(409, 'exists', 'already exists', { path: to })
  state.files.delete(abs(t, from))
  state.files.set(abs(t, to), text)
  return json({ root: t.root, path: to })
})

function toTrash(
  state: DemoState,
  t: Target,
  rel: string,
  kind: 'file' | 'discard',
): string {
  const file = abs(t, rel)
  const text = state.files.get(file) ?? ''
  const trashId = newId(state, 'trash')
  state.trash.unshift({
    trashId,
    root: t.root,
    path: rel,
    kind,
    deletedAt: iso(state),
    expiresAt: iso(state, TRASH_DAYS * 86_400_000),
    text,
  })
  state.files.delete(file)
  return trashId
}

const deleteFile = withRoot(({ state, body }, t) => {
  const rel = clean(body?.path)
  if (!rel) return invalidPath()
  const text = state.files.get(abs(t, rel))
  if (text === undefined)
    return isDir(state, t, rel)
      ? fail(409, 'not_empty', 'the folder is not empty')
      : notFound()
  if (body?.baseHash && body.baseHash !== textHash(text))
    return fail(409, 'changed', 'the file changed since it was read')
  const size = byteSize(text)
  const trashId = toTrash(state, t, rel, 'file')
  return json({ root: t.root, path: rel, trashId, size })
})

const restoreFile = withRoot(({ state, body }, t) => {
  const item = state.trash.find(
    (i) => i.trashId === body?.trashId && i.root === t.root,
  )
  if (!item) return fail(404, 'not_in_trash', 'not in the trash')
  if (state.files.has(abs(t, item.path)))
    return fail(409, 'exists', 'already exists', { path: item.path })
  state.files.set(abs(t, item.path), item.text)
  state.trash.splice(state.trash.indexOf(item), 1)
  return json({ root: t.root, path: item.path })
})

const trashList = withRoot(({ state }, t) =>
  json({
    root: t.root,
    entries: state.trash
      .filter((i) => i.root === t.root)
      .map(({ trashId, path, kind, deletedAt, expiresAt, text }) => ({
        trashId,
        path,
        kind,
        deletedAt,
        expiresAt,
        size: byteSize(text),
      })),
  }),
)

const trashDelete = withRoot(({ state, body }, t) => {
  const i = state.trash.findIndex(
    (item) => item.trashId === body?.trashId && item.root === t.root,
  )
  if (i < 0) return fail(404, 'not_in_trash', 'not in the trash')
  state.trash.splice(i, 1)
  return json({ root: t.root, trashId: body.trashId })
})

const trashEmpty = withRoot(({ state, body }, t) => {
  const ids = new Set<string>(
    Array.isArray(body?.trashIds) ? body.trashIds : [],
  )
  const before = state.trash.length
  state.trash = state.trash.filter(
    (i) => !(i.root === t.root && ids.has(i.trashId)),
  )
  return json({ root: t.root, removed: before - state.trash.length, failed: 0 })
})

// Files whose path holds the query's characters in order, those holding it
// whole first, then the shorter
const find = withRoot(({ state, query }, t) => {
  const q = (query.get('q') ?? '').toLowerCase()
  const fits = (p: string) => {
    let i = 0
    for (const c of p.toLowerCase()) if (c === q[i]) i++
    return i === q.length
  }
  const results = under(state, t)
    .map(([p]) => p)
    .filter(fits)
    .sort(
      (a, b) =>
        Number(b.toLowerCase().includes(q)) -
          Number(a.toLowerCase().includes(q)) || a.length - b.length,
    )
    .slice(0, 200)
    .map((path) => ({ path, ignored: false, sensitive: false }))
  return json({
    root: t.root,
    isRepo: t.isRepo,
    results,
    truncated: false,
    incomplete: false,
  })
})

function searchPattern(query: URLSearchParams): RegExp | null {
  const q = query.get('q') ?? ''
  let source = query.get('regex') ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (query.get('word')) source = `\\b${source}\\b`
  try {
    return new RegExp(source, query.get('case') ? 'g' : 'gi')
  } catch {
    return null
  }
}

const search = withRoot(({ state, query }, t) => {
  const re = searchPattern(query)
  if (!re) return fail(400, 'invalid_regex', 'invalid regular expression')
  const files: SearchFile[] = []
  for (const [path, text] of under(state, t)) {
    const matches = text.split('\n').flatMap((line, n) => {
      const ranges = [...line.matchAll(re)]
        .filter((m) => m[0] !== '')
        .map((m): [number, number] => [m.index, m.index + m[0].length])
      return ranges.length ? [{ line: n + 1, text: line, col: 0, ranges }] : []
    })
    if (matches.length) files.push({ path, matches, more: 0 })
  }
  return json({
    root: t.root,
    isRepo: t.isRepo,
    files,
    truncated: false,
    incomplete: false,
    skipped: { sensitive: 0, hidden: 0, binary: 0, tooLarge: 0 },
  })
})

const notRepo = (t: Target) =>
  json({ root: t.root, isRepo: false, entries: [], truncated: false })

const changes = withRoot(({ state }, t) =>
  t.isRepo
    ? json({
        root: t.root,
        isRepo: true,
        branch: 'main',
        entries: gitStatus(state),
        truncated: false,
      })
    : notRepo(t),
)

// The path under the repo of a Changes request
function changePath(t: Target, path: unknown): string | null {
  const rel = clean(path)
  return t.isRepo && rel ? repoPath(abs(t, rel)) : null
}

const diff = withRoot(({ state, query }, t) => {
  const path = changePath(t, query.get('path'))
  if (path === null) return invalidPath()
  const staged = query.get('staged') === '1'
  const work = worktreeText(state, path)
  return json({
    root: t.root,
    path: clean(query.get('path')),
    truncated: false,
    hunks: entryDiff(state, path, staged),
    ...(!staged && work !== undefined ? { worktreeHash: textHash(work) } : {}),
  })
})

const applyChange = withRoot(({ state, body }, t) => {
  const path = changePath(t, body?.path)
  if (path === null) return invalidPath()
  if (body?.hunk) return fail(400, 'hunk_unsupported', 'apply the whole file')
  const rel = clean(body.path) as string
  const work = worktreeText(state, path)
  const index = state.index.get(path)
  const head = state.head.get(path)
  const set = (map: Map<string, string>, text?: string) =>
    text === undefined ? map.delete(path) : map.set(path, text)
  if (body.action === 'stage') set(state.index, work)
  else if (body.action === 'unstage') set(state.index, head)
  else if (body.action === 'discard') {
    if (work === index) return fail(409, 'not_changed', 'nothing to discard')
    const trashId =
      work === undefined ? undefined : toTrash(state, t, rel, 'discard')
    if (index !== undefined) state.files.set(`${REPO_ROOT}/${path}`, index)
    return json({ root: t.root, path: rel, trashId })
  } else return fail(400, 'invalid_action', 'invalid action')
  return json({ root: t.root, path: rel })
})

const commit = withRoot((_req, t) =>
  t.isRepo
    ? json({ root: t.root, isRepo: true, commit: LAST_COMMIT })
    : json({ root: t.root, isRepo: false }),
)

// The one commit added every file: its diff is the whole committed text
const commitDiff = withRoot(({ state, query }, t) => {
  const path = changePath(t, query.get('path'))
  if (path === null) return invalidPath()
  if (query.get('commit') !== LAST_COMMIT.hash)
    return fail(409, 'head_moved', 'HEAD moved')
  return json({
    root: t.root,
    path,
    truncated: false,
    hunks: diffHunks('', state.head.get(path) ?? ''),
  })
})

// Every committed line is the one commit's; a line the worktree added or
// changed since is not committed
const blame = withRoot(({ state, query }, t) => {
  if (!t.isRepo) return fail(404, 'not_repo', 'not a git repository')
  const path = changePath(t, query.get('path'))
  if (path === null) return invalidPath()
  const text = worktreeText(state, path)
  if (text === undefined) return notFound()
  if (query.get('hash') !== textHash(text))
    return fail(409, 'file_changed', 'the file changed since it was read')
  const head = state.head.get(path)
  if (head === undefined)
    return fail(404, 'not_tracked', 'the file is not in the last commit')
  const added = new Set<number>()
  for (const h of diffHunks(head, text))
    for (const l of h.lines) if (l.kind === 'add') added.add(l.new as number)
  const lines = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
  const ranges: BlameRange[] = []
  const uncommitted: BlameRange[] = []
  for (let n = 1; n <= lines; n++) {
    const list = added.has(n) ? uncommitted : ranges
    const last = list[list.length - 1]
    if (last && last.start + last.count === n) last.count++
    else
      list.push(
        added.has(n)
          ? { start: n, count: 1 }
          : { start: n, count: 1, commit: LAST_COMMIT.hash },
      )
  }
  const { author, time, message } = LAST_COMMIT
  return json({
    root: t.root,
    path: clean(query.get('path')),
    lines,
    commits: ranges.length
      ? {
          [LAST_COMMIT.hash]: { author, time, summary: message.split('\n')[0] },
        }
      : {},
    ranges,
    uncommitted,
  })
})

export const FILES_ROUTES: Record<string, Handler> = {
  'GET /files/places': () => json({ places: [] }),
  'GET /panes/{id}/files/tree': tree,
  'GET /panes/{id}/files/content': readContent,
  'PUT /panes/{id}/files/content': saveContent,
  'POST /panes/{id}/files/create': createFile,
  'POST /panes/{id}/files/rename': renameFile,
  'POST /panes/{id}/files/delete': deleteFile,
  'POST /panes/{id}/files/restore': restoreFile,
  'GET /panes/{id}/files/trash': trashList,
  'POST /panes/{id}/files/trash/delete': trashDelete,
  'POST /panes/{id}/files/trash/empty': trashEmpty,
  'GET /panes/{id}/files/find': find,
  'GET /panes/{id}/files/search': search,
  'GET /panes/{id}/files/changes': changes,
  'POST /panes/{id}/files/changes/apply': applyChange,
  'GET /panes/{id}/files/diff': diff,
  'GET /panes/{id}/files/commit': commit,
  'GET /panes/{id}/files/commit/diff': commitDiff,
  'GET /panes/{id}/files/blame': blame,
  // The demo holds text files only, and nothing leaves the page
  'GET /panes/{id}/files/raw': () => fail(415, 'not_image', 'not an image'),
  'GET /panes/{id}/files/document': () =>
    fail(415, 'not_document', 'not a document'),
  'GET /panes/{id}/files/download': unsupported,
  'POST /panes/{id}/files/image': unsupported,
  'POST /panes/{id}/files/upload': unsupported,
}
