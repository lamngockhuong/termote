import {
  AGENT_STATUS_ORDER,
  type AgentStatus,
  type Session,
  type SessionPane,
} from '../types/session'

// One pane running an agent, with its tab: a card of the overview, a row of
// the compact sidebar's Agents.
export interface OverviewCard {
  session: Session
  pane: SessionPane
  status?: SessionPane['agentStatus']
  since?: string
}

// Every pane running an agent, with its tab, in the sidebar's order.
export function agentCards(sessions: Session[]): OverviewCard[] {
  return sessions.flatMap((session) =>
    (session.panes ?? [])
      .filter((p) => p.hasAgent)
      .map((pane) => ({
        session,
        pane,
        status: pane.agentStatus,
        since: pane.agentSince,
      })),
  )
}

// Cards by status, in AGENT_STATUS_ORDER, each list in the order given; a
// status without a card is left out. An agent with no status yet (an older
// server) counts as idle.
export function groupByStatus<T extends { status?: AgentStatus }>(
  cards: T[],
): [AgentStatus, T[]][] {
  return AGENT_STATUS_ORDER.map(
    (status) =>
      [status, cards.filter((c) => (c.status ?? 'idle') === status)] as [
        AgentStatus,
        T[],
      ],
  ).filter(([, list]) => list.length > 0)
}
