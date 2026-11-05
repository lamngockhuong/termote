import { useEffect, useState } from 'react'

// A coarse "3 min ago" needs no more: a tick every 30 s keeps it right
// without rendering every second.
export const NOW_TICK = 30_000

// The server's time now (this device's plus clockOffset, in ms), read again
// every NOW_TICK and whenever the offset changes.
export function useNow(clockOffset: number): number {
  const [now, setNow] = useState(() => Date.now() + clockOffset)
  useEffect(() => {
    setNow(Date.now() + clockOffset)
    const id = setInterval(() => setNow(Date.now() + clockOffset), NOW_TICK)
    return () => clearInterval(id)
  }, [clockOffset])
  return now
}
