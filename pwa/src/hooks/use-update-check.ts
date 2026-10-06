import { useCallback, useState } from 'react'

// The releases list, not releases/latest: `termote update` and the installer
// pick from it (server/release_tags.go), and releases/latest can name a 0.x.
const GITHUB_RELEASES =
  'https://api.github.com/repos/lamngockhuong/termote/releases?per_page=30'
const CACHE_KEY = 'termote-update-check'
const CACHE_DURATION = 60 * 60 * 1000 // 1 hour

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

export function useUpdateCheck() {
  const [latest, setLatest] = useState<LatestRelease | null>(readCache)
  const [checking, setChecking] = useState(false)
  const [failed, setFailed] = useState(false)

  // Asks GitHub unless a result younger than an hour is kept (force: always).
  const check = useCallback(async (force = false) => {
    if (!force) {
      const cached = readCache()
      if (cached) {
        setLatest(cached)
        setFailed(false)
        return
      }
    }
    setChecking(true)
    try {
      const res = await fetch(GITHUB_RELEASES, {
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`)
      const best = newestStable((await res.json()) as Release[])
      if (!best) throw new Error('no stable release')
      const next = {
        version: best.tag_name.replace(/^v/, ''),
        url: best.html_url,
        checkedAt: Date.now(),
      }
      writeCache(next)
      setLatest(next)
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setChecking(false)
    }
  }, [])

  return { latest, checking, failed, check }
}
