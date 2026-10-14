import { AGENT_STATUS_ORDER, type AgentStatus } from '../types/session'

interface Ordered {
  status?: AgentStatus
  // When the status began (RFC 3339); absent from an older server
  since?: string
}

const rank = (s?: AgentStatus) => {
  const i = s ? AGENT_STATUS_ORDER.indexOf(s) : -1
  return i === -1 ? AGENT_STATUS_ORDER.length : i
}

const startedAt = (since?: string) => {
  const t = since ? Date.parse(since) : Number.NaN
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
}

// The overview's order: the heaviest status first (blocked, working, done,
// idle), then within one status the one in it longest; ties keep their
// order (the sidebar's).
export function overviewOrder<T extends Ordered>(cards: T[]): T[] {
  return cards
    .map((card, i) => ({ card, i }))
    .sort(
      (a, b) =>
        rank(a.card.status) - rank(b.card.status) ||
        startedAt(a.card.since) - startedAt(b.card.since) ||
        a.i - b.i,
    )
    .map(({ card }) => card)
}
