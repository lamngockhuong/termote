import { describe, expect, it } from 'vitest'
import type { Session } from '../types/session'
import { agentCards, groupByStatus } from './agent-cards'

describe('agentCards', () => {
  it('takes the panes running an agent with their tab, in order', () => {
    const sessions: Session[] = [
      {
        id: 't1',
        name: 'api',
        icon: '',
        description: '',
        panes: [
          { id: 'p1', label: 'shell', hasAgent: false },
          {
            id: 'p2',
            label: 'claude',
            hasAgent: true,
            agentStatus: 'working',
            agentSince: '2026-11-05T00:00:00Z',
          },
        ],
      },
      { id: 't2', name: 'web', icon: '', description: '' },
      {
        id: 't3',
        name: 'docs',
        icon: '',
        description: '',
        panes: [{ id: 'p3', label: 'codex', hasAgent: true }],
      },
    ]
    const cards = agentCards(sessions)
    expect(cards.map((c) => [c.session.id, c.pane.id])).toEqual([
      ['t1', 'p2'],
      ['t3', 'p3'],
    ])
    expect(cards[0]).toMatchObject({
      status: 'working',
      since: '2026-11-05T00:00:00Z',
    })
  })
})

describe('groupByStatus', () => {
  it('groups by status, heaviest first, empty statuses left out', () => {
    const cards = [
      { id: 'a', status: 'idle' as const },
      { id: 'b', status: 'blocked' as const },
      { id: 'c' },
      { id: 'd', status: 'blocked' as const },
      { id: 'e', status: 'done' as const },
    ]
    expect(
      groupByStatus(cards).map(([s, list]) => [s, list.map((c) => c.id)]),
    ).toEqual([
      ['blocked', ['b', 'd']],
      ['done', ['e']],
      ['idle', ['a', 'c']],
    ])
  })

  it('is empty without cards', () => {
    expect(groupByStatus([])).toEqual([])
  })
})
