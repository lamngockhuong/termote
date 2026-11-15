import { useEffect, useState } from 'react'
import {
  fetchSessionUsage,
  type HistoryAgent,
  type SessionUsage,
} from './use-mux-api'

// The tokens of a session of the pane's history, read once when it is
// opened: an old session no longer grows (a running one is shown on its
// agent card). Undefined until read, and when the read failed. The server
// reads the tokens of every agent of the history (OpenCode's through its
// service).
export function useSessionUsage(
  paneId: string,
  agent: HistoryAgent,
  sessionId: string,
): SessionUsage | undefined {
  const [usage, setUsage] = useState<SessionUsage>()
  useEffect(() => {
    let live = true
    setUsage(undefined)
    fetchSessionUsage(paneId, { agent, id: sessionId }).then(
      (u) => live && setUsage(u),
      () => {},
    )
    return () => {
      live = false
    }
  }, [paneId, agent, sessionId])
  return usage
}
