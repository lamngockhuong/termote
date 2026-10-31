import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import type { AgentStatus, Session, SessionGroup } from '../types/session'
import { formatDeepLink } from './deep-link'
import { UNSAFE_CHARS } from './unsafe-chars'

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

// Last known status of every pane, and what the new snapshot raised. An
// agent with no status (one starting) keeps its last known one; a pane with
// no agent, or no longer listed, is forgotten, so a new agent there is a
// first sighting.
export function agentTransitions(
  prev: ReadonlyMap<string, AgentStatus>,
  sessions: readonly Session[],
): { next: Map<string, AgentStatus>; events: AgentEvent[] } {
  const next = new Map<string, AgentStatus>()
  const events: AgentEvent[] = []
  for (const s of sessions) {
    for (const p of s.panes ?? []) {
      const last = p.hasAgent ? prev.get(p.id) : undefined
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

export function notificationTitle(
  kind: AgentEventKind,
  t: Translate<MessageKey>,
): string {
  return t(
    kind === 'blocked' ? 'dialogs.notify.blocked' : 'dialogs.notify.done',
  )
}

// Names only: no screen or transcript text, and never the pane title, which
// whatever runs in the pane can set. The name the user gave the pane goes
// before the agent's, so two agents' panes read apart.
export function notificationContent(
  event: AgentEvent,
  sessions: readonly Session[],
  groups: readonly SessionGroup[],
  t: Translate<MessageKey>,
): NotificationContent {
  const tab = sessions.find((s) => s.id === event.tabId)
  const group = groups.find((g) => g.id === event.groupId)
  const paneName = tab?.panes?.find((p) => p.id === event.paneId)?.name
  const agent =
    cleanName(paneName) ||
    cleanName(event.agentName) ||
    t('dialogs.notify.agent')
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
    title: notificationTitle(event.kind, t),
    options: {
      body: place ? `${agent} · ${place}` : agent,
      tag: event.paneId,
      renotify: true,
      icon: '/pwa-192x192.png',
      badge: '/badge-96x96.png',
      data: { hash },
    },
  }
}
