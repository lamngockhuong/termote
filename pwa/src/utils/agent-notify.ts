import type { AgentStatus, Session, SessionGroup } from '../types/session'
import { formatDeepLink } from './deep-link'

// When an agent needs the user: its dialog opened (blocked) or its turn ended
// (done). The same rule runs on the server for Web Push
// (server/push_watch.go); both read server/testdata/agent-transitions.json.

export type AgentEventKind = 'blocked' | 'done'

export interface AgentEvent {
  kind: AgentEventKind
  groupId?: string
  tabId: string
  paneId: string
  agentName?: string
}

// The kind a status change raises, if any. A first sighting raises nothing.
export function transitionKind(
  prev: AgentStatus | undefined,
  next: AgentStatus,
): AgentEventKind | undefined {
  if (!prev) return undefined
  if (next === 'blocked' && prev !== 'blocked') return 'blocked'
  if (prev === 'working' && (next === 'done' || next === 'idle')) return 'done'
  return undefined
}

// Last known status of every pane, and what the new snapshot raised. A pane
// with no status (a lookup that timed out, an agent starting) keeps its last
// known one; a pane no longer listed is forgotten.
export function agentTransitions(
  prev: ReadonlyMap<string, AgentStatus>,
  sessions: readonly Session[],
): { next: Map<string, AgentStatus>; events: AgentEvent[] } {
  const next = new Map<string, AgentStatus>()
  const events: AgentEvent[] = []
  for (const s of sessions) {
    for (const p of s.panes ?? []) {
      const last = prev.get(p.id)
      const status = p.agentStatus ?? last
      if (status) next.set(p.id, status)
      const kind = p.agentStatus && transitionKind(last, p.agentStatus)
      if (kind) {
        events.push({
          kind,
          groupId: s.groupId,
          tabId: s.id,
          paneId: p.id,
          agentName: p.agentName,
        })
      }
    }
  }
  return { next, events }
}

export interface NotifyContext {
  enabled: boolean
  permission: NotificationPermission | 'unsupported'
  // This device gets the same event by Web Push from the server
  pushActive: boolean
  visible: boolean
  focused: boolean
  activePaneId?: string
}

// The pane the user is looking at never notifies.
export function shouldNotify(event: AgentEvent, ctx: NotifyContext): boolean {
  if (!ctx.enabled || ctx.permission !== 'granted' || ctx.pushActive) {
    return false
  }
  return !(ctx.visible && ctx.focused && ctx.activePaneId === event.paneId)
}

const NAME_MAX = 64
// C0 and C1 controls, and the bidi marks, embeddings, overrides and isolates
// that could make a name read as something else on a lock screen.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g

// A name (group, tab, agent) made safe to show in a notification.
export function cleanName(name: string | undefined): string {
  return Array.from((name ?? '').replace(UNSAFE_CHARS, '').trim())
    .slice(0, NAME_MAX)
    .join('')
}

export interface NotificationContent {
  title: string
  options: NotificationOptions & { renotify: boolean; data: { hash: string } }
}

export function notificationTitle(kind: AgentEventKind): string {
  return kind === 'blocked' ? 'Agent needs you' : 'Agent finished'
}

// Names only: no screen or transcript text, and never the pane title, which
// whatever runs in the pane can set.
export function notificationContent(
  event: AgentEvent,
  sessions: readonly Session[],
  groups: readonly SessionGroup[],
): NotificationContent {
  const tab = sessions.find((s) => s.id === event.tabId)
  const group = groups.find((g) => g.id === event.groupId)
  const agent = cleanName(event.agentName) || 'Agent'
  const place = [cleanName(group?.name), cleanName(tab?.name)]
    .filter(Boolean)
    .join(' / ')
  const hash = event.groupId
    ? formatDeepLink({
        group: event.groupId,
        tab: event.tabId,
        pane: event.paneId,
      })
    : ''
  return {
    title: notificationTitle(event.kind),
    options: {
      body: place ? `${agent} · ${place}` : agent,
      tag: event.paneId,
      renotify: true,
      icon: '/pwa-192x192.png',
      data: { hash },
    },
  }
}
