// Links that open one session (and pane, and view) directly:
//   #/s/<group>/<tab>[/<pane>][?view=<view>]
// group, tab and pane are the ids of /api/mux/snapshot, each URI-encoded. The
// hash never reaches the server, so a link needs no route and stays out of
// its logs. A link only selects: it never sends keys or creates or closes tabs.

export interface DeepLink {
  group: string
  tab: string
  pane?: string
  view?: string
}

const PREFIX = '#/s/'

// The link in a location.hash, or null when it is not a well-formed one.
export function parseDeepLink(hash: string): DeepLink | null {
  if (!hash.startsWith(PREFIX)) return null
  const rest = hash.slice(PREFIX.length)
  const q = rest.indexOf('?')
  const path = (q === -1 ? rest : rest.slice(0, q)).replace(/\/$/, '')
  const query = q === -1 ? '' : rest.slice(q + 1)
  const raw = path.split('/')
  if (raw.length < 2 || raw.length > 3) return null
  let parts: string[]
  try {
    parts = raw.map(decodeURIComponent)
  } catch {
    return null
  }
  // An empty or dot segment is never an id; refuse it rather than guess.
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  const [group, tab, pane] = parts
  const view = new URLSearchParams(query).get('view') || undefined
  return {
    group,
    tab,
    ...(pane !== undefined && { pane }),
    ...(view && { view }),
  }
}

// The hash for a link; the terminal view is the default and is left out.
export function formatDeepLink({ group, tab, pane, view }: DeepLink): string {
  const path = [group, tab, ...(pane ? [pane] : [])]
    .map(encodeURIComponent)
    .join('/')
  const query =
    view && view !== 'terminal' ? `?view=${encodeURIComponent(view)}` : ''
  return `${PREFIX}${path}${query}`
}
