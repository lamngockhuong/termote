import { useEffect, useState } from 'react'
import { OVERVIEW_POLL } from './use-agent-overview'
import { fetchOverview, type Overview } from './use-mux-api'

// One pane's summary (/api/mux/overview?pane=), for the header's usage
// chip: only that pane's transcript is read and no changes are asked for,
// so the chip costs the server what one card does. Polled while enabled and
// the page is visible; a failed read keeps the last one.
export function usePaneOverview(
  paneId: string | undefined,
  interval: number,
  enabled: boolean,
): Overview | undefined {
  const [read, setRead] = useState<{ pane: string; overview: Overview }>()
  useEffect(() => {
    if (!enabled || !paneId) return
    let alive = true
    let reading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const period = interval > 0 ? interval : OVERVIEW_POLL
    const load = async () => {
      // A hidden page reads nothing; it reads again once shown.
      if (reading || document.hidden) return
      reading = true
      try {
        const overview = await fetchOverview(paneId)
        if (alive) setRead({ pane: paneId, overview })
      } catch {
        // The chip keeps what it showed
      } finally {
        reading = false
      }
      if (alive) timer = setTimeout(load, period)
    }
    const onVisibility = () => {
      if (document.hidden) return
      clearTimeout(timer)
      void load()
    }
    void load()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [paneId, interval, enabled])
  // Another pane's read is never shown for this one
  if (!enabled || !read || read.pane !== paneId) return undefined
  return read.overview
}
