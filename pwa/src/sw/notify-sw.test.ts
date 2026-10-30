import { afterEach, describe, expect, it, vi } from 'vitest'
import source from '../../public/notify-sw.js?raw'
import { LOCALES } from '../i18n'
import { tFor } from '../i18n/i18n-context'
import { cleanName, notificationContent } from '../utils/agent-notify'
import { LOCALE_CACHE, LOCALE_URL } from '../utils/notify-locale'

type Listener = (event: unknown) => void

// Runs public/notify-sw.js against a fake service worker scope and returns
// its listeners.
function loadWorker(windows: unknown[] = []) {
  const listeners = new Map<string, Listener>()
  const clients = {
    matchAll: vi.fn().mockResolvedValue(windows),
    openWindow: vi.fn().mockResolvedValue(null),
  }
  const newSub = {
    toJSON: () => ({
      endpoint: 'https://e/new',
      keys: { p256dh: 'P', auth: 'A' },
      expirationTime: null,
    }),
  }
  const registration = {
    showNotification: vi.fn().mockResolvedValue(undefined),
    pushManager: { subscribe: vi.fn().mockResolvedValue(newSub) },
  }
  const self = {
    clients,
    registration,
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
  }
  new Function('self', source)(self)
  const dispatch = async (type: string, event: object) => {
    let done: Promise<unknown> = Promise.resolve()
    listeners.get(type)?.({
      ...event,
      waitUntil: (p: Promise<unknown>) => {
        done = p
      },
    })
    await done
  }
  return { clients, registration, dispatch }
}

// A push event's data, as PushMessageData.json() reads it.
function pushData(body: unknown) {
  return {
    data: {
      json: () => {
        if (typeof body === 'string') return JSON.parse(body)
        return body
      },
    },
  }
}

// fetch answering each URL with its JSON (or status), recording calls.
function stubFetch(
  routes: Record<string, { status?: number; body?: unknown }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const r = routes[url]
      if (!r) throw new TypeError('offline')
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
      })
    }),
  )
  return calls
}

const EVENT = { groupId: '$1', tabId: '$1:2', paneId: '%3', kind: 'blocked' }
const SNAPSHOT = {
  groups: [
    {
      id: '$1',
      name: 'wo\u202erk',
      tabs: [
        {
          id: '$1:2',
          name: ' build\u0007 ',
          panes: [
            { id: '%3', agent: { name: 'claude\u2066', status: 'blocked' } },
          ],
        },
      ],
    },
  ],
}

function windowClient(focus = vi.fn().mockResolvedValue(undefined)) {
  return { postMessage: vi.fn(), focus }
}

function click(data: unknown) {
  return { notification: { close: vi.fn(), data } }
}

describe('notify-sw.js', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('answers the ping with its version', async () => {
    const { dispatch } = loadWorker()
    const port = { postMessage: vi.fn() }
    await dispatch('message', {
      data: { type: 'termote-notify-ping' },
      ports: [port],
    })
    expect(port.postMessage).toHaveBeenCalledWith({ version: 2 })
    await dispatch('message', { data: { type: 'SKIP_WAITING' }, ports: [port] })
    await dispatch('message', { data: null, ports: [] })
    await dispatch('message', {
      data: { type: 'termote-notify-ping' },
      ports: [],
    })
    expect(port.postMessage).toHaveBeenCalledTimes(1)
  })

  it('focuses an open window and sends it the link', async () => {
    const win = windowClient()
    const { clients, dispatch } = loadWorker([win])
    const event = click({ hash: '#/s/g/t/p' })
    await dispatch('notificationclick', event)
    expect(event.notification.close).toHaveBeenCalled()
    expect(win.postMessage).toHaveBeenCalledWith({
      type: 'termote-open',
      hash: '#/s/g/t/p',
    })
    expect(win.focus).toHaveBeenCalled()
    expect(clients.openWindow).not.toHaveBeenCalled()
  })

  it('still sends the link when focus is refused', async () => {
    const win = windowClient(vi.fn().mockRejectedValue(new Error('denied')))
    const { dispatch } = loadWorker([win])
    await dispatch('notificationclick', click({ hash: '#/s/g/t' }))
    expect(win.postMessage).toHaveBeenCalled()
  })

  it('keeps the link for a page its message never reaches', async () => {
    const kept = new Map<string, Response>()
    const open = vi.fn(async () => ({
      put: async (url: string, res: Response) => kept.set(url, res),
    }))
    vi.stubGlobal('caches', { open })
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const win = windowClient()
    const { dispatch } = loadWorker([win])
    await dispatch('notificationclick', click({ hash: '#/s/g/t/p' }))
    expect(open).toHaveBeenCalledWith('termote-notify')
    expect(await kept.get('/__termote/pending-link')?.json()).toEqual({
      hash: '#/s/g/t/p',
      at: 1000,
    })
    expect(win.postMessage).toHaveBeenCalled()
    // Nothing kept for anything but a pane link
    open.mockClear()
    await dispatch('notificationclick', click({ hash: 'https://evil.test' }))
    expect(open).not.toHaveBeenCalled()
  })

  it('never holds focus or a new window on keeping the link', async () => {
    let release = () => {}
    const put = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('caches', {
      open: () =>
        new Promise((r) => {
          release = () => r({ put })
        }),
    })
    const win = windowClient()
    const open = loadWorker([win])
    const clicked = open.dispatch(
      'notificationclick',
      click({ hash: '#/s/g/t' }),
    )
    await vi.waitFor(() => expect(win.focus).toHaveBeenCalled())
    // The message waits: the page that takes it drops the kept copy
    expect(win.postMessage).not.toHaveBeenCalled()
    release()
    await clicked
    expect(put).toHaveBeenCalled()
    expect(win.postMessage).toHaveBeenCalled()

    const closed = loadWorker()
    const opening = closed.dispatch(
      'notificationclick',
      click({ hash: '#/s/g/t' }),
    )
    await vi.waitFor(() =>
      expect(closed.clients.openWindow).toHaveBeenCalledWith('/#/s/g/t'),
    )
    release()
    await opening
  })

  it('still sends the link when it cannot be kept', async () => {
    vi.stubGlobal('caches', {
      open: () => Promise.reject(new Error('quota')),
    })
    const win = windowClient()
    const { dispatch } = loadWorker([win])
    await dispatch('notificationclick', click({ hash: '#/s/g/t/p' }))
    expect(win.postMessage).toHaveBeenCalled()
  })

  it('opens the app on the link when no window is open', async () => {
    const { clients, dispatch } = loadWorker()
    await dispatch('notificationclick', click({ hash: '#/s/g/t/p' }))
    expect(clients.openWindow).toHaveBeenCalledWith('/#/s/g/t/p')
  })

  it('never follows anything but a pane link', async () => {
    const win = windowClient()
    const { dispatch } = loadWorker([win])
    await dispatch('notificationclick', click({ hash: 'https://evil.test' }))
    await dispatch('notificationclick', click(undefined))
    expect(win.postMessage).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalledTimes(2)
    const empty = loadWorker()
    await empty.dispatch('notificationclick', click({ hash: 42 }))
    expect(empty.clients.openWindow).toHaveBeenCalledWith('/')
  })

  describe('push', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('shows the pane with names cleaned as the page cleans them', async () => {
      const calls = stubFetch({
        '/api/mux/snapshot?peek=1': { body: SNAPSHOT },
      })
      const { registration, dispatch } = loadWorker()
      await dispatch('push', pushData(EVENT))
      // The page's notification for the same event, from the same names.
      const page = notificationContent(
        { ...EVENT, kind: 'blocked', agentName: 'claude\u2066' },
        [{ id: '$1:2', name: ' build\u0007 ', icon: '', description: '' }],
        [{ id: '$1', name: 'wo\u202erk' }],
        tFor('en'),
      )
      expect(registration.showNotification).toHaveBeenCalledTimes(1)
      expect(registration.showNotification).toHaveBeenCalledWith(
        page.title,
        page.options,
      )
      expect(page.options.body).toBe('claude · work / build')
      expect(calls[0].init?.credentials).toBe('same-origin')
      expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
    })

    it('cleans names exactly as cleanName does', async () => {
      const vector = [
        'a\u0000b\u001fc\u007fd\u0085e\u009ff',
        '\u200eleft\u200f \u202aemb\u202b\u202c\u202d\u202e',
        '\u2066iso\u2067\u2068\u2069\u061c',
        'zero\u200bwidth\u2060\ufeff 👩\u200d💻 \u200c',
        'soft\u00ad\u2028sep\u2029\u2061\u180e\u115f\u3164\uffa0\ufffa\u{e0041}\u{e007f}',
        `  ${'😀'.repeat(70)}  `,
        'plain name',
      ]
      for (const name of vector) {
        stubFetch({
          '/api/mux/snapshot?peek=1': {
            body: {
              groups: [
                {
                  id: 'g',
                  name,
                  tabs: [{ id: 't', name: 'x', panes: [{ id: 'p' }] }],
                },
              ],
            },
          },
        })
        const { registration, dispatch } = loadWorker()
        await dispatch(
          'push',
          pushData({ groupId: 'g', tabId: 't', paneId: 'p', kind: 'done' }),
        )
        const [title, options] = registration.showNotification.mock.calls[0]
        expect(title).toBe('Agent finished')
        expect(options.body).toBe(
          [cleanName(name), 'x']
            .filter(Boolean)
            .join(' / ')
            .replace(/^/, 'Agent · '),
        )
      }
    })

    it('falls back to no names when the snapshot cannot be read', async () => {
      for (const [routes, body] of [
        // Offline, signed out: no names at all
        [{}, undefined],
        [{ '/api/mux/snapshot?peek=1': { status: 401 } }, undefined],
        // The pane is gone from the snapshot: the agent's generic name
        [{ '/api/mux/snapshot?peek=1': { body: {} } }, 'Agent'],
      ] as const) {
        stubFetch(routes)
        const { registration, dispatch } = loadWorker()
        await dispatch('push', pushData({ ...EVENT, kind: 'done' }))
        expect(registration.showNotification).toHaveBeenCalledTimes(1)
        const [title, options] = registration.showNotification.mock.calls[0]
        expect(title).toBe('Agent finished')
        expect(options).toMatchObject({
          tag: '%3',
          renotify: true,
          data: { hash: '#/s/%241/%241%3A2/%253' },
        })
        expect(options.body).toBe(body)
      }
    })

    it('shows a generic notification for anything malformed', async () => {
      stubFetch({ '/api/mux/snapshot?peek=1': { body: SNAPSHOT } })
      for (const data of [
        pushData('not json'),
        pushData(null),
        pushData({ ...EVENT, kind: 'other' }),
        pushData({ ...EVENT, kind: 'toString' }),
        pushData({ ...EVENT, paneId: 3 }),
        pushData({ ...EVENT, groupId: '' }),
        { data: null },
      ]) {
        const { registration, dispatch } = loadWorker()
        await dispatch('push', data)
        expect(registration.showNotification).toHaveBeenCalledTimes(1)
        expect(registration.showNotification).toHaveBeenCalledWith('Termote', {
          body: 'An agent may need you',
          icon: '/pwa-192x192.png',
          badge: '/badge-96x96.png',
        })
      }
    })

    describe("in the app's language", () => {
      // Cache Storage as the page leaves it: the locale kept, or nothing
      const keep = (locale?: string) => {
        const match = vi.fn(
          async (url: string, opts?: MultiCacheQueryOptions) =>
            locale !== undefined &&
            url === LOCALE_URL &&
            opts?.cacheName === LOCALE_CACHE
              ? new Response(locale)
              : undefined,
        )
        vi.stubGlobal('caches', { match })
        return match
      }
      // What the worker shows for an event with names, for one without, and
      // for a malformed push
      const shown = async () => {
        const words = []
        for (const [routes, data] of [
          [{ '/api/mux/snapshot?peek=1': { body: SNAPSHOT } }, EVENT],
          [
            { '/api/mux/snapshot?peek=1': { body: {} } },
            { ...EVENT, kind: 'done' },
          ],
          [{}, 'not json'],
        ] as const) {
          stubFetch(routes)
          const { registration, dispatch } = loadWorker()
          await dispatch('push', pushData(data))
          const [title, options] = registration.showNotification.mock.calls[0]
          words.push([title, options.body])
        }
        return words
      }

      it.each(LOCALES)(
        'words a push in %s, as the page words its own',
        async (locale) => {
          keep(locale)
          const t = tFor(locale)
          expect(await shown()).toEqual([
            [t('dialogs.notify.blocked'), 'claude · work / build'],
            [t('dialogs.notify.done'), t('dialogs.notify.agent')],
            ['Termote', t('dialogs.notify.fallback')],
          ])
        },
      )

      it('speaks Vietnamese when the page kept vi', async () => {
        const match = keep('vi')
        expect(await shown()).toEqual([
          ['Agent cần bạn', 'claude · work / build'],
          ['Agent đã xong', 'Agent'],
          ['Termote', 'Có thể một agent đang cần bạn'],
        ])
        expect(match).toHaveBeenCalledWith('/__locale', {
          cacheName: 'termote-prefs',
        })
      })

      it('speaks English when no language was kept, or it cannot be read', async () => {
        const english = [
          ['Agent needs you', 'claude · work / build'],
          ['Agent finished', 'Agent'],
          ['Termote', 'An agent may need you'],
        ]
        keep()
        expect(await shown()).toEqual(english)
        // One this worker does not speak, or a name of the object's own
        keep('fr')
        expect(await shown()).toEqual(english)
        keep('toString')
        expect(await shown()).toEqual(english)
        vi.stubGlobal('caches', {
          match: vi.fn().mockRejectedValue(new Error('denied')),
        })
        expect(await shown()).toEqual(english)
        vi.stubGlobal('caches', undefined)
        expect(await shown()).toEqual(english)
      })
    })
  })

  describe('pushsubscriptionchange', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('forgets the old subscription and posts a new one', async () => {
      const calls = stubFetch({
        '/api/mux/push/subscribe': { body: { ok: true } },
        '/api/mux/push/key': { body: { publicKey: 'AQID' } },
      })
      const { registration, dispatch } = loadWorker()
      await dispatch('pushsubscriptionchange', {
        oldSubscription: { endpoint: 'https://e/old' },
      })
      expect(registration.pushManager.subscribe).toHaveBeenCalledWith({
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array([1, 2, 3]),
      })
      expect(calls.map((c) => [c.url, c.init?.method, c.init?.body])).toEqual([
        [
          '/api/mux/push/subscribe',
          'DELETE',
          JSON.stringify({ endpoint: 'https://e/old' }),
        ],
        ['/api/mux/push/key', undefined, undefined],
        [
          '/api/mux/push/subscribe',
          'POST',
          JSON.stringify({
            endpoint: 'https://e/new',
            keys: { p256dh: 'P', auth: 'A' },
          }),
        ],
      ])
      expect(calls[2].init?.headers).toEqual({
        'Content-Type': 'application/json',
      })
    })

    it('leaves a failure to the page', async () => {
      // No old subscription, the key unavailable
      let calls = stubFetch({ '/api/mux/push/key': { status: 503 } })
      let w = loadWorker()
      await w.dispatch('pushsubscriptionchange', {})
      expect(w.registration.pushManager.subscribe).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
      // Offline: the delete and the key read both fail
      calls = stubFetch({})
      w = loadWorker()
      await w.dispatch('pushsubscriptionchange', {
        oldSubscription: { endpoint: 'https://e/old' },
      })
      expect(calls).toHaveLength(2)
      // A key with characters base64url maps
      stubFetch({ '/api/mux/push/key': { body: { publicKey: '-_8' } } })
      w = loadWorker()
      await w.dispatch('pushsubscriptionchange', { oldSubscription: null })
      expect(
        w.registration.pushManager.subscribe.mock.calls[0][0]
          .applicationServerKey,
      ).toEqual(new Uint8Array([251, 255]))
    })
  })
})
