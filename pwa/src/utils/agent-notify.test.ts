import { describe, expect, it } from 'vitest'
import fixtureJson from '../../../server/testdata/agent-transitions.json?raw'
import { type AgentStatus, type Session, toAgentStatus } from '../types/session'
import {
  type AgentEvent,
  agentTransitions,
  cleanName,
  type NotifyContext,
  notificationContent,
  shouldNotify,
} from './agent-notify'

interface Fixture {
  cases: {
    name: string
    steps: Record<string, string | null>[]
    events: { paneId: string; kind: string }[][]
  }[]
}

// One tab per pane, as the server's snapshot would list them; "unknown" and
// null arrive as an agent with no status, as from the snapshot; "none" is a
// pane with no agent.
function sessionsOf(step: Record<string, string | null>): Session[] {
  return Object.entries(step).map(([paneId, status]) => ({
    id: `t-${paneId}`,
    name: paneId,
    icon: '',
    description: '',
    groupId: 'g',
    panes: [
      {
        id: paneId,
        label: paneId,
        hasAgent: status !== 'none',
        agentName: status === 'none' ? undefined : 'claude',
        agentStatus: toAgentStatus(status ?? undefined),
      },
    ],
  }))
}

describe('agentTransitions (shared fixture)', () => {
  const fixture: Fixture = JSON.parse(fixtureJson)
  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    let prev = new Map<string, AgentStatus>()
    c.steps.forEach((step, i) => {
      const { next, events } = agentTransitions(prev, sessionsOf(step))
      const got = events
        .map((e) => ({ paneId: e.paneId, kind: e.kind }))
        .sort((a, b) => a.paneId.localeCompare(b.paneId))
      expect(got, `step ${i}`).toEqual(c.events[i])
      prev = next
    })
  })

  it('describes the event with its tab, group and agent', () => {
    const prev = new Map<string, AgentStatus>([['p1', 'working']])
    const { events } = agentTransitions(prev, [
      {
        id: 't1',
        name: 'tab',
        icon: '',
        description: '',
        groupId: 'g1',
        panes: [
          {
            id: 'p1',
            label: '',
            hasAgent: true,
            agentName: 'codex',
            agentStatus: 'blocked',
          },
        ],
      },
      // A tab without panes (the first-load fallback) is skipped.
      { id: '0', name: 'shell', icon: '', description: '' },
    ])
    expect(events).toEqual([
      {
        kind: 'blocked',
        groupId: 'g1',
        tabId: 't1',
        paneId: 'p1',
        agentName: 'codex',
      },
    ])
  })
})

describe('shouldNotify', () => {
  const event: AgentEvent = { kind: 'blocked', tabId: 't', paneId: 'p1' }
  const ctx: NotifyContext = {
    enabled: true,
    permission: 'granted',
    pushActive: false,
    visible: true,
    focused: true,
    activePaneId: 'p2',
  }

  it('notifies for a pane the user is not looking at', () => {
    expect(shouldNotify(event, ctx)).toBe(true)
  })

  it('stays quiet when off, without permission or with push', () => {
    expect(shouldNotify(event, { ...ctx, enabled: false })).toBe(false)
    expect(shouldNotify(event, { ...ctx, permission: 'default' })).toBe(false)
    expect(shouldNotify(event, { ...ctx, permission: 'denied' })).toBe(false)
    expect(shouldNotify(event, { ...ctx, permission: 'unsupported' })).toBe(
      false,
    )
    expect(shouldNotify(event, { ...ctx, pushActive: true })).toBe(false)
  })

  it('skips the visible, focused pane only', () => {
    const onPane = { ...ctx, activePaneId: 'p1' }
    expect(shouldNotify(event, onPane)).toBe(false)
    expect(shouldNotify(event, { ...onPane, visible: false })).toBe(true)
    expect(shouldNotify(event, { ...onPane, focused: false })).toBe(true)
  })
})

describe('cleanName', () => {
  it('strips control and bidi characters, trims and truncates', () => {
    expect(cleanName(' a\u0007b\u009bc‮d⁦e‏f ')).toBe('abcdef')
    expect(cleanName('x'.repeat(80))).toHaveLength(64)
    // Characters, not UTF-16 units: an emoji is never cut in half.
    expect(cleanName('😀'.repeat(70))).toBe('😀'.repeat(64))
    expect(cleanName(undefined)).toBe('')
  })

  it('strips zero-width spaces, which could also disguise a name', () => {
    expect(cleanName('a\u200bdm\u2060i\ufeffn')).toBe('admin')
    // A joined emoji stays one
    expect(cleanName('dev 👩\u200d💻')).toBe('dev 👩\u200d💻')
  })
})

describe('notificationContent', () => {
  const sessions: Session[] = [
    { id: '$1:2', name: 'build‮', icon: '', description: '' },
  ]
  const groups = [{ id: '$1', name: 'work' }]

  it('names the agent, group and tab and links to the pane', () => {
    const c = notificationContent(
      {
        kind: 'blocked',
        groupId: '$1',
        tabId: '$1:2',
        paneId: '%3',
        agentName: 'claude',
      },
      sessions,
      groups,
    )
    expect(c).toEqual({
      title: 'Agent needs you',
      options: {
        body: 'claude · work / build',
        tag: '%3',
        renotify: true,
        icon: '/pwa-192x192.png',
        badge: '/badge-96x96.png',
        data: { hash: '#/s/%241/%241%3A2/%253' },
      },
    })
  })

  it('falls back to generic text without names or a group', () => {
    const c = notificationContent(
      { kind: 'done', tabId: 'gone', paneId: 'p' },
      sessions,
      groups,
    )
    expect(c.title).toBe('Agent finished')
    expect(c.options.body).toBe('Agent')
    expect(c.options.data.hash).toBe('')
  })
})
