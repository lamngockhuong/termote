// Links that open one session (and pane, and view) directly:
//   #/s/<group>/<tab>[/<pane>][?view=<view>][&solo=1][&file=<path>[&staged=1][&orig=<path>][&place=<id>]]
// group, tab and pane are the ids of /api/mux/snapshot, each URI-encoded. The
// hash never reaches the server, so a link needs no route and stays out of
// its logs. A link only selects: it never sends keys or creates or closes tabs.
//
// solo=1 opens the link in a focus window, which shows only its target and
// keeps nothing on the device. file is a path under the pane's root, shown in
// the Files view, or its diff in the Changes view (staged and orig pick the
// side). place names the Place a Files path is under (its id), absent for
// the pane's folder. The server still opens it under the root; the path
// here is only a hint, and one that could never name a file under a root is
// refused.

export interface DeepLink {
  group: string
  tab: string
  pane?: string
  view?: string
  solo?: true
  file?: string
  // A diff's side: the staged one, and a rename's or copy's source
  staged?: true
  orig?: string
  // The Place a Files path is under (files/places id)
  place?: string
  // The link named a file that cannot be one (absolute, or leaving the root)
  badFile?: true
}

const PREFIX = '#/s/'

// The views a file names a target in
const FILE_VIEWS = new Set(['files', 'changes'])
// What a Place id can be: the server's are 16 hex digits
const PLACE_ID = /^[A-Za-z0-9_-]{1,64}$/

// path when it can name a file under a root, else null: relative, no empty,
// dot or dot-dot segment, no NUL, no drive or backslash.
function cleanFilePath(path: string): string | null {
  if (path === '' || path.includes('\0') || path.includes('\\')) return null
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null
  const parts = path.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  return path
}

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
  let params: URLSearchParams
  try {
    parts = raw.map(decodeURIComponent)
    params = new URLSearchParams(query)
  } catch {
    return null
  }
  // An empty or dot segment is never an id; refuse it rather than guess.
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  const [group, tab, pane] = parts
  const view = params.get('view') || undefined
  const solo = params.get('solo') === '1'
  const target = fileTarget(params, view)
  return {
    group,
    tab,
    ...(pane !== undefined && { pane }),
    ...(view && { view }),
    ...(solo && { solo: true as const }),
    ...target,
  }
}

// The file a link's query names for view: a file in Files, a diff's side in
// Changes, nothing in any other view.
function fileTarget(
  params: URLSearchParams,
  view: string | undefined,
): Pick<DeepLink, 'file' | 'staged' | 'orig' | 'place' | 'badFile'> {
  const raw = params.get('file')
  if (raw === null || !view || !FILE_VIEWS.has(view)) return {}
  const file = cleanFilePath(raw)
  if (!file) return { badFile: true }
  if (view !== 'changes') {
    const place = params.get('place')
    if (place && !PLACE_ID.test(place)) return { badFile: true }
    return { file, ...(place && { place }) }
  }
  const rawOrig = params.get('orig')
  const orig = rawOrig === null ? null : cleanFilePath(rawOrig)
  if (rawOrig !== null && !orig) return { badFile: true }
  return {
    file,
    ...(params.get('staged') === '1' && { staged: true as const }),
    ...(orig && { orig }),
  }
}

// The hash for a link; the terminal view is the default and is left out.
export function formatDeepLink({
  group,
  tab,
  pane,
  view,
  solo,
  file,
  staged,
  orig,
  place,
}: DeepLink): string {
  const path = [group, tab, ...(pane ? [pane] : [])]
    .map(encodeURIComponent)
    .join('/')
  const params: string[] = []
  if (view && view !== 'terminal')
    params.push(`view=${encodeURIComponent(view)}`)
  if (solo) params.push('solo=1')
  if (file && view && FILE_VIEWS.has(view)) {
    params.push(`file=${encodeURIComponent(file)}`)
    if (view === 'changes') {
      if (staged) params.push('staged=1')
      if (orig) params.push(`orig=${encodeURIComponent(orig)}`)
    } else if (place) params.push(`place=${encodeURIComponent(place)}`)
  }
  const query = params.length ? `?${params.join('&')}` : ''
  return `${PREFIX}${path}${query}`
}

// Screens that are no pane's: the overview of every agent.
export type Screen = 'overview'

export const OVERVIEW_HASH = '#/overview'

// The hash part before its query, without a trailing slash
function hashPath(hash: string): string {
  const q = hash.indexOf('?')
  return (q === -1 ? hash : hash.slice(0, q)).replace(/\/$/, '')
}

// The screen a location.hash names, or null for a pane (or nothing).
export function parseScreenLink(hash: string): Screen | null {
  return hashPath(hash) === OVERVIEW_HASH ? 'overview' : null
}

// The hash for the overview, in a focus window when solo.
export function formatOverviewLink({ solo }: { solo?: boolean } = {}): string {
  return solo ? `${OVERVIEW_HASH}?solo=1` : OVERVIEW_HASH
}

// Whether a location.hash (a pane's link or the overview's) asks for a focus
// window.
export function parseSolo(hash: string): boolean {
  if (parseScreenLink(hash)) {
    const q = hash.indexOf('?')
    return (
      q !== -1 && new URLSearchParams(hash.slice(q + 1)).get('solo') === '1'
    )
  }
  return parseDeepLink(hash)?.solo === true
}
