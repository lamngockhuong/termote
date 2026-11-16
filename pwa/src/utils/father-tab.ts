import {
  type AgentStatus,
  type Session,
  worstAgentStatus,
} from '../types/session'

// FatherTabs: tabs of one workspace gathered under a name, in a row above
// the tab bar. The name is the tab's own, before its first "/": "review/PR 1"
// is the tab "PR 1" of the FatherTab "review". Nothing else is stored, so
// every device and backend shows the same, and a rename moves a tab.
export const FATHER_TAB_SEPARATOR = '/'

// Names that start a path ("~/notes", "./run"), not a FatherTab.
const PATH_STARTS = ['~', '.', '..']

export interface FatherTabName {
  // Unset: the tab is in no FatherTab
  father?: string
  // The tab's name without its FatherTab
  label: string
}

// Splits a tab's name. Neither part may be empty, so "/tmp" and "logs/" are
// plain names.
export function splitFatherTab(name: string): FatherTabName {
  const at = name.indexOf(FATHER_TAB_SEPARATOR)
  if (at === -1) return { label: name }
  const father = name.slice(0, at).trim()
  const label = name.slice(at + 1).trim()
  if (!father || !label || PATH_STARTS.includes(father)) return { label: name }
  return { father, label }
}

// The name of a tab named label in the FatherTab father (none: label).
export function joinFatherTab(father: string | undefined, label: string) {
  return father === undefined
    ? label
    : `${father}${FATHER_TAB_SEPARATOR}${label}`
}

// The name of a new tab asked for as name while the tab current is on
// screen: in current's FatherTab, unless name says one itself.
export function fatherTabNewName(current: string, name: string): string {
  if (splitFatherTab(name).father !== undefined) return name
  return joinFatherTab(splitFatherTab(current).father, name)
}

export interface FatherTab {
  // Unset: the tabs in no FatherTab
  name?: string
  sessions: Session[]
  // Heaviest agent status among its tabs
  agentStatus?: AgentStatus
}

// The FatherTabs of a workspace's tabs, each where its first tab is, their
// tabs in the given order. Empty when no tab is in a FatherTab: the header
// then has no row for them.
export function fatherTabsOf(sessions: readonly Session[]): FatherTab[] {
  const byName = new Map<string | undefined, Session[]>()
  for (const session of sessions) {
    const { father } = splitFatherTab(session.name)
    const list = byName.get(father)
    if (list) list.push(session)
    else byName.set(father, [session])
  }
  if (!sessions.some((s) => splitFatherTab(s.name).father !== undefined))
    return []
  return [...byName].map(([name, list]) => ({
    name,
    sessions: list,
    agentStatus: worstAgentStatus(list.map((s) => s.agentStatus)),
  }))
}

// The tab a FatherTab opens on when picked: the one last shown in it on this
// page, else its first.
export function pickFatherTabSession(father: FatherTab, last?: string): string {
  return father.sessions.find((s) => s.id === last)?.id ?? father.sessions[0].id
}

// A place among a FatherTab's tabs as a place among all of the workspace's
// tabs, which is what a move is asked in: that of the tab now there.
export function fatherTabMoveIndex(
  all: readonly Session[],
  shown: readonly Session[],
  index: number,
): number {
  return all.findIndex((s) => s.id === shown[index].id)
}
