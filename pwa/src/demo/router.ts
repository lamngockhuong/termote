import { type Handler, unsupported } from './http'
import { AGENT_ROUTES, advanceTurns } from './routes-agent'
import { FILES_ROUTES } from './routes-files'
import { MUX_ROUTES } from './routes-mux'
import { STORE_ROUTES } from './routes-store'
import type { DemoState } from './state'

// The demo's /api/mux: "METHOD /path" to its handler, {name} matching one
// path segment. Every route the PWA can call is here; one that is not is a
// bug the demo reports (console.error, which fails the demo's E2E spec).

// What the demo cannot offer: sign-in, pairing, push and image uploads. The
// snapshot's caps hide them; a call that comes anyway is told so.
const REFUSED: Record<string, Handler> = {
  'POST /logout': unsupported,
  'GET /push/key': unsupported,
  'POST /push/subscribe': unsupported,
  'DELETE /push/subscribe': unsupported,
  'GET /devices': unsupported,
  'POST /devices/pair': unsupported,
  'DELETE /devices/{id}': unsupported,
  'GET /signins': unsupported,
  'DELETE /signins': unsupported,
  'DELETE /signins/{id}': unsupported,
  'POST /uploads': unsupported,
  'POST /worktrees': unsupported,
  'POST /worktrees/open': unsupported,
  'DELETE /worktrees/{id}': unsupported,
}

export const ROUTES: Record<string, Handler> = {
  ...MUX_ROUTES,
  ...AGENT_ROUTES,
  ...FILES_ROUTES,
  ...STORE_ROUTES,
  ...REFUSED,
}

interface Route {
  method: string
  segments: string[]
  params: number
  handler: Handler
}

// Literal segments win over {name} ones: /templates/import before
// /templates/{id}
const TABLE: Route[] = Object.entries(ROUTES)
  .map(([key, handler]) => {
    const [method, path] = key.split(' ')
    const segments = path.split('/').slice(1)
    const params = segments.filter((s) => s.startsWith('{')).length
    return { method, segments, params, handler }
  })
  .sort((a, b) => a.params - b.params)

function match(
  method: string,
  path: string,
): { handler: Handler; params: Record<string, string> } | null {
  const parts = path.split('/').slice(1)
  for (const route of TABLE) {
    if (route.method !== method || route.segments.length !== parts.length)
      continue
    const params: Record<string, string> = {}
    const fits = route.segments.every((seg, i) => {
      if (!seg.startsWith('{')) return seg === parts[i]
      if (!parts[i]) return false
      try {
        params[seg.slice(1, -1)] = decodeURIComponent(parts[i])
      } catch {
        // A malformed escape names nothing
        return false
      }
      return true
    })
    if (fits) return { handler: route.handler, params }
  }
  return null
}

export const API_PREFIX = '/api/mux'

// Answers one request to /api/mux/*; url is absolute
export async function route(
  state: DemoState,
  method: string,
  url: URL,
  body: unknown,
): Promise<Response> {
  const path = url.pathname.slice(API_PREFIX.length)
  const found = match(method, path)
  if (!found) {
    console.error('demo: unhandled', method, path)
    return new Response(JSON.stringify({ error: 'not in the demo' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  let parsed: unknown
  if (typeof body === 'string' && body !== '') {
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
    }
  }
  advanceTurns(state)
  return found.handler({
    method,
    path,
    params: found.params,
    query: url.searchParams,
    body: parsed,
    state,
  })
}
