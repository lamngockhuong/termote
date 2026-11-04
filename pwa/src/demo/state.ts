import type {
  ActivityEvent,
  MuxGroup,
  MuxPane,
  MuxTab,
  PromptTemplate,
  RecentGroup,
  TaskRunState,
  TranscriptEntry,
  UserTask,
} from '../hooks/use-mux-api'
import { ACME_TRANSCRIPT, WEB_TRANSCRIPT } from './fixtures/agent'
import { HEAD_FILES } from './fixtures/changes'
import { FILES } from './fixtures/files'
import { ACME_ROOT, DEMO_HOME, demoGroups } from './fixtures/workspace'

// Everything the demo's server holds, in memory: a reload starts again from
// the fixtures. Times come from now(), which the tests set.

// Where Claude Code is in a turn the demo plays: working until `until`,
// then asking (a permission dialog), then working again before it answers.
export interface AgentTurn {
  stage: 'working' | 'asking'
  next: 'ask' | 'reply' | 'declined' | 'note'
  startedAt: number
  until: number
  promptId?: string
}

export interface TrashItem {
  trashId: string
  root: string
  path: string
  kind: 'file' | 'discard'
  deletedAt: string
  expiresAt: string
  text: string
}

export interface DemoRun {
  runId: string
  key: string
  tabId: string
  paneId: string
  nonce: string
  endsAt: number
}

export interface DemoState {
  now: () => number
  groups: MuxGroup[]
  // Every file, by absolute path: what Files lists and Changes compares
  files: Map<string, string>
  // acme-api's git index and HEAD, by path under the repo
  index: Map<string, string>
  head: Map<string, string>
  trash: TrashItem[]
  transcripts: Map<string, TranscriptEntry[]>
  turns: Map<string, AgentTurn>
  // Panes that have had their scripted turn: later messages get the note
  answered: Set<string>
  // What a pane made here (a new tab, a task's run) shows
  screens: Map<string, string>
  templates: PromptTemplate[]
  userTasks: UserTask[]
  runs: Map<string, DemoRun>
  recentGroups: RecentGroup[]
  activity: ActivityEvent[]
  seq: number
  // The last number newMuxId gave, past the fixtures' own
  made: number
}

export const REPO_ROOT = ACME_ROOT

export function createState(now: () => number = Date.now): DemoState {
  const files = new Map(Object.entries(FILES))
  const head = new Map<string, string>()
  for (const [abs, text] of files) {
    const rel = repoPath(abs)
    if (rel !== null && rel !== 'auth/ratelimit.go') head.set(rel, text)
  }
  for (const [rel, text] of Object.entries(HEAD_FILES)) head.set(rel, text)
  const t = now()
  const state: DemoState = {
    now,
    groups: demoGroups(t),
    files,
    index: new Map(head),
    head,
    trash: [],
    transcripts: new Map([
      ['w1:p1', structuredClone(ACME_TRANSCRIPT)],
      ['w2:p1', structuredClone(WEB_TRANSCRIPT)],
    ]),
    turns: new Map(),
    answered: new Set(),
    screens: new Map(),
    templates: [
      template('a1b2c3d4e5f60708', 'Review', 'Review the uncommitted changes'),
      template(
        'b2c3d4e5f6070819',
        'Tests for a file',
        'Write table tests for {{file}} and run them',
      ),
    ],
    userTasks: [
      {
        id: 'c3d4e5f60708192a',
        name: 'Deploy to staging',
        command: './deploy.sh staging',
        updated: new Date(t).toISOString(),
      },
    ],
    runs: new Map(),
    recentGroups: [],
    activity: [],
    seq: 0,
    made: 100,
  }
  for (const g of state.groups)
    for (const tab of g.tabs)
      for (const p of tab.panes)
        if (p.agent) record(state, g, tab, p, '', p.agent.status)
  return state
}

function template(id: string, name: string, text: string): PromptTemplate {
  return { id, name, text, updated: '2026-10-11T09:00:00Z' }
}

// The path under acme-api, or null outside it
export function repoPath(abs: string): string | null {
  return abs.startsWith(`${REPO_ROOT}/`)
    ? abs.slice(REPO_ROOT.length + 1)
    : null
}

// A short id unique in this page's life
export function newId(state: DemoState, prefix = ''): string {
  state.seq++
  return `${prefix}${state.seq.toString(16).padStart(prefix ? 1 : 16, '0')}`
}

export function iso(state: DemoState, offsetMs = 0): string {
  return new Date(state.now() + offsetMs).toISOString()
}

// The sha256 a client sends back as baseHash only has to change with the
// text: FNV-1a, as 64 hex digits
export function textHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0').repeat(8)
}

export const byteSize = (text: string) => new TextEncoder().encode(text).length

export interface PaneRef {
  group: MuxGroup
  tab: MuxTab
  pane: MuxPane
}

export function findPane(state: DemoState, paneId: string): PaneRef | null {
  for (const group of state.groups)
    for (const tab of group.tabs)
      for (const pane of tab.panes)
        if (pane.id === paneId) return { group, tab, pane }
  return null
}

export function findTab(
  state: DemoState,
  tabId: string,
): { group: MuxGroup; tab: MuxTab } | null {
  for (const group of state.groups)
    for (const tab of group.tabs) if (tab.id === tabId) return { group, tab }
  return null
}

// The directory a pane's Files and Tasks read
export function paneRoot(ref: PaneRef): string {
  return ref.pane.process?.cwd ?? DEMO_HOME
}

// An agent's status change, recorded for the activity log
export function setAgentStatus(state: DemoState, ref: PaneRef, status: string) {
  const agent = ref.pane.agent
  if (!agent || agent.status === status) return
  record(state, ref.group, ref.tab, ref.pane, agent.status, status)
  agent.status = status
  agent.since = iso(state)
  agent.sinceFirstSeen = false
}

function record(
  state: DemoState,
  group: MuxGroup,
  tab: MuxTab,
  pane: MuxPane,
  from: string,
  to: string,
) {
  state.activity.push({
    seq: state.activity.length + 1,
    ts: iso(state),
    key: pane.id,
    groupId: group.id,
    tabId: tab.id,
    paneId: pane.id,
    agent: pane.agent?.name ?? '',
    from,
    to,
  })
}

// A new id for a group, or a tab or pane of group, never used before: the
// fixtures' panes are known by id (screens.ts), and a run by its tab
export function newMuxId(
  state: DemoState,
  group: MuxGroup | null,
  kind: 'w' | 't' | 'p',
): string {
  state.made++
  return group ? `${group.id}:${kind}${state.made}` : `${kind}${state.made}`
}

// The tab's panes side by side (right) or stacked (down), equal in size
export function layOut(tab: MuxTab, direction: 'right' | 'down' = 'right') {
  const { cols, rows } = tab.layout ?? { cols: 160, rows: 41 }
  const n = tab.panes.length
  tab.layout = {
    cols,
    rows,
    zoomed: false,
    panes: tab.panes.map((p, i) =>
      direction === 'right'
        ? {
            id: p.id,
            x: Math.floor((cols * i) / n),
            y: 0,
            cols: Math.floor((cols * (i + 1)) / n) - Math.floor((cols * i) / n),
            rows,
          }
        : {
            id: p.id,
            x: 0,
            y: Math.floor((rows * i) / n),
            cols,
            rows: Math.floor((rows * (i + 1)) / n) - Math.floor((rows * i) / n),
          },
    ),
  }
}

export function runState(
  state: DemoState,
  run: DemoRun,
): { state: TaskRunState; code?: number } {
  if (!findTab(state, run.tabId)) return { state: 'gone' }
  return state.now() >= run.endsAt
    ? { state: 'exited', code: 0 }
    : { state: 'running' }
}
