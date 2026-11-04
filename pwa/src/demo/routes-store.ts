import type { PromptTemplate, UserTask } from '../hooks/use-mux-api'
import { NO_TASKS, TASKS } from './fixtures/tasks'
import { prompt } from './fixtures/terminal'
import { DEMO_HOME } from './fixtures/workspace'
import { type DemoRequest, fail, type Handler, json } from './http'
import {
  type DemoState,
  findPane,
  iso,
  layOut,
  newId,
  newMuxId,
  paneRoot,
  runState,
} from './state'

// What the server keeps for every device: prompt templates and the user's
// tasks, and the Tasks view's runs, here in memory.

export const TASK_RUN_MS = 3000

// A list of named things (templates, tasks) and its routes: names unique
// in any case, a change or delete naming the version it read
interface Store<T extends { id: string; name: string; updated: string }> {
  key: 'template' | 'task'
  list: (state: DemoState) => T[]
  // The item from a request's fields, or the field that is wrong
  read: (body: any) => Omit<T, 'id' | 'updated'> | { field: string }
}

function storeRoutes<T extends { id: string; name: string; updated: string }>(
  s: Store<T>,
) {
  const invalid = `invalid_${s.key}`
  const parse = (body: any) => {
    const item = s.read(body)
    return 'field' in item
      ? { refusal: fail(400, invalid, `invalid ${s.key}`, item) }
      : { item }
  }
  const taken = (state: DemoState, name: string, except?: string) =>
    s
      .list(state)
      .some(
        (i) => i.id !== except && i.name.toLowerCase() === name.toLowerCase(),
      )
  const sort = (list: T[]) =>
    list.sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    )
  const find = (req: DemoRequest) =>
    s.list(req.state).find((i) => i.id === req.params.id)

  const create: Handler = (req) => {
    const { item, refusal } = parse(req.body)
    if (refusal) return refusal
    if (taken(req.state, (item as T).name))
      return fail(409, 'name_taken', 'name taken')
    const saved = {
      ...item,
      id: newId(req.state),
      updated: iso(req.state),
    } as T
    s.list(req.state).push(saved)
    sort(s.list(req.state))
    return json({ [s.key]: saved })
  }
  const update: Handler = (req) => {
    const now = find(req)
    if (!now) return fail(404, 'not_found', 'not found')
    if (now.updated !== req.body?.updated)
      return fail(409, 'conflict', 'changed on another device', {
        [s.key]: now,
      })
    const { item, refusal } = parse(req.body)
    if (refusal) return refusal
    if (taken(req.state, (item as T).name, now.id))
      return fail(409, 'name_taken', 'name taken')
    Object.assign(now, item, { updated: iso(req.state, 1) })
    sort(s.list(req.state))
    return json({ [s.key]: now })
  }
  const remove: Handler = (req) => {
    const now = find(req)
    if (!now) return fail(404, 'not_found', 'not found')
    if (now.updated !== req.query.get('updated'))
      return fail(409, 'conflict', 'changed on another device', {
        [s.key]: now,
      })
    const list = s.list(req.state)
    list.splice(list.indexOf(now), 1)
    return json({})
  }
  return { create, update, remove }
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

const templates = storeRoutes<PromptTemplate>({
  key: 'template',
  list: (state) => state.templates,
  read: (body) => {
    const name = text(body?.name)
    const t = typeof body?.text === 'string' ? body.text : ''
    if (!name || name.length > 80) return { field: 'name' }
    if (!t.trim()) return { field: 'text' }
    return { name, text: t }
  },
})

const userTasks = storeRoutes<UserTask>({
  key: 'task',
  list: (state) => state.userTasks,
  read: (body) => {
    const name = text(body?.name)
    const command = text(body?.command)
    if (!name || name.length > 80) return { field: 'name' }
    if (!command) return { field: 'command' }
    return { name, command }
  },
})

// What an import would add and replace, by name in any case
const importTemplates: Handler = ({ state, query, body }) => {
  const list: { name: string; text: string }[] = Array.isArray(body?.templates)
    ? body.templates
    : []
  const added: string[] = []
  const replaced: string[] = []
  for (const t of list) {
    const same = state.templates.find(
      (x) => x.name.toLowerCase() === text(t.name).toLowerCase(),
    )
    ;(same ? replaced : added).push(text(t.name))
  }
  if (query.get('dryRun')) return json({ added, replaced })
  for (const t of list) {
    const same = state.templates.find(
      (x) => x.name.toLowerCase() === text(t.name).toLowerCase(),
    )
    if (same) Object.assign(same, { text: t.text, updated: iso(state, 1) })
    else
      state.templates.push({
        id: newId(state),
        name: text(t.name),
        text: t.text,
        updated: iso(state),
      })
  }
  return json({ added: added.length, replaced: replaced.length })
}

const paneTasks: Handler = ({ state, params }) => {
  const ref = findPane(state, params.id)
  if (!ref) return fail(404, 'unknown_pane', 'unknown pane')
  const root = paneRoot(ref)
  const runs: Record<string, object> = {}
  for (const run of state.runs.values())
    runs[run.key] = { ...run, ...runState(state, run) }
  return json({
    root,
    ...(TASKS[root] ?? NO_TASKS),
    userTasks: state.userTasks,
    runs,
  })
}

// The command line a task names, as the server would type it
function taskCommand(
  state: DemoState,
  root: string,
  kind: string,
  name?: string,
  id?: string,
): string | null {
  const found = TASKS[root] ?? NO_TASKS
  if (kind === 'user')
    return state.userTasks.find((t) => t.id === id)?.command ?? null
  if (kind === 'make')
    return found.makeTargets.some((t) => t.name === name)
      ? `make ${name}`
      : null
  if (kind === 'script')
    return found.scripts.some((t) => t.name === name)
      ? `${found.packageManager} run ${name}`
      : null
  const group = found.toolGroups.find((g) => g.tool === kind)
  return group?.tasks.find((t) => t.name === name)?.command ?? null
}

// A run opens a tab at the pane's root that shows the command typed; the
// demo runs nothing, which the tab says
const runTask: Handler = ({ state, params, body }) => {
  const ref = findPane(state, params.id)
  if (!ref) return fail(404, 'unknown_pane', 'unknown pane')
  const root = paneRoot(ref)
  const kind = String(body?.kind ?? '')
  const command = taskCommand(state, root, kind, body?.name, body?.id)
  if (command === null) return fail(404, 'task_not_found', 'no such task')
  const tabId = newMuxId(state, ref.group, 't')
  const paneId = newMuxId(state, ref.group, 'p')
  const tab = {
    id: tabId,
    key: tabId,
    name: body?.name ?? command,
    active: false,
    panes: [{ id: paneId, active: true, process: { name: 'bash', cwd: root } }],
  }
  layOut(tab)
  ref.group.tabs.push(tab)
  const dir = root.replace(DEMO_HOME, '~')
  state.screens.set(
    paneId,
    `${prompt(dir)}${command}\n\x1b[2m(the demo runs nothing)\x1b[0m\n${prompt(dir)}`,
  )
  const run = {
    runId: newId(state, 'run'),
    key: `${kind}:${kind === 'user' ? body?.id : body?.name}`,
    tabId,
    paneId,
    nonce: newId(state, 'n'),
    endsAt: state.now() + TASK_RUN_MS,
  }
  state.runs.set(run.runId, run)
  const { runId, nonce } = run
  return json({ runId, tabId, paneId, nonce, reused: false })
}

const taskRun: Handler = ({ state, params }) => {
  const run = state.runs.get(params.runId)
  if (!run) return fail(404, 'run_not_found', 'no such run')
  return json(runState(state, run))
}

export const STORE_ROUTES: Record<string, Handler> = {
  'GET /templates': ({ state }) =>
    json({ templates: state.templates, readOnly: false }),
  'POST /templates': templates.create,
  'PUT /templates/{id}': templates.update,
  'DELETE /templates/{id}': templates.remove,
  'POST /templates/import': importTemplates,
  'GET /tasks': ({ state }) =>
    json({ tasks: state.userTasks, readOnly: false }),
  'POST /tasks': userTasks.create,
  'PUT /tasks/{id}': userTasks.update,
  'DELETE /tasks/{id}': userTasks.remove,
  'GET /tasks/runs/{runId}': taskRun,
  'GET /panes/{id}/tasks': paneTasks,
  'POST /panes/{id}/tasks/run': runTask,
}
