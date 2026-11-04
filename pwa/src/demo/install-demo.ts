import { installFakeWebSocket } from './fake-stream'
import { API_PREFIX, route } from './router'
import { createState, type DemoState } from './state'

export { DemoShell } from './demo-banner'

// The demo layer, loaded only by the demo build (main.tsx): the app's
// /api/mux requests and its terminal stream are answered here, in the
// browser, from fixtures (./fixtures) and an in-memory state.

// Found in the demo build only: CI fails the release build that holds it
export const DEMO_MARKER = 'termote-demo-mode'

// A server's answer is not instant: the app's loading states show briefly
export const LATENCY_MS = 60

async function bodyText(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<unknown> {
  if (input instanceof Request) return input.text()
  return init?.body
}

// Wraps fetch so a request to /api/mux/* (on this page's origin) goes to
// the router, after the latency, and any other goes to the network
export function installFakeFetch(
  state: DemoState,
  win: Window & typeof globalThis = window,
) {
  const native = win.fetch.bind(win)
  win.fetch = async (input, init) => {
    const href =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input
    const url = new URL(href, win.location.href)
    if (
      url.origin !== win.location.origin ||
      !url.pathname.startsWith(`${API_PREFIX}/`)
    )
      return native(input, init)
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase()
    const body = await bodyText(input, init)
    await new Promise((r) => setTimeout(r, LATENCY_MS))
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : null)
    signal?.throwIfAborted()
    return route(state, method, url, body)
  }
}

export function installDemo(
  win: Window & typeof globalThis = window,
): DemoState {
  const state = createState()
  win.document.documentElement.dataset.demo = DEMO_MARKER
  installFakeFetch(state, win)
  installFakeWebSocket(state, win)
  return state
}
