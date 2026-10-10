import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, Session } from '../types/session'
import { remapPanes } from '../utils/pane-remap'
import { useAgentNotifications } from './use-agent-notifications'

function sessionsWith(statuses: Record<string, AgentStatus>): Session[] {
  return Object.entries(statuses).map(([paneId, agentStatus]) => ({
    id: `t-${paneId}`,
    name: `tab-${paneId}`,
    icon: '',
    description: '',
    groupId: 'g',
    panes: [
      {
        id: paneId,
        label: '',
        hasAgent: true,
        agentName: 'claude',
        agentStatus,
      },
    ],
  }))
}

const groups = [{ id: 'g', name: 'main' }]

describe('useAgentNotifications', () => {
  let showNotification: ReturnType<typeof vi.fn>
  let swTarget: EventTarget

  beforeEach(() => {
    showNotification = vi.fn().mockResolvedValue(undefined)
    swTarget = new EventTarget()
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: Object.assign(swTarget, {
        ready: Promise.resolve({ showNotification }),
      }),
    })
    vi.stubGlobal('Notification', { permission: 'granted' })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'serviceWorker')
    window.location.hash = ''
  })

  function setup(
    initial: Partial<Parameters<typeof useAgentNotifications>[0]>,
  ) {
    const props = {
      sessions: sessionsWith({ p1: 'working', p2: 'working' }),
      groups,
      activePaneId: 'p1',
      enabled: true,
      pushActive: false,
      ...initial,
    }
    const hook = renderHook((p) => useAgentNotifications(p), {
      initialProps: props,
    })
    return {
      ...hook,
      next: (statuses: Record<string, AgentStatus>, more = {}) =>
        hook.rerender({ ...props, ...more, sessions: sessionsWith(statuses) }),
    }
  }

  it('notifies once per transition, never for the focused pane', async () => {
    const { next } = setup({})
    next({ p1: 'blocked', p2: 'blocked' })
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
    expect(showNotification).toHaveBeenCalledWith('Agent needs you', {
      body: 'claude · main / tab-p2',
      tag: 'p2',
      renotify: true,
      icon: '/pwa-192x192.png',
      badge: '/badge-96x96.png',
      data: { hash: '#/s/g/t-p2/p2' },
    })
    next({ p1: 'blocked', p2: 'blocked' })
    next({ p1: 'blocked', p2: 'done' })
    await Promise.resolve()
    expect(showNotification).toHaveBeenCalledTimes(1)
  })

  it('a status follows its pane when a move shifts the ids', async () => {
    const { next } = setup({
      sessions: sessionsWith({ p1: 'idle', p2: 'working' }),
    })
    // p2's pane is p1 now, and p1's is p2: no turn ended
    remapPanes({
      moved: new Map([
        ['p1', 'p2'],
        ['p2', 'p1'],
      ]),
      stale: new Set(['p1', 'p2']),
    })
    next({ p1: 'working', p2: 'idle' })
    await Promise.resolve()
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('notifies for the active pane when the page is hidden', async () => {
    const { next } = setup({})
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    next({ p1: 'done', p2: 'working' })
    await waitFor(() =>
      expect(showNotification).toHaveBeenCalledWith(
        'Agent finished',
        expect.objectContaining({ tag: 'p1' }),
      ),
    )
  })

  it('stays quiet when off, with push, or without permission', async () => {
    const { next } = setup({ enabled: false })
    next({ p1: 'working', p2: 'blocked' })
    next({ p1: 'working', p2: 'working' }, { enabled: true, pushActive: true })
    next({ p1: 'working', p2: 'blocked' }, { enabled: true, pushActive: true })
    vi.stubGlobal('Notification', { permission: 'denied' })
    next({ p1: 'blocked', p2: 'blocked' }, { enabled: true })
    await Promise.resolve()
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('ignores a notification the browser refuses', async () => {
    showNotification.mockRejectedValue(new TypeError('no permission'))
    const { next } = setup({})
    next({ p1: 'working', p2: 'blocked' })
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
  })

  it('ignores a failing service worker', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: Object.assign(new EventTarget(), {
        ready: Promise.reject(new Error('no worker')),
      }),
    })
    const { next } = setup({})
    next({ p1: 'working', p2: 'blocked' })
    await Promise.resolve()
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('opens the pane a notification click sends back', () => {
    setup({})
    const send = (data: unknown) =>
      act(() => {
        swTarget.dispatchEvent(new MessageEvent('message', { data }))
      })
    send({ type: 'termote-open', hash: '#/s/g/t-p2/p2' })
    expect(window.location.hash).toBe('#/s/g/t-p2/p2')
    send({ type: 'termote-open', hash: 'javascript:alert(1)' })
    send({ type: 'other', hash: '#/s/g/t-p1' })
    send(null)
    expect(window.location.hash).toBe('#/s/g/t-p2/p2')
  })

  it('does nothing without a service worker', () => {
    Reflect.deleteProperty(navigator, 'serviceWorker')
    const { unmount } = setup({})
    unmount()
  })
})
