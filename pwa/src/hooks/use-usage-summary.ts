import { useEffect, useState } from 'react'
import {
  fetchUsageSummary,
  RequestError,
  type UsageSummary,
} from './use-mux-api'

// The token usage of the last days: of every session of the server's user
// (no pane: the overview), or of the pane's folder (the history). Read when
// shown and every USAGE_POLL after while the page is visible; the server
// shares one read between clients for 30 s.

export const USAGE_POLL = 60_000

// view-only: this device may not read the folder; failed: anything else
export type UsageSummaryError = 'view-only' | 'failed'

export interface UsageSummaryState {
  summary?: UsageSummary
  error?: UsageSummaryError
}

export function useUsageSummary(
  paneId?: string,
  enabled = true,
): UsageSummaryState {
  const [state, setState] = useState<UsageSummaryState>({})
  useEffect(() => {
    setState({})
    if (!enabled) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      clearTimeout(timer)
      if (document.hidden) return
      fetchUsageSummary(paneId).then(
        (summary) => live && setState({ summary }),
        (err) =>
          live &&
          setState((s) => ({
            summary: s.summary,
            error:
              err instanceof RequestError && err.code === 'view_only'
                ? 'view-only'
                : 'failed',
          })),
      )
      timer = setTimeout(read, USAGE_POLL)
    }
    const onVisibility = () => {
      if (!document.hidden) read()
    }
    read()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      live = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [paneId, enabled])
  return state
}
