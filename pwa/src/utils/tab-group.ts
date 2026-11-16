import {
  type AgentStatus,
  type Session,
  worstAgentStatus,
} from '../types/session'
import { avatarToneIndex } from './group-avatar'

// Tab groups, like a browser's: tabs of one workspace gathered under a
// coloured name in the tab bar. The group is the tab's own name, before its
// first "/": "review/PR 1" is the tab "PR 1" of the group "review". Nothing
// else is stored, so every device and backend shows the same, and a rename
// moves a tab in or out of a group.
export const TAB_GROUP_SEPARATOR = '/'

// Names that start a path ("~/notes", "./run"), not a group.
const PATH_STARTS = ['~', '.', '..']

export interface TabGroupName {
  // Unset: the tab is in no group
  group?: string
  // The tab's name without its group
  label: string
}

// Splits a tab's name. Neither part may be empty, so "/tmp" and "logs/" are
// plain names.
export function splitTabGroup(name: string): TabGroupName {
  const at = name.indexOf(TAB_GROUP_SEPARATOR)
  if (at === -1) return { label: name }
  const group = name.slice(0, at).trim()
  const label = name.slice(at + 1).trim()
  if (!group || !label || PATH_STARTS.includes(group)) return { label: name }
  return { group, label }
}

// The name of a tab named label in the group (none: label).
export function joinTabGroup(group: string | undefined, label: string) {
  return group === undefined ? label : `${group}${TAB_GROUP_SEPARATOR}${label}`
}

// The name of a new tab asked for as name while the tab current is on
// screen: in current's group, unless name says one itself.
export function tabGroupNewName(current: string, name: string): string {
  if (splitTabGroup(name).group !== undefined) return name
  return joinTabGroup(splitTabGroup(current).group, name)
}

// A group's colour, the same for the same name on every device. Written out
// whole so Tailwind finds each class (index.css, --tm-avatar-N).
const GROUP_FILLS = [
  'bg-avatar-1',
  'bg-avatar-2',
  'bg-avatar-3',
  'bg-avatar-4',
  'bg-avatar-5',
  'bg-avatar-6',
  'bg-avatar-7',
  'bg-avatar-8',
] as const
const GROUP_LINES = [
  'after:bg-avatar-1',
  'after:bg-avatar-2',
  'after:bg-avatar-3',
  'after:bg-avatar-4',
  'after:bg-avatar-5',
  'after:bg-avatar-6',
  'after:bg-avatar-7',
  'after:bg-avatar-8',
] as const
// The group's name's background, and the line under each of its tabs (an
// ::after the tab draws)
export const tabGroupFill = (group: string) =>
  GROUP_FILLS[avatarToneIndex(group)]
export const tabGroupLine = (group: string) =>
  GROUP_LINES[avatarToneIndex(group)]

export interface TabGroup {
  name: string
  // All of its tabs, shown or not
  sessions: Session[]
  // Heaviest agent status among its tabs
  agentStatus?: AgentStatus
  // Folded: only its name shows, and the tab on screen if it is one of them
  collapsed: boolean
}

// What the tab bar shows, in its order: a group's name, then its tabs, and
// the tabs in no group.
export type StripItem =
  | { kind: 'group'; key: string; group: TabGroup }
  | { kind: 'tab'; key: string; session: Session; group?: string }

const lastingKey = (s: Session) => s.key ?? s.id

// The tab bar of a workspace's tabs: each group where its first tab is, its
// name first and its tabs after it in their order; a tab in no group where
// it is. A collapsed group shows only the tab on screen among its own.
export function stripItems(
  sessions: readonly Session[],
  collapsed: (group: string) => boolean,
  activeId: string,
): StripItem[] {
  const members = new Map<string, Session[]>()
  for (const s of sessions) {
    const { group } = splitTabGroup(s.name)
    if (group === undefined) continue
    const list = members.get(group)
    if (list) list.push(s)
    else members.set(group, [s])
  }
  const items: StripItem[] = []
  const seen = new Set<string>()
  for (const s of sessions) {
    const { group } = splitTabGroup(s.name)
    if (group === undefined) {
      items.push({ kind: 'tab', key: lastingKey(s), session: s })
      continue
    }
    if (seen.has(group)) continue
    seen.add(group)
    const list = members.get(group)!
    const folded = collapsed(group)
    items.push({
      kind: 'group',
      // NUL: no tab's key holds one
      key: `\0${group}`,
      group: {
        name: group,
        sessions: list,
        agentStatus: worstAgentStatus(list.map((m) => m.agentStatus)),
        collapsed: folded,
      },
    })
    for (const m of list)
      if (!folded || m.id === activeId)
        items.push({ kind: 'tab', key: lastingKey(m), session: m, group })
  }
  return items
}

const groupOf = (item?: StripItem) =>
  item?.kind === 'group' ? item.group.name : item?.group

// The group a tab dragged along the bar from items[from] ends in, landing
// at place to (of the items without it): the group it lands inside, after
// a group's name or between two of its tabs; else its own while a tab of
// its own is still beside it; else none.
export function dropGroup(
  items: readonly StripItem[],
  from: number,
  to: number,
): string | undefined {
  const dragged = items[from]
  const rest = items.filter((_, i) => i !== from)
  const left = rest[to - 1]
  const right = rest[to]
  if (
    right?.kind === 'tab' &&
    right.group !== undefined &&
    groupOf(left) === right.group
  )
    return right.group
  const own = groupOf(dragged)
  if (own === undefined) return undefined
  const beside = (it?: StripItem) => it?.kind === 'tab' && it.group === own
  return beside(left) || beside(right) ? own : undefined
}

// The place among the tabs shown that a tab dragged from items[from] lands
// at, landing at place to of the items without it
export function dropTabIndex(
  items: readonly StripItem[],
  from: number,
  to: number,
): number {
  return items
    .filter((_, i) => i !== from)
    .slice(0, to)
    .filter((it) => it.kind === 'tab').length
}

// Where in the server's order the tab id goes to land at place index among
// the tabs shown, ending in group: before the tab that will follow it, else
// after the one that will precede it, one of group's first. The bar gathers
// a group's tabs, so only their order among themselves, and that of the
// tabs in no group, shows. Its own place when nothing changes.
export function tabGroupMoveIndex(
  all: readonly Session[],
  shown: readonly Session[],
  id: string,
  index: number,
  group: string | undefined,
): number {
  const at = (s: Session) => all.findIndex((a) => a.id === s.id)
  const from = all.findIndex((s) => s.id === id)
  const rest = shown.filter((s) => s.id !== id)
  let right: Session | undefined = rest[index]
  let left: Session | undefined = rest[index - 1]
  const mine = (s?: Session) =>
    s !== undefined && splitTabGroup(s.name).group === group
  if (group !== undefined && (mine(right) || mine(left))) {
    if (!mine(right)) right = undefined
    if (!mine(left)) left = undefined
  }
  if (right) {
    const r = at(right)
    return from < r ? r - 1 : r
  }
  if (left) {
    const l = at(left)
    return from > l ? l + 1 : l
  }
  return from
}

// The groups this browser shows collapsed, by workspace and name; a
// convenience of this browser only, so nothing is lost without storage
const COLLAPSED_KEY = 'termote-tab-groups-collapsed'
export const collapsedKey = (workspace: string | undefined, group: string) =>
  `${workspace ?? ''}\n${group}`

export function readCollapsed(): Set<string> {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(COLLAPSED_KEY) ?? '[]',
    )
    return new Set(
      Array.isArray(saved)
        ? saved.filter((k): k is string => typeof k === 'string')
        : [],
    )
  } catch {
    return new Set()
  }
}

export function writeCollapsed(keys: ReadonlySet<string>) {
  try {
    if (keys.size)
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]))
    else localStorage.removeItem(COLLAPSED_KEY)
  } catch {
    // Storage unavailable: collapsed until the page reloads
  }
}
