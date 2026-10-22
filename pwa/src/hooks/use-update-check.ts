import { useSyncExternalStore } from 'react'

// The releases list, not releases/latest: `termote update` and the installer
// pick from it (server/release_tags.go), and releases/latest can name a 0.x.
const GITHUB_RELEASES =
  'https://api.github.com/repos/lamngockhuong/termote/releases?per_page=30'
const CACHE_KEY = 'termote-update-check'
const CACHE_DURATION = 60 * 60 * 1000 // 1 hour
// After a failed ask (offline, rate limited), the app being shown again does
// not ask before this
export const RETRY_GAP = 10 * 60 * 1000

const STABLE_TAG = /^v\d+\.\d+\.\d+$/

// The newest stable release on GitHub. Whether it is an update is decided
// against the server's version at each read, never cached: the server may
// have been updated since (to that very release).
export interface LatestRelease {
  version: string
  url: string
  checkedAt: number
}

interface Release {
  tag_name: string
  html_url: string
  draft?: boolean
  prerelease?: boolean
}

function parse(v: string): { core: number[]; pre: boolean } {
  const [core, pre] = v.replace(/^v/, '').split('-', 2)
  return {
    core: core.split('.').map((n) => Number(n) || 0),
    pre: pre !== undefined,
  }
}

// -1 if a < b, 0 if equal, 1 if a > b. A pre-release comes before its
// version (1.2.0-rc.1 < 1.2.0); two pre-releases of one version are equal.
export function compareVersions(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (pa.pre !== pb.pre) return pa.pre ? -1 : 1
  return 0
}

// The highest stable release at or above 1.0.0, as `termote update` picks.
export function newestStable(releases: Release[]): Release | null {
  let best: Release | null = null
  for (const r of releases) {
    if (r.draft || r.prerelease || !STABLE_TAG.test(r.tag_name)) continue
    if (compareVersions(r.tag_name, '1.0.0') < 0) continue
    if (!best || compareVersions(r.tag_name, best.tag_name) > 0) best = r
  }
  return best
}

// The newest version when it is above the running one, else null.
export function availableUpdate(
  running: string,
  latest: LatestRelease | null,
): string | null {
  return latest && compareVersions(running, latest.version) < 0
    ? latest.version
    : null
}

function readCache(): LatestRelease | null {
  try {
    const json = localStorage.getItem(CACHE_KEY)
    if (!json) return null
    const cached = JSON.parse(json) as Partial<LatestRelease>
    // An entry written by an older app has another shape: read again.
    if (
      typeof cached.version !== 'string' ||
      typeof cached.url !== 'string' ||
      typeof cached.checkedAt !== 'number'
    ) {
      return null
    }
    if (Date.now() - cached.checkedAt >= CACHE_DURATION) return null
    return cached as LatestRelease
  } catch {
    return null
  }
}

function writeCache(latest: LatestRelease) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(latest))
  } catch {
    // Storage unavailable: the next check asks GitHub again.
  }
}

interface UpdateCheckState {
  latest: LatestRelease | null
  checking: boolean
  failed: boolean
}

// One state for every user of the hook (the header's menu, Settings), read
// from the kept result on first use.
let state: UpdateCheckState | null = null
let inflight: Promise<void> | null = null
let failedAt = 0
const listeners = new Set<() => void>()

function snapshot(): UpdateCheckState {
  state ??= { latest: readCache(), checking: false, failed: false }
  return state
}

function setState(next: Partial<UpdateCheckState>) {
  state = { ...snapshot(), ...next }
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Test seam: back to the state of a fresh page.
export function resetUpdateCheck() {
  state = null
  inflight = null
  failedAt = 0
}

async function fetchLatest() {
  setState({ checking: true })
  try {
    const res = await fetch(GITHUB_RELEASES, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`)
    const best = newestStable((await res.json()) as Release[])
    if (!best) throw new Error('no stable release')
    const latest = {
      version: best.tag_name.replace(/^v/, ''),
      url: best.html_url,
      checkedAt: Date.now(),
    }
    writeCache(latest)
    setState({ latest, checking: false, failed: false })
  } catch {
    failedAt = Date.now()
    setState({ checking: false, failed: true })
  } finally {
    inflight = null
  }
}

// Asks GitHub unless a result younger than an hour is kept, or the last ask
// failed within RETRY_GAP (force: always). A check already running is shared.
async function check(force = false): Promise<void> {
  if (inflight) return inflight
  if (!force) {
    const cached = readCache()
    if (cached) {
      const { latest, failed } = snapshot()
      // Unchanged: no new state, so nothing renders again.
      if (latest?.checkedAt !== cached.checkedAt || failed) {
        setState({ latest: cached, failed: false })
      }
      return
    }
    if (Date.now() - failedAt < RETRY_GAP) return
  }
  inflight = fetchLatest()
  return inflight
}

export function useUpdateCheck() {
  return { ...useSyncExternalStore(subscribe, snapshot), check }
}
