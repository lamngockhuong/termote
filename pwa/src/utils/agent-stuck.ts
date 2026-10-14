import type { AgentStatus } from '../types/session'

// An agent that says it works but has written nothing for a while may be
// stuck: a hint on its card, never a notification.

export const STUCK_MINUTES_OPTIONS = [3, 5, 10, 15, 20, 30, 45, 60] as const
export const DEFAULT_STUCK_MINUTES = 10

// An edited or future config may hold another value (the Settings list
// offers only these): the default then.
export function resolveStuckMinutes(value: unknown): number {
  return STUCK_MINUTES_OPTIONS.find((m) => m === value) ?? DEFAULT_STUCK_MINUTES
}

// Minutes since lastTs (the agent's last write, its running subagents'
// included) when it works and has been quiet for minutes or more; else
// undefined. Without lastTs it is never stuck.
export function stuckFor(
  status: AgentStatus | undefined,
  lastTs: string | undefined,
  now: number,
  minutes: number,
): number | undefined {
  if (status !== 'working' || !lastTs) return undefined
  const t = Date.parse(lastTs)
  if (!Number.isFinite(t)) return undefined
  const quiet = Math.floor((now - t) / 60_000)
  return quiet >= minutes ? quiet : undefined
}
