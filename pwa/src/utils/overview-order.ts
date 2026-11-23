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

// The key within one status, smallest first: a blocked agent by how long it
// has waited on the user (the oldest first), any other by the time it
// entered its status (the newest first), so an agent used a moment ago is
// above those left idle for hours. One without a time goes last.
const withinStatus = ({ status, since }: Ordered) => {
  const t = since ? Date.parse(since) : Number.NaN
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return status === 'blocked' ? t : -t
}

// The overview's order: the heaviest status first (blocked, working, done,
// idle), then withinStatus; ties keep their order (the sidebar's).
export function overviewOrder<T extends Ordered>(cards: T[]): T[] {
  return cards
    .map((card, i) => ({ card, i }))
    .sort(
      (a, b) =>
        rank(a.card.status) - rank(b.card.status) ||
        withinStatus(a.card) - withinStatus(b.card) ||
        a.i - b.i,
    )
    .map(({ card }) => card)
}
