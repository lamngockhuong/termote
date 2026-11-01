import { useEffect, useState } from 'react'
import { fetchHostStats, type HostStats } from './use-mux-api'

// How often the Host chip and sheet read the server's sample (the server
// samples every 5 s).
export const HOST_POLL = 10_000

// The machine running termote (/api/mux/system), read at once and every
// HOST_POLL while enabled and the page is visible; a hidden page reads
// nothing until shown again. A failed read clears it: the chip then shows
// nothing rather than old numbers.
export function useHostStats(enabled: boolean): HostStats | undefined {
  const [stats, setStats] = useState<HostStats>()
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let reading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      if (reading || document.hidden) return
      reading = true
      try {
        const s = await fetchHostStats()
        if (alive) setStats(s)
      } catch {
        if (alive) setStats(undefined)
      } finally {
        reading = false
      }
      if (alive) timer = setTimeout(load, HOST_POLL)
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
      // Turned on again, old numbers are not shown before a new read
      setStats(undefined)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])
  return enabled ? stats : undefined
}
