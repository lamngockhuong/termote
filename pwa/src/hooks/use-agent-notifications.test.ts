import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, Session } from '../types/session'
import { remapPanes } from '../utils/pane-remap'
import {
  PENDING_LINK_MAX_AGE_MS,
  useAgentNotifications,
} from './use-agent-notifications'

// Cache Storage holding what public/notify-sw.js keeps for a click.
function fakeCaches() {
  const store = new Map<string, Map<string, string>>()
  const open = async (name: string) => {
    if (!store.has(name)) store.set(name, new Map())
    const c = store.get(name)!
    return {
      put: async (url: string, res: Response) => {
        c.set(url, await res.text())
      },
      delete: async (url: string) => c.delete(url),
    }
  }
  const match = async (url: string, opts?: { cacheName?: string }) => {
    const body = store.get(opts?.cacheName ?? '')?.get(url)
    return body === undefined ? undefined : new Response(body)
  }
  const keep = (hash: unknown, at = Date.now()) =>
    open('termote-notify').then((c) =>
      c.put(
        '/__termote/pending-link',
        new Response(JSON.stringify({ hash, at })),
      ),
    )
  const kept = () =>
    store.get('termote-notify')?.has('/__termote/pending-link') ?? false
  return { api: { open, match }, keep, kept }
}

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

  describe('a link the worker kept (iOS drops its message)', () => {
    let caches: ReturnType<typeof fakeCaches>
    let visibility: DocumentVisibilityState

    beforeEach(() => {
      caches = fakeCaches()
      vi.stubGlobal('caches', caches.api)
      visibility = 'visible'
      vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
        () => visibility,
      )
    })

    const show = () =>
      act(async () => {
        visibility = 'visible'
        document.dispatchEvent(new Event('visibilitychange'))
      })

    it('opens it once the page shows again, and only once', async () => {
      setup({})
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      await caches.keep('#/s/g/t-p2/p2')
      await show()
      await waitFor(() => expect(window.location.hash).toBe('#/s/g/t-p2/p2'))
      expect(caches.kept()).toBe(false)
      window.location.hash = '#/s/g/t-p1/p1'
      await show()
      expect(window.location.hash).toBe('#/s/g/t-p1/p1')
    })

    it('takes one the worker keeps only after the page shows', async () => {
      setup({})
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      await show()
      await new Promise((r) => setTimeout(r, 100))
      await caches.keep('#/s/g/t-p2/p2')
      await waitFor(() => expect(window.location.hash).toBe('#/s/g/t-p2/p2'), {
        timeout: 2000,
      })
    })

    it('never takes one kept before the page was last hidden', async () => {
      setup({})
      await caches.keep('#/s/g/t-p2/p2', Date.now() - 10)
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      await show()
      await waitFor(() => expect(caches.kept()).toBe(false))
      expect(window.location.hash).toBe('')
    })

    it('stops looking once hidden or unmounted', async () => {
      const { unmount } = setup({})
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      await caches.keep('#/s/g/t-p2/p2')
      await new Promise((r) => setTimeout(r, 400))
      expect(window.location.hash).toBe('')
      unmount()
      await show()
      expect(caches.kept()).toBe(true)
    })

    it('opens one kept before the page loaded', async () => {
      await caches.keep('#/s/g/t-p2/p2')
      setup({})
      await waitFor(() => expect(window.location.hash).toBe('#/s/g/t-p2/p2'))
    })

    it('drops one the message already delivered', async () => {
      setup({})
      await caches.keep('#/s/g/t-p2/p2')
      act(() => {
        swTarget.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'termote-open', hash: '#/s/g/t-p2/p2' },
          }),
        )
      })
      await waitFor(() => expect(caches.kept()).toBe(false))
      window.location.hash = '#/s/g/t-p1/p1'
      await show()
      expect(window.location.hash).toBe('#/s/g/t-p1/p1')
    })

    it('ignores a stale, future or malformed one', async () => {
      setup({})
      for (const [hash, at] of [
        ['#/s/g/t-p2/p2', Date.now() - PENDING_LINK_MAX_AGE_MS - 1000],
        ['#/s/g/t-p2/p2', Date.now() + 5000],
        ['javascript:alert(1)', Date.now()],
        [42, Date.now()],
      ] as const) {
        await caches.keep(hash, at)
        await show()
        await waitFor(() => expect(caches.kept()).toBe(false))
        expect(window.location.hash).toBe('')
      }
      const match = vi.fn().mockRejectedValue(new Error('denied'))
      vi.stubGlobal('caches', { match })
      await show()
      await waitFor(() => expect(match).toHaveBeenCalled())
      await act(async () => {})
      expect(window.location.hash).toBe('')
    })

    it('does nothing without Cache Storage', async () => {
      vi.stubGlobal('caches', undefined)
      setup({})
      await show()
      expect(window.location.hash).toBe('')
    })
  })

  it('does nothing without a service worker', () => {
    Reflect.deleteProperty(navigator, 'serviceWorker')
    const { unmount } = setup({})
    unmount()
  })
})
