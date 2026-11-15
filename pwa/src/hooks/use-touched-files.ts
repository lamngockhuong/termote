import { useEffect, useState } from 'react'
import {
  fetchTouchedFiles,
  type HistoryAgent,
  RequestError,
  type TouchedFiles,
} from './use-mux-api'

// The files a session changed through its tool calls. The pane's running
// session is read every TOUCHED_POLL while enabled and the page is visible;
// a session of the history (it no longer changes) once.

export const TOUCHED_POLL = 5000

// view-only: this device may not read the folder; none: the pane runs no
// agent session (or the history has it no longer)
export type TouchedError = 'view-only' | 'none' | 'failed'

export interface TouchedState {
  data?: TouchedFiles
  error?: TouchedError
}

function errorOf(e: unknown): TouchedError {
  if (e instanceof RequestError) {
    if (e.status === 403 && e.code === 'view_only') return 'view-only'
    if (e.status === 404) return 'none'
  }
  return 'failed'
}

export function useTouchedFiles(
  paneId: string,
  enabled: boolean,
  session?: { agent: HistoryAgent; id: string },
): TouchedState {
  const [state, setState] = useState<TouchedState>({})
  const agent = session?.agent
  const id = session?.id
  useEffect(() => {
    setState({})
    if (!enabled) return
    const one = agent && id ? { agent, id } : undefined
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let reading = false
    const read = async () => {
      clearTimeout(timer)
      if (reading || document.hidden) return
      reading = true
      try {
        const data = await fetchTouchedFiles(paneId, one)
        if (live) setState({ data })
      } catch (e) {
        // A poll that fails keeps what was read
        if (live) setState((s) => ({ data: s.data, error: errorOf(e) }))
      } finally {
        reading = false
      }
      if (live && !one) timer = setTimeout(read, TOUCHED_POLL)
    }
    const onVisible = () => {
      if (!document.hidden && !one) void read()
    }
    void read()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [paneId, enabled, agent, id])
  return state
}
