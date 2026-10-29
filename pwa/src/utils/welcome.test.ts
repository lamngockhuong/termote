import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import {
  buildWelcomeFacts,
  navigationType,
  openedOnLink,
  shouldShowWelcome,
  WELCOME_VERSION,
  type WelcomeInput,
  waitingAgents,
} from './welcome'

const tab = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  name: id,
  icon: '',
  description: '',
  ...extra,
})

const base: WelcomeInput = {
  sessions: [tab('a')],
  readOnly: false,
  notify: 'on',
  install: null,
  desktop: false,
}

describe('waitingAgents', () => {
  it('lists each blocked pane with its agent and tab', () => {
    const sessions = [
      tab('api', {
        panes: [
          {
            id: 'p1',
            label: 'claude',
            hasAgent: true,
            agentName: 'claude',
            agentStatus: 'blocked',
          },
          { id: 'p2', label: 'codex', hasAgent: true, agentStatus: 'blocked' },
          { id: 'p3', label: 'logs', hasAgent: false, agentStatus: 'working' },
        ],
      }),
    ]
    expect(waitingAgents(sessions)).toEqual([
      { sessionId: 'api', paneId: 'p1', agent: 'claude', tab: 'api' },
      { sessionId: 'api', paneId: 'p2', agent: 'codex', tab: 'api' },
    ])
  })

  it('reads a tab without panes by its own status', () => {
    expect(
      waitingAgents([
        tab('t', { agentStatus: 'blocked', agentName: 'claude', paneId: '%1' }),
        tab('u', { agentStatus: 'blocked' }),
        tab('v', { agentStatus: 'idle' }),
      ]),
    ).toEqual([
      { sessionId: 't', paneId: '%1', agent: 'claude', tab: 't' },
      { sessionId: 'u', paneId: undefined, agent: 'u', tab: 'u' },
    ])
  })
})

describe('buildWelcomeFacts', () => {
  it('counts sessions and panes, a tab without panes as one', () => {
    const facts = buildWelcomeFacts({
      ...base,
      sessions: [
        tab('a', {
          panes: [
            { id: '1', label: '', hasAgent: false },
            { id: '2', label: '', hasAgent: false },
          ],
        }),
        tab('b'),
        tab('c', { panes: [] }),
      ],
    })
    expect(facts).toMatchObject({
      sessions: 3,
      panes: 4,
      next: [],
      primary: 'terminal',
    })
  })

  it('a new install: start a session, then turn on notifications', () => {
    const facts = buildWelcomeFacts({
      ...base,
      sessions: [],
      notify: 'off',
      install: 'prompt',
    })
    expect(facts.next).toEqual([{ kind: 'start' }, { kind: 'notify' }])
    expect(facts.primary).toBe('terminal')
  })

  it('an agent waiting comes first and opens its pane', () => {
    const waiting = tab('w', { agentStatus: 'blocked' })
    const facts = buildWelcomeFacts({
      ...base,
      sessions: [waiting],
      notify: 'off',
    })
    expect(facts.next.map((a) => a.kind)).toEqual(['waiting', 'notify'])
    expect(facts.primary).toBe('waiting')
  })

  it('a view-only device is never asked to start a session or turn on notifications', () => {
    const facts = buildWelcomeFacts({
      ...base,
      sessions: [],
      readOnly: true,
      notify: 'off',
      install: 'ios',
    })
    expect(facts.next).toEqual([{ kind: 'install', how: 'ios' }])
  })

  it('offers no notifications where the browser has none', () => {
    expect(buildWelcomeFacts({ ...base, notify: 'unsupported' }).next).toEqual(
      [],
    )
  })

  it('desktop with no paired device offers pairing', () => {
    expect(
      buildWelcomeFacts({ ...base, desktop: true, pairedDevices: 0 }).next,
    ).toEqual([{ kind: 'pair' }])
    expect(
      buildWelcomeFacts({ ...base, desktop: true, pairedDevices: 2 }).next,
    ).toEqual([])
    expect(buildWelcomeFacts({ ...base, desktop: true }).next).toEqual([])
    expect(buildWelcomeFacts({ ...base, pairedDevices: 0 }).next).toEqual([])
  })

  it('keeps at most two actions', () => {
    const facts = buildWelcomeFacts({
      ...base,
      sessions: [],
      notify: 'off',
      install: 'prompt',
      desktop: true,
      pairedDevices: 0,
    })
    expect(facts.next).toHaveLength(2)
  })
})

describe('shouldShowWelcome', () => {
  it('shows until this version was seen', () => {
    expect(shouldShowWelcome(0)).toBe(true)
    expect(shouldShowWelcome(WELCOME_VERSION)).toBe(false)
    expect(shouldShowWelcome(WELCOME_VERSION + 1)).toBe(false)
  })
})

describe('openedOnLink', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a link opened anew counts; a reload of the page keeping its pane does not', () => {
    expect(openedOnLink(true, 'navigate')).toBe(true)
    expect(openedOnLink(true, undefined)).toBe(true)
    expect(openedOnLink(true, 'reload')).toBe(false)
    expect(openedOnLink(false, 'navigate')).toBe(false)
  })

  it('reads how the page was loaded', () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'reload' } as PerformanceNavigationTiming,
    ])
    expect(navigationType()).toBe('reload')
    expect(openedOnLink(true)).toBe(false)
  })

  it('knows nothing where the browser keeps no navigation entry', () => {
    const get = performance.getEntriesByType
    Object.defineProperty(performance, 'getEntriesByType', {
      value: undefined,
      configurable: true,
    })
    try {
      expect(navigationType()).toBeUndefined()
    } finally {
      Object.defineProperty(performance, 'getEntriesByType', {
        value: get,
        configurable: true,
      })
    }
  })
})
