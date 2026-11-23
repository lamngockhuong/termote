import type { Job, JobLiveStatus } from '../hooks/use-mux-api'

// The live statuses of an agent still in its pane: a gone one's pane id may
// be another agent's now (tmux reuses %N after a restart)
const LIVE: ReadonlySet<JobLiveStatus> = new Set([
  'working',
  'blocked',
  'background',
  'idle',
])

// The job each pane works on, for the agent cards: only an active job whose
// agent is still there; of two such jobs on one pane, the one changed last.
export function jobOfPane(jobs: readonly Job[]): Map<string, Job> {
  const out = new Map<string, Job>()
  for (const job of jobs) {
    const pane = job.live.paneId
    if (job.state !== 'active' || !pane || !job.live.status) continue
    if (!LIVE.has(job.live.status)) continue
    const held = out.get(pane)
    if (held && Date.parse(held.updated) >= Date.parse(job.updated)) continue
    out.set(pane, job)
  }
  return out
}
