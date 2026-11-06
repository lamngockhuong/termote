import { useEffect, useState } from 'react'
import { currentMachine } from '../utils/api-base'
import { fetchMachines, type MachineInfo, RequestError } from './use-mux-api'

// How often the machines list is read while it shows a machine, and while
// it is empty (a machine added with the CLI shows up within this).
export const MACHINES_POLL = 5_000
export const MACHINES_IDLE_POLL = 30_000

// The machines this server reaches (always this server's list, whatever
// machine is open), read at once and then every MACHINES_POLL while the page
// is visible; MACHINES_IDLE_POLL while there are none. A server without the
// route (404) is not asked again. A failed read keeps the last list.
export function useMachines(): MachineInfo[] {
  const [machines, setMachines] = useState<MachineInfo[]>([])
  useEffect(() => {
    let alive = true
    let reading = false
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let last: MachineInfo[] = []
    const load = async () => {
      if (reading || stopped || document.hidden) return
      reading = true
      try {
        last = await fetchMachines()
        if (alive) setMachines(last)
      } catch (err) {
        if (err instanceof RequestError && err.status === 404) stopped = true
      } finally {
        reading = false
      }
      if (alive && !stopped) {
        const busy = last.length > 0 || currentMachine() !== ''
        timer = setTimeout(load, busy ? MACHINES_POLL : MACHINES_IDLE_POLL)
      }
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
  }, [])
  return machines
}
