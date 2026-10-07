import { describe, expect, it, vi } from 'vitest'
import source from '../../public/notify-sw.js?raw'

type Listener = (event: unknown) => void

// Runs public/notify-sw.js against a fake service worker scope and returns
// its listeners.
function loadWorker(windows: unknown[] = []) {
  const listeners = new Map<string, Listener>()
  const clients = {
    matchAll: vi.fn().mockResolvedValue(windows),
    openWindow: vi.fn().mockResolvedValue(null),
  }
  const self = {
    clients,
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
  return { clients, dispatch }
}

function windowClient(focus = vi.fn().mockResolvedValue(undefined)) {
  return { postMessage: vi.fn(), focus }
}

function click(data: unknown) {
  return { notification: { close: vi.fn(), data } }
}

describe('notify-sw.js', () => {
  it('answers the ping with its version', async () => {
    const { dispatch } = loadWorker()
    const port = { postMessage: vi.fn() }
    await dispatch('message', {
      data: { type: 'termote-notify-ping' },
      ports: [port],
    })
    expect(port.postMessage).toHaveBeenCalledWith({ version: 1 })
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
})
