import { useCallback, useState } from 'react'
import { APP_INFO } from '../utils/app-info'

const GITHUB_API =
  'https://api.github.com/repos/lamngockhuong/termote/releases/latest'
const CACHE_KEY = 'termote-update-check'
const CACHE_DURATION = 60 * 60 * 1000 // 1 hour

interface CachedResult {
  hasUpdate: boolean
  latestVersion: string | null
  releaseUrl: string | null
  checkedAt: number
}

interface UpdateCheckResult {
  hasUpdate: boolean
  latestVersion: string | null
  releaseUrl: string | null
}

// Simple semver comparison: returns -1 if a < b, 0 if equal, 1 if a > b
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
  }
  return 0
}

function getCachedResult(): CachedResult | null {
  try {
    const json = localStorage.getItem(CACHE_KEY)
    if (!json) return null
    const cached = JSON.parse(json) as CachedResult
    // Check if cache is still valid
    if (Date.now() - cached.checkedAt < CACHE_DURATION) {
      return cached
    }
    return null
  } catch {
    return null
  }
}

function setCachedResult(result: UpdateCheckResult) {
  const cached: CachedResult = {
    ...result,
    checkedAt: Date.now(),
  }
  localStorage.setItem(CACHE_KEY, JSON.stringify(cached))
}

export function useUpdateCheck() {
  const [checking, setChecking] = useState(false)

  const checkForUpdate = useCallback(
    async (force = false): Promise<UpdateCheckResult> => {
      // Check cache first (unless forced)
      if (!force) {
        const cached = getCachedResult()
        if (cached) {
          return {
            hasUpdate: cached.hasUpdate,
            latestVersion: cached.latestVersion,
            releaseUrl: cached.releaseUrl,
          }
        }
      }

      setChecking(true)
      try {
        const response = await fetch(GITHUB_API, {
          headers: { Accept: 'application/vnd.github.v3+json' },
        })

        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status}`)
        }

        const data = await response.json()
        const latestVersion = data.tag_name as string
        const releaseUrl = data.html_url as string

        const hasUpdate = compareVersions(APP_INFO.version, latestVersion) < 0

        const result: UpdateCheckResult = {
          hasUpdate,
          latestVersion: latestVersion.replace(/^v/, ''),
          releaseUrl,
        }

        setCachedResult(result)

        return result
      } catch {
        // Silent fail - return no update
        return {
          hasUpdate: false,
          latestVersion: null,
          releaseUrl: null,
        }
      } finally {
        setChecking(false)
      }
    },
    [],
  )

  return { checkForUpdate, checking }
}
