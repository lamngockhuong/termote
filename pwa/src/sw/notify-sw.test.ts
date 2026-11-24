import { afterEach, describe, expect, it, vi } from 'vitest'
import badgeFixture from '../../../server/testdata/badge-snapshot.json'
import source from '../../public/notify-sw.js?raw'
import { LOCALES } from '../i18n'
import { tFor } from '../i18n/i18n-context'
import { cleanName, notificationContent } from '../utils/agent-notify'
import { OVERVIEW_PLAN_HASH } from '../utils/deep-link'
import {
  HIDDEN_URL,
  hiddenGroupIds,
  hiddenKey,
} from '../utils/hidden-workspaces'
import { LOCALE_CACHE, LOCALE_URL } from '../utils/notify-locale'
import { NOTIFY_WORKER_VERSION } from '../utils/notify-permission'

type Listener = (event: unknown) => void

// Runs public/notify-sw.js against a fake service worker scope and returns
// its listeners.
function loadWorker(windows: unknown[] = [], navigator?: unknown) {
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
    navigator,
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
    expect(port.postMessage).toHaveBeenCalledWith({
      version: NOTIFY_WORKER_VERSION,
    })
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
      machine: '',
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
      machine: '',
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

  it("opens a machine's pane on that machine", async () => {
    const machine = '0123456789abcdef'
    const { clients, dispatch } = loadWorker()
    await dispatch('notificationclick', click({ hash: '#/s/g/t/p', machine }))
    expect(clients.openWindow).toHaveBeenCalledWith(
      `/?machine=${machine}#/s/g/t/p`,
    )
    const win = windowClient()
    const open = loadWorker([win])
    await open.dispatch(
      'notificationclick',
      click({ hash: '#/s/g/t', machine }),
    )
    expect(win.postMessage).toHaveBeenCalledWith({
      type: 'termote-open',
      hash: '#/s/g/t',
      machine,
    })
    // Anything but a machine id is this server
    const bad = loadWorker()
    await bad.dispatch(
      'notificationclick',
      click({ hash: '#/s/g/t', machine: '../x' }),
    )
    expect(bad.clients.openWindow).toHaveBeenCalledWith('/#/s/g/t')
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

    describe('hidden workspaces', () => {
      // Cache Storage holding the page's list as text (undefined: none)
      const keepHidden = (text?: string) =>
        vi.stubGlobal('caches', {
          match: vi.fn(async (url: string, opts?: { cacheName: string }) =>
            url === HIDDEN_URL &&
            opts?.cacheName === LOCALE_CACHE &&
            text !== undefined
              ? new Response(text)
              : undefined,
          ),
        })
      const body = async (event: object = EVENT, snapshot = SNAPSHOT) => {
        const machine = (event as { machineId?: string }).machineId
        stubFetch({
          [machine
            ? `/api/machines/${machine}/mux/snapshot?peek=1`
            : '/api/mux/snapshot?peek=1']: { body: snapshot },
        })
        const { registration, dispatch } = loadWorker()
        await dispatch('push', pushData(event))
        return registration.showNotification.mock.calls[0][1].body
      }

      it('leaves a hidden workspace out as the page does', async () => {
        // Names the key is built from as is: spaces around, invisible and
        // bidi characters, longer than a name is shown
        for (const name of [' work ', 'wo​rk', 'wo‮rk⁦', `${'w'.repeat(70)} `]) {
          const snapshot = structuredClone(SNAPSHOT)
          snapshot.groups[0].name = name
          keepHidden(JSON.stringify([hiddenKey('', name)]))
          const shown = await body(EVENT, snapshot)
          const page = notificationContent(
            { ...EVENT, kind: 'blocked', agentName: 'claude⁦' },
            [{ id: '$1:2', name: ' build\u0007 ', icon: '', description: '' }],
            [{ id: '$1', name }],
            tFor('en'),
            new Set(['$1']),
          )
          expect(shown, name).toBe(page.options.body)
          expect(shown, name).toBe('claude · build')
        }
      })

      it("leaves out a hidden checkout's linked worktree", async () => {
        const snapshot = {
          groups: [
            { id: '$1', name: 'repo', tabs: [] },
            {
              id: '$5',
              name: 'repo-fix',
              worktree: { linked: true, parent: '$1' },
              tabs: [
                {
                  id: '$5:1',
                  name: 'edit',
                  panes: [{ id: '%9', agent: { name: 'claude' } }],
                },
              ],
            },
          ],
        }
        const event = {
          groupId: '$5',
          tabId: '$5:1',
          paneId: '%9',
          kind: 'done',
        }
        keepHidden(JSON.stringify([hiddenKey('', 'repo')]))
        const shown = await body(event, snapshot as typeof SNAPSHOT)
        const page = notificationContent(
          { ...event, kind: 'done', agentName: 'claude' },
          [{ id: '$5:1', name: 'edit', icon: '', description: '' }],
          [
            { id: '$1', name: 'repo' },
            {
              id: '$5',
              name: 'repo-fix',
              worktree: { linked: true, parent: '$1' },
            },
          ],
          tFor('en'),
          hiddenGroupIds(
            [
              { id: '$1', name: 'repo' },
              {
                id: '$5',
                name: 'repo-fix',
                worktree: { linked: true, parent: '$1' },
              },
            ],
            [hiddenKey('', 'repo')],
            '',
          ),
        )
        expect(shown).toBe(page.options.body)
        expect(shown).toBe('claude · edit')
        // Another checkout hidden: the worktree keeps its name
        keepHidden(JSON.stringify([hiddenKey('', 'other')]))
        expect(await body(event, snapshot as typeof SNAPSHOT)).toBe(
          'claude · repo-fix / edit',
        )
      })

      it("hides by the push's machine", async () => {
        const machine = '0123456789abcdef'
        keepHidden(JSON.stringify([hiddenKey(machine, 'wo‮rk')]))
        expect(await body({ ...EVENT, machineId: machine })).toBe(
          'claude · build',
        )
        // The same name on this server is not hidden
        expect(await body()).toBe('claude · work / build')
      })

      it('shows every name without a list, or when storage is refused', async () => {
        keepHidden(undefined)
        expect(await body()).toBe('claude · work / build')
        keepHidden(JSON.stringify([hiddenKey('', 'other')]))
        expect(await body()).toBe('claude · work / build')
        vi.stubGlobal('caches', {
          match: async () => {
            throw new Error('denied')
          },
        })
        expect(await body()).toBe('claude · work / build')
      })

      it('shows no workspace name when the list cannot be read', async () => {
        keepHidden('{oops')
        expect(await body()).toBe('claude · build')
        keepHidden('{"a":1}')
        expect(await body()).toBe('claude · build')
      })
    })

    it("reads a machine's names through this server", async () => {
      const machine = '0123456789abcdef'
      const calls = stubFetch({
        [`/api/machines/${machine}/mux/snapshot?peek=1`]: { body: SNAPSHOT },
      })
      const { registration, dispatch } = loadWorker()
      await dispatch('push', pushData({ ...EVENT, machineId: machine }))
      expect(calls[0].url).toBe(`/api/machines/${machine}/mux/snapshot?peek=1`)
      const [, options] = registration.showNotification.mock.calls[0]
      expect(options.tag).toBe(`${machine}/%3`)
      expect(options.data).toEqual({ hash: '#/s/%241/%241%3A2/%253', machine })
      expect(options.body).toBe('claude · work / build')
    })

    it('names the pane by the name the user gave it, cleaned', async () => {
      const snapshot = (name?: string) => ({
        groups: [
          {
            id: 'g',
            name: 'work',
            tabs: [
              {
                id: 't',
                name: 'build',
                panes: [{ id: 'p', name, agent: { name: 'claude' } }],
              },
            ],
          },
        ],
      })
      for (const [name, body] of [
        ['api\u202e', 'api · work / build'],
        ['tests', 'tests · work / build'],
        [undefined, 'claude · work / build'],
        ['\u200b', 'claude · work / build'],
      ] as const) {
        stubFetch({ '/api/mux/snapshot?peek=1': { body: snapshot(name) } })
        const { registration, dispatch } = loadWorker()
        await dispatch(
          'push',
          pushData({ groupId: 'g', tabId: 't', paneId: 'p', kind: 'done' }),
        )
        expect(registration.showNotification.mock.calls[0][1].body).toBe(body)
      }
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

// The Badging API of a worker's navigator, recording each call
function badgeNav(fail = false) {
  return {
    setAppBadge: vi.fn(async (_n: number) => {
      if (fail) throw new Error('refused')
    }),
    clearAppBadge: vi.fn(async () => {
      if (fail) throw new Error('refused')
    }),
  }
}

const SNAP_URL = '/api/mux/snapshot?peek=1'

describe('notify-sw.js app badge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('counts the snapshot as the page does, payload unchanged', async () => {
    stubFetch({ [SNAP_URL]: { body: badgeFixture.snapshot } })
    const nav = badgeNav()
    // A window open but hidden does not set it
    const { registration, dispatch } = loadWorker(
      [{ visibilityState: 'hidden' }],
      nav,
    )
    await dispatch('push', pushData(EVENT))
    expect(nav.setAppBadge).toHaveBeenCalledWith(badgeFixture.expected)
    expect(registration.showNotification).toHaveBeenCalledTimes(1)
  })

  it('clears it at 0 and when signed out or revoked', async () => {
    for (const route of [
      { body: { groups: [] } },
      { status: 401 },
      { status: 403 },
    ]) {
      stubFetch({ [SNAP_URL]: route })
      const nav = badgeNav()
      const { registration, dispatch } = loadWorker([], nav)
      await dispatch('push', pushData(EVENT))
      expect(nav.clearAppBadge).toHaveBeenCalledTimes(1)
      expect(nav.setAppBadge).not.toHaveBeenCalled()
      expect(registration.showNotification).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps the last count offline or on a failed read', async () => {
    const failed: Record<string, { status: number }>[] = [
      {},
      { [SNAP_URL]: { status: 500 } },
    ]
    for (const routes of failed) {
      stubFetch(routes)
      const nav = badgeNav()
      const { dispatch } = loadWorker([], nav)
      await dispatch('push', pushData(EVENT))
      expect(nav.setAppBadge).not.toHaveBeenCalled()
      expect(nav.clearAppBadge).not.toHaveBeenCalled()
    }
  })

  it('leaves it to a page on screen', async () => {
    stubFetch({ [SNAP_URL]: { body: SNAPSHOT } })
    const nav = badgeNav()
    const { dispatch } = loadWorker([{ visibilityState: 'visible' }], nav)
    await dispatch('push', pushData(EVENT))
    expect(nav.setAppBadge).not.toHaveBeenCalled()
    expect(nav.clearAppBadge).not.toHaveBeenCalled()
  })

  it('follows the setting, on when it cannot be read', async () => {
    stubFetch({ [SNAP_URL]: { body: SNAPSHOT } })
    for (const [kept, on] of [
      ['0', false],
      ['1', true],
      [null, true],
    ] as const) {
      const match = vi.fn(async (url: string, opts?: { cacheName: string }) =>
        url === '/__badge' && opts?.cacheName === 'termote-prefs' && kept
          ? new Response(kept)
          : undefined,
      )
      vi.stubGlobal('caches', { match })
      const nav = badgeNav()
      const { dispatch } = loadWorker([], nav)
      await dispatch('push', pushData(EVENT))
      if (on) expect(nav.setAppBadge).toHaveBeenCalledWith(1)
      else expect(nav.clearAppBadge).toHaveBeenCalled()
    }
    vi.stubGlobal('caches', {
      match: async () => {
        throw new Error('denied')
      },
    })
    const nav = badgeNav()
    const { dispatch } = loadWorker([], nav)
    await dispatch('push', pushData(EVENT))
    expect(nav.setAppBadge).toHaveBeenCalledWith(1)
  })

  it('still notifies without the API, or when it is refused', async () => {
    stubFetch({ [SNAP_URL]: { body: SNAPSHOT } })
    for (const nav of [undefined, {}, badgeNav(true)]) {
      const { registration, dispatch } = loadWorker([], nav)
      await dispatch('push', pushData(EVENT))
      expect(registration.showNotification).toHaveBeenCalledTimes(1)
    }
  })

  it('reads nothing for a malformed push', async () => {
    const calls = stubFetch({ [SNAP_URL]: { body: SNAPSHOT } })
    const nav = badgeNav()
    const { dispatch } = loadWorker([], nav)
    await dispatch('push', pushData('not json'))
    expect(calls).toHaveLength(0)
    expect(nav.setAppBadge).not.toHaveBeenCalled()
  })
})

describe('notify-sw.js settings proposals', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const keep = (locale?: string) =>
    vi.stubGlobal('caches', {
      match: vi.fn(async () =>
        locale === undefined ? undefined : new Response(locale),
      ),
    })

  it.each(LOCALES)(
    'shows a settings push in %s, with no value and no snapshot read',
    async (locale) => {
      keep(locale)
      const calls = stubFetch({})
      const { registration, dispatch } = loadWorker()
      await dispatch('push', pushData({ kind: 'settings' }))
      expect(registration.showNotification).toHaveBeenCalledWith(
        tFor(locale)('dialogs.notify.settings'),
        {
          tag: 'termote-settings',
          renotify: true,
          icon: '/pwa-192x192.png',
          badge: '/badge-96x96.png',
          data: { settings: true },
        },
      )
      expect(calls).toEqual([])
    },
  )

  it("opens this server's page, never a machine's", async () => {
    const machine = {
      url: 'https://h/?machine=0123456789abcdef',
      focus: vi.fn(),
    }
    const broken = { url: 'not a url', focus: vi.fn() }
    const own = {
      url: 'https://h/#/s/g/t',
      focus: vi.fn().mockRejectedValue(new Error('not allowed')),
    }
    const w = loadWorker([machine, broken, own])
    await w.dispatch('notificationclick', click({ settings: true }))
    expect(own.focus).toHaveBeenCalled()
    expect(machine.focus).not.toHaveBeenCalled()
    expect(w.clients.openWindow).not.toHaveBeenCalled()

    const none = loadWorker([machine])
    await none.dispatch('notificationclick', click({ settings: true }))
    expect(none.clients.openWindow).toHaveBeenCalledWith('/')
  })
})

describe('notify-sw.js job reviews', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const JOBS_URL = '/api/mux/jobs?all=1'
  const ID = '0123456789abcdef'
  const keep = (locale?: string) =>
    vi.stubGlobal('caches', {
      match: vi.fn(async () =>
        locale === undefined ? undefined : new Response(locale),
      ),
      open: vi.fn(async () => ({ put: vi.fn() })),
    })
  const options = (body: string) => ({
    body,
    tag: `termote-job-${ID}`,
    renotify: true,
    icon: '/pwa-192x192.png',
    badge: '/badge-96x96.png',
    data: { job: ID },
  })

  it.each(LOCALES)(
    "shows the job's title in %s, read with the device's credentials",
    async (locale) => {
      keep(locale)
      const calls = stubFetch({
        [JOBS_URL]: {
          body: {
            jobs: [
              { id: 'ffffffffffffffff', title: 'other' },
              { id: ID, title: ' Fix\u202e the login\u0007 ' },
            ],
          },
        },
      })
      const { registration, dispatch } = loadWorker()
      await dispatch('push', pushData({ kind: 'job_review', jobId: ID }))
      expect(registration.showNotification).toHaveBeenCalledWith(
        tFor(locale)('dialogs.notify.jobReview'),
        options('Fix the login'),
      )
      expect(calls).toHaveLength(1)
      expect(calls[0].init?.credentials).toBe('same-origin')
    },
  )

  it.each(LOCALES)(
    'says a job waits in %s when its title cannot be read',
    async (locale) => {
      keep(locale)
      const t = tFor(locale)
      const fallback = options(t('dialogs.notify.jobFallback'))
      const routes: Record<string, { status?: number; body?: unknown }>[] = [
        {},
        { [JOBS_URL]: { status: 403 } },
        { [JOBS_URL]: { body: { jobs: 'none' } } },
        { [JOBS_URL]: { body: { jobs: [null, { id: ID }] } } },
        { [JOBS_URL]: { body: { jobs: [] } } },
      ]
      for (const r of routes) {
        stubFetch(r)
        const { registration, dispatch } = loadWorker()
        await dispatch('push', pushData({ kind: 'job_review', jobId: ID }))
        expect(registration.showNotification).toHaveBeenCalledWith(
          t('dialogs.notify.jobReview'),
          fallback,
        )
      }
    },
  )

  it.each(LOCALES)(
    "says in %s that a job's checks failed, or that it merged",
    async (locale) => {
      keep(locale)
      const t = tFor(locale)
      for (const [kind, head] of [
        ['job_ci_failed', t('dialogs.notify.jobCIFailed')],
        ['job_merged', t('dialogs.notify.jobMerged')],
      ]) {
        stubFetch({
          [JOBS_URL]: { body: { jobs: [{ id: ID, title: 'Fix' }] } },
        })
        let w = loadWorker()
        await w.dispatch('push', pushData({ kind, jobId: ID }))
        expect(w.registration.showNotification).toHaveBeenCalledWith(
          head,
          options('Fix'),
        )
        stubFetch({})
        w = loadWorker()
        await w.dispatch('push', pushData({ kind, jobId: ID }))
        expect(w.registration.showNotification).toHaveBeenCalledWith(
          head,
          options(t('dialogs.notify.jobOther')),
        )
      }
    },
  )

  it("takes no id but the server's, and reads nothing for one", async () => {
    keep('en')
    const calls = stubFetch({})
    for (const jobId of ['../x', 'ABCDEF0123456789', 7, '']) {
      const { registration, dispatch } = loadWorker()
      await dispatch('push', pushData({ kind: 'job_review', jobId }))
      expect(registration.showNotification).toHaveBeenCalledWith('Termote', {
        body: tFor('en')('dialogs.notify.fallback'),
        icon: '/pwa-192x192.png',
        badge: '/badge-96x96.png',
      })
    }
    expect(calls).toEqual([])
  })

  it("opens the overview's Plan", async () => {
    keep('en')
    expect(OVERVIEW_PLAN_HASH).toBe('#/overview?plan=1')
    const win = windowClient()
    const open = loadWorker([win])
    await open.dispatch('notificationclick', click({ job: ID }))
    expect(win.postMessage).toHaveBeenCalledWith({
      type: 'termote-open',
      hash: OVERVIEW_PLAN_HASH,
      machine: '',
    })

    const none = loadWorker()
    await none.dispatch('notificationclick', click({ job: ID }))
    expect(none.clients.openWindow).toHaveBeenCalledWith(
      `/${OVERVIEW_PLAN_HASH}`,
    )
  })
})
