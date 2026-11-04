import type { DemoState } from './state'

// One request the demo's router answers, as a route handler sees it
export interface DemoRequest {
  method: string
  // The path under /api/mux: /panes/w1%3Ap1/files/tree
  path: string
  // The route's {name} segments, decoded
  params: Record<string, string>
  query: URLSearchParams
  // The JSON body, when there is one
  body: any
  state: DemoState
}

export type Handler = (req: DemoRequest) => Response | Promise<Response>

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const noContent = () => new Response(null, { status: 204 })

// A refusal as the server words it: {error, code} and what the route adds
export function fail(
  status: number,
  code: string,
  error: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error, code, ...extra }, status)
}

// What the demo cannot do (pairing, push, uploads, a real download): the
// PWA tells it as "Not supported here"
export const unsupported: Handler = () =>
  fail(501, 'unsupported', 'not available in the demo')
