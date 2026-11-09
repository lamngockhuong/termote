import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  fetchSettingsProposal,
  type SettingsProposal,
  type SettingsProposalRef,
} from './use-mux-api'

// The proposals this browser applied or dismissed, newest last: one is never
// shown again here, and a tab of the same browser hides it at once
export const PROPOSAL_SEEN_KEY = 'termote-settings-proposal-seen'
const SEEN_MAX = 10

const listeners = new Set<() => void>()
let cachedJson: string | null = null
let cachedSeen: readonly string[] = []

function readSeen(): readonly string[] {
  let json: string | null = null
  try {
    json = localStorage.getItem(PROPOSAL_SEEN_KEY)
  } catch {}
  if (json !== cachedJson) {
    cachedJson = json
    try {
      const v: unknown = json ? JSON.parse(json) : []
      cachedSeen = Array.isArray(v)
        ? v.filter((id): id is string => typeof id === 'string')
        : []
    } catch {
      cachedSeen = []
    }
  }
  return cachedSeen
}

function notify() {
  for (const fn of listeners) fn()
}

function onStorage(e: StorageEvent) {
  if (e.key === PROPOSAL_SEEN_KEY || e.key === null) notify()
}

function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}

// Never show proposal id again in this browser
export function markProposalSeen(id: string) {
  const seen = readSeen()
  if (seen.includes(id)) return
  try {
    localStorage.setItem(
      PROPOSAL_SEEN_KEY,
      JSON.stringify([...seen, id].slice(-SEEN_MAX)),
    )
  } catch {
    // storage full or blocked: it shows again after a reload
  }
  notify()
}

// Whether expiresAt (the server's clock) has passed, clockOffset being the
// server clock's offset from this device's
export function proposalExpired(
  expiresAt: string,
  clockOffset: number,
  now = Date.now(),
): boolean {
  const at = Date.parse(expiresAt)
  return !Number.isFinite(at) || at <= now + clockOffset
}

// The proposal to show: the one the snapshot names (ref, this server's
// own), read once, unless this browser applied or dismissed it, or it
// expired. latestId is the snapshot's, for a dialog opened on an older one.
export function useSettingsProposal(
  ref: SettingsProposalRef | undefined,
  enabled: boolean,
  clockOffset: number,
): {
  proposal: SettingsProposal | null
  latestId: string | undefined
  markSeen: (id: string) => void
} {
  const seen = useSyncExternalStore(
    subscribe,
    readSeen,
    /* v8 ignore next */
    () => [],
  )
  const [fetched, setFetched] = useState<SettingsProposal | null>(null)
  // Bumped when the shown proposal's time is up, to read the clock again
  const [tick, setTick] = useState(0)
  const wanted =
    enabled &&
    !!ref &&
    !seen.includes(ref.id) &&
    !proposalExpired(ref.expiresAt, clockOffset)
  const refId = wanted ? ref?.id : undefined

  useEffect(() => {
    if (!refId || fetched?.id === refId) return
    let live = true
    fetchSettingsProposal().then(
      (p) => {
        if (live) setFetched(p)
      },
      () => {
        // Read again with the next snapshot that names it
      },
    )
    return () => {
      live = false
    }
  }, [refId, fetched?.id])

  const proposal = useMemo(() => {
    void tick
    return refId &&
      fetched?.id === refId &&
      !proposalExpired(fetched.expiresAt, clockOffset)
      ? fetched
      : null
  }, [refId, fetched, clockOffset, tick])

  // Hide it when its time is up, polled or not
  useEffect(() => {
    if (!proposal) return
    const left = Date.parse(proposal.expiresAt) - (Date.now() + clockOffset)
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(left, 0))
    return () => clearTimeout(timer)
  }, [proposal, clockOffset])

  const markSeen = useCallback((id: string) => markProposalSeen(id), [])
  return { proposal, latestId: enabled ? ref?.id : undefined, markSeen }
}
