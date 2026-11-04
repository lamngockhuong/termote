// The machine the demo pretends to run on (GET /api/mux/system): a laptop
// with a little load, its history drawn from a slow wave so the sparklines
// move.
import type { HostStats } from '../../hooks/use-mux-api'

const GiB = 1024 ** 3
const STEP_MS = 5000
const POINTS = 180

const cpuAt = (t: number) => Math.round(28 + 14 * Math.sin(t / 90_000))
const memAt = (t: number) =>
  Math.round((52 + 4 * Math.sin(t / 400_000)) * 10) / 10

export function demoHostStats(now: number): HostStats {
  const last = now - (now % STEP_MS)
  const history = Array.from({ length: POINTS }, (_, i) => {
    const t = last - (POINTS - 1 - i) * STEP_MS
    return { t: new Date(t).toISOString(), cpu: cpuAt(t), mem: memAt(t) }
  })
  const total = 16 * GiB
  const mem = memAt(last)
  return {
    scope: 'host',
    cpu: { percent: cpuAt(last), count: 8 },
    load: [1.42, 1.18, 0.97],
    memory: {
      total,
      used: Math.round((total * mem) / 100),
      percent: mem,
      approx: false,
    },
    swap: { total: 2 * GiB, used: 0, percent: 0, approx: false },
    disks: [
      // i18n-ignore: the server's disk label
      { label: 'home', total: 512 * GiB, free: 301 * GiB, percent: 41.2 },
    ],
    battery: { percent: 86, charging: false, plugged: false, minutesLeft: 312 },
    sampledAt: new Date(last).toISOString(),
    history,
  }
}
