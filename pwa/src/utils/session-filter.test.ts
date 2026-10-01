import { describe, expect, it } from 'vitest'
import type { Session } from '../types/session'
import {
  blockedFirst,
  DEFAULT_SIDEBAR_FILTER,
  effectiveFilter,
  matchesFilter,
  resolveSidebarFilter,
  summarizeSessions,
} from './session-filter'

describe('resolveSidebarFilter', () => {
  it('returns the filter if it is valid', () => {
    expect(resolveSidebarFilter('all')).toBe('all')
    expect(resolveSidebarFilter('needs-you')).toBe('needs-you')
    expect(resolveSidebarFilter('working')).toBe('working')
    expect(resolveSidebarFilter('agents')).toBe('agents')
  })

  it('returns default for unknown filter', () => {
    expect(resolveSidebarFilter('invalid')).toBe(DEFAULT_SIDEBAR_FILTER)
    expect(resolveSidebarFilter('unknown')).toBe(DEFAULT_SIDEBAR_FILTER)
  })

  it('returns default for null and undefined', () => {
    expect(resolveSidebarFilter(null)).toBe(DEFAULT_SIDEBAR_FILTER)
    expect(resolveSidebarFilter(undefined)).toBe(DEFAULT_SIDEBAR_FILTER)
  })

  it('returns default for number and other types', () => {
    expect(resolveSidebarFilter(123)).toBe(DEFAULT_SIDEBAR_FILTER)
    expect(resolveSidebarFilter(true)).toBe(DEFAULT_SIDEBAR_FILTER)
    expect(resolveSidebarFilter({})).toBe(DEFAULT_SIDEBAR_FILTER)
  })
})

describe('matchesFilter', () => {
  const blockedSession: Session = {
    id: '1',
    name: 'Blocked',
    icon: '🔴',
    description: '',
    panes: [
      { id: 'p1', label: 'pane1', hasAgent: true, agentStatus: 'blocked' },
    ],
  }

  const workingSession: Session = {
    id: '2',
    name: 'Working',
    icon: '🟡',
    description: '',
    panes: [
      { id: 'p2', label: 'pane2', hasAgent: true, agentStatus: 'working' },
    ],
  }

  const doneSession: Session = {
    id: '3',
    name: 'Done',
    icon: '🟢',
    description: '',
    panes: [{ id: 'p3', label: 'pane3', hasAgent: false, agentStatus: 'done' }],
  }

  const idleSession: Session = {
    id: '4',
    name: 'Idle',
    icon: '⚪',
    description: '',
    panes: [
      { id: 'p4', label: 'pane4', hasAgent: false, agentStatus: undefined },
    ],
  }

  const sessionWithoutAgent: Session = {
    id: '5',
    name: 'No agent',
    icon: '💻',
    description: '',
    hasAgent: false,
  }

  const sessionWithAgent: Session = {
    id: '6',
    name: 'Has agent',
    icon: '🤖',
    description: '',
    hasAgent: true,
  }

  const mixedPanesSession: Session = {
    id: '7',
    name: 'Mixed',
    icon: '🔀',
    description: '',
    panes: [
      { id: 'p7a', label: 'pane7a', hasAgent: true, agentStatus: 'blocked' },
      { id: 'p7b', label: 'pane7b', hasAgent: true, agentStatus: 'working' },
    ],
  }

  it("includes session with 'blocked' pane in 'needs-you'", () => {
    expect(matchesFilter(blockedSession, 'needs-you')).toBe(true)
  })

  it("excludes session without 'blocked' pane from 'needs-you'", () => {
    expect(matchesFilter(workingSession, 'needs-you')).toBe(false)
    expect(matchesFilter(doneSession, 'needs-you')).toBe(false)
    expect(matchesFilter(idleSession, 'needs-you')).toBe(false)
  })

  it("includes session with 'working' pane in 'working' filter", () => {
    expect(matchesFilter(workingSession, 'working')).toBe(true)
  })

  it("excludes session without 'working' pane from 'working' filter", () => {
    expect(matchesFilter(blockedSession, 'working')).toBe(false)
    expect(matchesFilter(doneSession, 'working')).toBe(false)
  })

  it("includes sessions with hasAgent in 'agents'", () => {
    expect(matchesFilter(sessionWithAgent, 'agents')).toBe(true)
  })

  it("excludes session without any agent from 'agents'", () => {
    expect(matchesFilter(sessionWithoutAgent, 'agents')).toBe(false)
  })

  it("includes all sessions in 'all' filter", () => {
    expect(matchesFilter(blockedSession, 'all')).toBe(true)
    expect(matchesFilter(workingSession, 'all')).toBe(true)
    expect(matchesFilter(doneSession, 'all')).toBe(true)
    expect(matchesFilter(sessionWithoutAgent, 'all')).toBe(true)
  })

  it('matches multiple statuses per session (mixed panes)', () => {
    expect(matchesFilter(mixedPanesSession, 'needs-you')).toBe(true)
    expect(matchesFilter(mixedPanesSession, 'working')).toBe(true)
  })

  it('handles session without panes (uses agentStatus)', () => {
    const s: Session = {
      id: '9',
      name: 'No panes',
      icon: '💻',
      description: '',
      agentStatus: 'blocked',
    }
    expect(matchesFilter(s, 'needs-you')).toBe(true)
    expect(matchesFilter(s, 'working')).toBe(false)
  })

  it('includes session with pane hasAgent in agents filter', () => {
    const s: Session = {
      id: '10',
      name: 'Pane agent',
      icon: '🤖',
      description: '',
      panes: [{ id: 'p10', label: 'pane10', hasAgent: true }],
    }
    expect(matchesFilter(s, 'agents')).toBe(true)
  })
})

describe('summarizeSessions', () => {
  it('returns zero counts for empty list', () => {
    const summary = summarizeSessions([])
    expect(summary.blocked).toBe(0)
    expect(summary.working).toBe(0)
    expect(summary.agents).toBe(0)
  })

  it('counts blocked, working, and agent sessions', () => {
    const sessions: Session[] = [
      {
        id: '1',
        name: 'Blocked',
        icon: '🔴',
        description: '',
        panes: [
          { id: 'p1', label: 'p1', hasAgent: true, agentStatus: 'blocked' },
        ],
      },
      {
        id: '2',
        name: 'Working',
        icon: '🟡',
        description: '',
        panes: [
          { id: 'p2', label: 'p2', hasAgent: true, agentStatus: 'working' },
        ],
      },
      { id: '3', name: 'Agent', icon: '🤖', description: '', hasAgent: true },
      {
        id: '4',
        name: 'Idle',
        icon: '⚪',
        description: '',
        panes: [{ id: 'p4', label: 'p4', hasAgent: false }],
      },
    ]
    const summary = summarizeSessions(sessions)
    expect(summary.blocked).toBe(1)
    expect(summary.working).toBe(1)
    expect(summary.agents).toBe(3) // blocked, working, and the one with hasAgent
  })

  it('counts sessions, not panes', () => {
    const sessions: Session[] = [
      {
        id: '1',
        name: 'Multiple',
        icon: '🔀',
        description: '',
        panes: [
          { id: 'p1a', label: 'p1a', hasAgent: true, agentStatus: 'blocked' },
          { id: 'p1b', label: 'p1b', hasAgent: true, agentStatus: 'blocked' },
        ],
      },
    ]
    const summary = summarizeSessions(sessions)
    expect(summary.blocked).toBe(1) // one session, not two
  })

  it('includes a session in multiple counts if it matches multiple filters', () => {
    const sessions: Session[] = [
      {
        id: '1',
        name: 'Mixed',
        icon: '🔀',
        description: '',
        hasAgent: true,
        panes: [
          { id: 'p1a', label: 'p1a', hasAgent: true, agentStatus: 'blocked' },
          { id: 'p1b', label: 'p1b', hasAgent: true, agentStatus: 'working' },
        ],
      },
    ]
    const summary = summarizeSessions(sessions)
    expect(summary.blocked).toBe(1)
    expect(summary.working).toBe(1)
    expect(summary.agents).toBe(1)
  })
})

describe('effectiveFilter', () => {
  const blockedSession: Session = {
    id: '1',
    name: 'Blocked',
    icon: '🔴',
    description: '',
    panes: [
      { id: 'p1', label: 'pane1', hasAgent: true, agentStatus: 'blocked' },
    ],
  }

  const noAgentSession: Session = {
    id: '2',
    name: 'No agent',
    icon: '💻',
    description: '',
    hasAgent: false,
  }

  it('returns the filter when some session has an agent', () => {
    const sessions: Session[] = [blockedSession, noAgentSession]
    expect(effectiveFilter(sessions, 'needs-you')).toBe('needs-you')
    expect(effectiveFilter(sessions, 'working')).toBe('working')
    expect(effectiveFilter(sessions, 'agents')).toBe('agents')
  })

  it("returns 'all' when no session has an agent", () => {
    const sessions: Session[] = [noAgentSession]
    expect(effectiveFilter(sessions, 'needs-you')).toBe('all')
    expect(effectiveFilter(sessions, 'working')).toBe('all')
    expect(effectiveFilter(sessions, 'agents')).toBe('all')
  })

  it("returns 'all' for empty list", () => {
    expect(effectiveFilter([], 'needs-you')).toBe('all')
  })

  it("returns 'all' unchanged when filter is already 'all'", () => {
    const sessions: Session[] = [blockedSession]
    expect(effectiveFilter(sessions, 'all')).toBe('all')
  })
})

describe('blockedFirst', () => {
  const blocked1: Session = {
    id: '1',
    name: 'Blocked 1',
    icon: '🔴',
    description: '',
    panes: [{ id: 'p1', label: 'p1', hasAgent: true, agentStatus: 'blocked' }],
  }
  const blocked2: Session = {
    id: '2',
    name: 'Blocked 2',
    icon: '🔴',
    description: '',
    panes: [{ id: 'p2', label: 'p2', hasAgent: true, agentStatus: 'blocked' }],
  }
  const working: Session = {
    id: '3',
    name: 'Working',
    icon: '🟡',
    description: '',
    panes: [{ id: 'p3', label: 'p3', hasAgent: true, agentStatus: 'working' }],
  }
  const idle: Session = {
    id: '4',
    name: 'Idle',
    icon: '⚪',
    description: '',
    panes: [{ id: 'p4', label: 'p4', hasAgent: false }],
  }

  it('returns sessions unchanged when no blocked sessions', () => {
    const sessions: Session[] = [working, idle]
    const result = blockedFirst(sessions)
    expect(result).toEqual([working, idle])
  })

  it('puts blocked sessions first', () => {
    const sessions: Session[] = [working, blocked1, idle, blocked2]
    const result = blockedFirst(sessions)
    expect(result[0]).toEqual(blocked1)
    expect(result[1]).toEqual(blocked2)
    expect(result[2]).toEqual(working)
    expect(result[3]).toEqual(idle)
  })

  it('preserves order of blocked sessions', () => {
    const sessions: Session[] = [blocked2, blocked1]
    const result = blockedFirst(sessions)
    expect(result[0]).toEqual(blocked2)
    expect(result[1]).toEqual(blocked1)
  })

  it('preserves order of non-blocked sessions', () => {
    const sessions: Session[] = [idle, working, blocked1]
    const result = blockedFirst(sessions)
    expect(result[0]).toEqual(blocked1)
    expect(result[1]).toEqual(idle)
    expect(result[2]).toEqual(working)
  })

  it('handles empty list', () => {
    const result = blockedFirst([])
    expect(result).toEqual([])
  })

  it('handles single session', () => {
    expect(blockedFirst([blocked1])).toEqual([blocked1])
    expect(blockedFirst([working])).toEqual([working])
  })
})
