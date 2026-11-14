import { useCallback, useEffect, useRef, useState } from 'react'
import { foldToolResults } from './use-agent-transcript'
import {
  fetchHistoryTranscript,
  type HistoryAgent,
  RequestError,
  type TranscriptEntry,
} from './use-mux-api'

// The transcript of a session of the history, read from its end once, with
// older entries loaded on request; never polled (a running session is read
// in its own Chat view).

// gone: the session is no longer there; failed: anything else
export type HistoryTranscriptError = 'gone' | 'failed'

export interface HistoryTranscript {
  entries: TranscriptEntry[]
  loaded: boolean
  loadingOlder: boolean
  error?: HistoryTranscriptError
  hasOlder: boolean
  loadOlder: () => void
}

export function useHistoryTranscript(
  paneId: string,
  agent: HistoryAgent,
  sessionId: string,
): HistoryTranscript {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [error, setError] = useState<HistoryTranscriptError>()
  const [before, setBefore] = useState<string>()
  const generation = useRef(0)

  useEffect(() => {
    const gen = ++generation.current
    setEntries([])
    setLoaded(false)
    setError(undefined)
    setBefore(undefined)
    fetchHistoryTranscript(paneId, agent, sessionId).then(
      (page) => {
        if (gen !== generation.current) return
        setEntries(foldToolResults(page.entries))
        setBefore(page.before)
        setLoaded(true)
      },
      (err) => {
        if (gen !== generation.current) return
        setError(
          err instanceof RequestError && err.status === 404 ? 'gone' : 'failed',
        )
        setLoaded(true)
      },
    )
  }, [paneId, agent, sessionId])

  const loadOlder = useCallback(() => {
    if (!before || loadingOlder) return
    const gen = generation.current
    setLoadingOlder(true)
    fetchHistoryTranscript(paneId, agent, sessionId, before)
      .then(
        (page) => {
          if (gen !== generation.current) return
          // The file changed under the read: its pages start over
          setEntries((held) =>
            foldToolResults(
              page.reset ? page.entries : [...page.entries, ...held],
            ),
          )
          setBefore(page.before)
        },
        () => {},
      )
      .finally(() => {
        if (gen === generation.current) setLoadingOlder(false)
      })
  }, [paneId, agent, sessionId, before, loadingOlder])

  return {
    entries,
    loaded,
    loadingOlder,
    error,
    hasOlder: !!before,
    loadOlder,
  }
}
