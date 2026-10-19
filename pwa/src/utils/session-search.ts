import type { Session, SessionGroup, SessionPane } from '../types/session'

// Lower case without diacritics: "Tiếng Đức" and "tieng duc" compare equal.
// Not the device's locale: a Turkish one would keep "I" from matching "i".
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
}

// The words of a search box, folded; none for an empty or blank one.
export function searchTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean)
}

// Every term is found in at least one of the fields.
function matchesFields(
  fields: (string | undefined)[],
  terms: string[],
): boolean {
  if (terms.length === 0) return true
  const folded = fields.filter((f): f is string => !!f).map(fold)
  return terms.every((t) => folded.some((f) => f.includes(t)))
}

// Whether a sidebar row matches: its name, description, group and branch,
// its agents and the processes and labels of its panes.
export function matchesQuery(
  session: Session,
  terms: string[],
  group?: SessionGroup,
): boolean {
  const panes = session.panes ?? []
  return matchesFields(
    [
      session.name,
      session.description,
      group?.name,
      group?.worktree?.branch,
      session.agentName,
      ...(session.commands ?? []),
      ...panes.flatMap((p) => [p.label, p.agentName, p.command]),
    ],
    terms,
  )
}

// Whether an overview card (one pane with an agent) matches.
export function matchesPaneQuery(
  session: Session,
  pane: SessionPane,
  terms: string[],
  groupName?: string,
): boolean {
  return matchesFields(
    [session.name, groupName, pane.label, pane.agentName, pane.command],
    terms,
  )
}
