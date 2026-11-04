import { MUX_API_VERSION } from '../hooks/use-mux-api'
import { APP_INFO } from '../utils/app-info'
import { demoHostStats } from './fixtures/system'
import { DEMO_CAPS, DEMO_HOME } from './fixtures/workspace'
import { fail, type Handler, json } from './http'
import { gitStatus } from './repo'
import { lastAssistantText } from './routes-agent'
import { plainScreen } from './screens'
import {
  findPane,
  findTab,
  iso,
  layOut,
  newMuxId,
  paneRoot,
  REPO_ROOT,
} from './state'

// The routes of the machine itself: what runs where (groups, tabs, panes),
// its health and activity, as the Herdr backend answers them.

const ok = () => json({ ok: true })
const unknownPane = () => fail(404, 'unknown_pane', 'unknown pane')
const unknownTab = () => fail(404, 'unknown_tab', 'unknown tab')
const unknownGroup = () => fail(404, 'unknown_group', 'unknown group')

// Moves list's item at from to index (clamped)
function move<T>(list: T[], from: number, index: number) {
  const [item] = list.splice(from, 1)
  list.splice(Math.max(0, Math.min(index, list.length)), 0, item)
}

const health: Handler = () =>
  json({
    apiVersion: MUX_API_VERSION,
    backend: 'herdr',
    status: 'ok',
    version: APP_INFO.version,
    install: 'release',
  })

const snapshot: Handler = ({ state }) =>
  json({
    apiVersion: MUX_API_VERSION,
    backend: 'herdr',
    caps: DEMO_CAPS,
    groups: structuredClone(state.groups),
    serverNow: iso(state),
    instanceId: 'demo',
  })

const activity: Handler = ({ state, query }) => {
  const after = Number(query.get('after') ?? 0)
  return json({
    events: state.activity.filter((e) => e.seq > after),
    latest: state.activity.length,
    oldest: 1,
    serverNow: iso(state),
  })
}

const overview: Handler = ({ state, query }) => {
  const only = query.get('pane')
  const changed = gitStatus(state).length
  const panes = []
  for (const g of state.groups)
    for (const tab of g.tabs)
      for (const p of tab.panes) {
        if (!p.agent || (only && p.id !== only)) continue
        const last = lastAssistantText(state, p.id)
        const inRepo = paneRoot({ group: g, tab, pane: p }) === REPO_ROOT
        panes.push({
          paneId: p.id,
          key: p.id,
          lastText: last?.text,
          lastTs: last?.ts,
          ...(inRepo ? { branch: 'main' } : {}),
          ...(inRepo && !only ? { changed } : {}),
          usage: {
            contextTokens: inRepo ? 52_400 : 18_900,
            model: 'claude-sonnet-4-5',
            contextWindow: 200_000,
            contextPercent: inRepo ? 26 : 9,
            exact: true,
          },
        })
      }
  return json({ serverNow: iso(state), panes })
}

const selectTab: Handler = ({ state, params }) => {
  const found = findTab(state, params.id)
  if (!found) return unknownTab()
  for (const t of found.group.tabs) t.active = t === found.tab
  return ok()
}

const createTab: Handler = ({ state, body }) => {
  const group =
    state.groups.find((g) => g.id === body?.groupId) ?? state.groups[0]
  if (!group) return unknownGroup()
  const root = group.tabs[0]?.panes[0]?.process?.cwd ?? DEMO_HOME
  const tabId = newMuxId(state, group, 't')
  const paneId = newMuxId(state, group, 'p')
  const tab = {
    id: tabId,
    key: tabId,
    name: body?.name || String(group.tabs.length + 1),
    active: true,
    panes: [{ id: paneId, active: true, process: { name: 'bash', cwd: root } }],
  }
  layOut(tab)
  for (const t of group.tabs) t.active = false
  group.tabs.push(tab)
  return json({ ok: true, id: tabId })
}

const changeTab: Handler = ({ state, params, method, body }) => {
  const found = findTab(state, params.id)
  if (!found) return unknownTab()
  if (method === 'PATCH') {
    found.tab.name = String(body?.name ?? '')
    return ok()
  }
  const { group, tab } = found
  group.tabs.splice(group.tabs.indexOf(tab), 1)
  if (tab.active && group.tabs[0]) group.tabs[0].active = true
  if (group.tabs.length === 0)
    state.groups.splice(state.groups.indexOf(group), 1)
  return ok()
}

const moveTab: Handler = ({ state, params, body }) => {
  const found = findTab(state, params.id)
  if (!found) return unknownTab()
  const tabs = found.group.tabs
  move(tabs, tabs.indexOf(found.tab), Number(body?.index))
  return json({ id: found.tab.id })
}

const createGroup: Handler = ({ state, body }) => {
  const name = String(body?.name ?? '').trim()
  if (!name) return fail(400, 'invalid_name', 'invalid name')
  const cwd = String(body?.cwd ?? '').trim()
  const root = cwd ? cwd.replace(/^~(?=\/|$)/, DEMO_HOME) : DEMO_HOME
  const id = newMuxId(state, null, 'w')
  const tab = {
    id: `${id}:t1`,
    key: `${id}:t1`,
    name: '1',
    active: true,
    panes: [
      { id: `${id}:p1`, active: true, process: { name: 'bash', cwd: root } },
    ],
  }
  layOut(tab)
  state.groups.push({ id, name, tabs: [tab] })
  if (cwd) {
    state.recentGroups = state.recentGroups.filter((r) => r.cwd !== cwd)
    state.recentGroups.unshift({ id: `r${id}`, name, cwd })
  }
  return json({ id })
}

const changeGroup: Handler = ({ state, params, method, body }) => {
  const group = state.groups.find((g) => g.id === params.id)
  if (!group) return unknownGroup()
  if (method === 'PATCH') {
    const name = String(body?.name ?? '').trim()
    if (!name) return fail(400, 'invalid_name', 'invalid name')
    group.name = name
  } else state.groups.splice(state.groups.indexOf(group), 1)
  return json({})
}

const moveGroup: Handler = ({ state, params, body }) => {
  const from = state.groups.findIndex((g) => g.id === params.id)
  if (from < 0) return unknownGroup()
  move(state.groups, from, Number(body?.index))
  return json({})
}

const recentGroups: Handler = ({ state }) =>
  json({ groups: state.recentGroups, readOnly: false })

const removeRecent: Handler = ({ state, params }) => {
  const before = state.recentGroups.length
  state.recentGroups = state.recentGroups.filter((r) => r.id !== params.id)
  if (state.recentGroups.length === before)
    return fail(404, 'unknown_recent', 'unknown recent group')
  return json({})
}

const changePane: Handler = ({ state, params, method, body }) => {
  const ref = findPane(state, params.id)
  if (!ref) return unknownPane()
  if (method === 'PATCH') {
    const name = String(body?.name ?? '').trim()
    if (name.length > 64) return fail(400, 'invalid_name', 'invalid name')
    if (name) ref.pane.name = name
    else delete ref.pane.name
    return json({})
  }
  const { tab, pane } = ref
  tab.panes.splice(tab.panes.indexOf(pane), 1)
  if (tab.panes.length === 0) {
    ref.group.tabs.splice(ref.group.tabs.indexOf(tab), 1)
    if (ref.group.tabs.length === 0)
      state.groups.splice(state.groups.indexOf(ref.group), 1)
  } else {
    if (pane.active) tab.panes[0].active = true
    layOut(tab)
  }
  return ok()
}

const splitPane: Handler = ({ state, params, body }) => {
  const ref = findPane(state, params.id)
  if (!ref) return unknownPane()
  const id = newMuxId(state, ref.group, 'p')
  const { tab } = ref
  tab.panes.splice(tab.panes.indexOf(ref.pane) + 1, 0, {
    id,
    active: false,
    process: { name: 'bash', cwd: paneRoot(ref) },
  })
  layOut(tab, body?.direction === 'down' ? 'down' : 'right')
  return json({ id })
}

// Zoom, swap and resize change only the desktop's layout (caps.paneStream):
// the PWA does not offer them, and the demo has no desktop
const paneOk: Handler = ({ state, params }) =>
  findPane(state, params.id) ? json({}) : unknownPane()

const paneWrite: Handler = ({ state, params }) =>
  findPane(state, params.id) ? ok() : unknownPane()

const paneText: Handler = ({ state, params }) => {
  if (!findPane(state, params.id)) return unknownPane()
  const text = plainScreen(state, params.id)
  return json({
    text,
    lines: text.split('\n').length,
    truncated: false,
    more: false,
  })
}

const subagents: Handler = () => json({ nodes: [] })

const worktrees: Handler = ({ state, query }) => {
  const group = state.groups.find((g) => g.id === query.get('groupId'))
  if (!group) return unknownGroup()
  return json({
    repoName: 'acme-api',
    worktrees: [
      {
        path: REPO_ROOT,
        branch: 'main',
        linked: false,
        openable: false,
        groupId: 'w1',
      },
    ],
    branches: ['main'],
  })
}

export const MUX_ROUTES: Record<string, Handler> = {
  'GET /health': health,
  'GET /snapshot': snapshot,
  'GET /activity': activity,
  'GET /overview': overview,
  'GET /system': ({ state }) => json(demoHostStats(state.now())),
  'GET /stream-token': () => json({ token: 'demo' }),
  'POST /tabs': createTab,
  'PATCH /tabs/{id}': changeTab,
  'DELETE /tabs/{id}': changeTab,
  'POST /tabs/{id}/select': selectTab,
  'POST /tabs/{id}/move': moveTab,
  'POST /groups': createGroup,
  'PATCH /groups/{id}': changeGroup,
  'DELETE /groups/{id}': changeGroup,
  'POST /groups/{id}/move': moveGroup,
  'GET /recent-groups': recentGroups,
  'DELETE /recent-groups/{id}': removeRecent,
  'GET /worktrees': worktrees,
  'PATCH /panes/{id}': changePane,
  'DELETE /panes/{id}': changePane,
  'POST /panes/{id}/split': splitPane,
  'POST /panes/{id}/zoom': paneOk,
  'POST /panes/{id}/swap': paneOk,
  'POST /panes/{id}/resize': paneOk,
  'POST /panes/{id}/keys': paneWrite,
  'POST /panes/{id}/scroll': paneWrite,
  'GET /panes/{id}/text': paneText,
  'GET /panes/{id}/agent/subagents': subagents,
}
