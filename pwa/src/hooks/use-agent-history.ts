import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchAgentHistory,
  type HistorySession,
  RequestError,
} from './use-mux-api'

// The session history of a pane, read once when it is opened (paneId set)
// and page by page after; never polled. A row can be marked as running
// (a resume refused because another tab runs it).

// view-only: a view-only device may not read this root; failed: anything
// else, which a retry may fix
export type AgentHistoryError = 'view-only' | 'failed'

export interface AgentHistory {
  sessions: HistorySession[]
  loaded: boolean
  loadingMore: boolean
  error?: AgentHistoryError
  // More sessions can be loaded
  hasMore: boolean
  truncated: boolean
  loadMore: () => void
  retry: () => void
  setLive: (id: string, live: HistorySession['live']) => void
}

const errorOf = (err: unknown): AgentHistoryError =>
  err instanceof RequestError && err.code === 'view_only'
    ? 'view-only'
    : 'failed'

export function useAgentHistory(paneId: string | undefined): AgentHistory {
  const [sessions, setSessions] = useState<HistorySession[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<AgentHistoryError>()
  const [next, setNext] = useState<string>()
  const [truncated, setTruncated] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // The read in flight belongs to this pane and attempt; a later one wins
  const generation = useRef(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt asks for a new read
  useEffect(() => {
    const gen = ++generation.current
    setSessions([])
    setLoaded(false)
    setError(undefined)
    setNext(undefined)
    setTruncated(false)
    if (!paneId) return
    fetchAgentHistory(paneId).then(
      (page) => {
        if (gen !== generation.current) return
        setSessions(page.sessions)
        setNext(page.next)
        setTruncated(page.truncated)
        setLoaded(true)
      },
      (err) => {
        if (gen !== generation.current) return
        setError(errorOf(err))
        setLoaded(true)
      },
    )
  }, [paneId, attempt])

  const loadMore = useCallback(() => {
    if (!paneId || !next || loadingMore) return
    const gen = generation.current
    setLoadingMore(true)
    fetchAgentHistory(paneId, { cursor: next })
      .then(
        (page) => {
          if (gen !== generation.current) return
          setSessions((s) => [...s, ...page.sessions])
          setNext(page.next)
        },
        (err) => {
          if (gen === generation.current) setError(errorOf(err))
        },
      )
      .finally(() => {
        if (gen === generation.current) setLoadingMore(false)
      })
  }, [paneId, next, loadingMore])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const setLive = useCallback(
    (id: string, live: HistorySession['live']) =>
      setSessions((s) => s.map((x) => (x.id === id ? { ...x, live } : x))),
    [],
  )

  return {
    sessions,
    loaded,
    loadingMore,
    error,
    hasMore: !!next,
    truncated,
    loadMore,
    retry,
    setLive,
  }
}
