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

// A line of the row of groups above the tab bar (the row layout): a group,
// or the tabs in none (name unset).
export interface TabGroupRow {
  name?: string
  sessions: Session[]
  // Heaviest agent status among its tabs
  agentStatus?: AgentStatus
}

// The row of a workspace's groups, each where its first tab is, with the
// tabs in none as one more. Empty when no tab is in a group: there is no row
// then.
export function tabGroupRows(sessions: readonly Session[]): TabGroupRow[] {
  const byName = new Map<string | undefined, Session[]>()
  for (const s of sessions) {
    const { group } = splitTabGroup(s.name)
    const list = byName.get(group)
    if (list) list.push(s)
    else byName.set(group, [s])
  }
  if (!sessions.some((s) => splitTabGroup(s.name).group !== undefined))
    return []
  return [...byName].map(([name, list]) => ({
    name,
    sessions: list,
    agentStatus: worstAgentStatus(list.map((s) => s.agentStatus)),
  }))
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

// A name a group may take: one the tab names split back into ("a/b" would
// be the group "a", "~" a path)
export const validGroupName = (name: string) =>
  name !== '' &&
  !name.includes(TAB_GROUP_SEPARATOR) &&
  !PATH_STARTS.includes(name)

// What a bar shows, to compare two: each tab shown with its group, and the
// name of a group (of those in groups) none of whose tabs shows
function barShape(items: readonly StripItem[], groups: ReadonlySet<string>) {
  const shown = new Set(
    items.flatMap((it) =>
      it.kind === 'tab' && it.group !== undefined ? [it.group] : [],
    ),
  )
  return items
    .flatMap((it) =>
      it.kind === 'tab'
        ? [`t\0${it.group ?? ''}\0${it.session.id}`]
        : groups.has(it.group.name) && !shown.has(it.group.name)
          ? [`g\0${it.group.name}`]
          : [],
    )
    .join('\n')
}

// One tab moved in the server's order
export interface TabMove {
  id: string
  index: number
}

// The move in the server's order that makes the bar show want: all is the
// workspace's tabs in that order (with any rename already in their names),
// layOut the bar of a list. null: none is needed; undefined: no single move
// does it. The bar gathers each group where its first tab is, so moving the
// tab asked for (prefer) is not always the way: when it leads its group,
// another may have to move instead. Tried in order: none, prefer, the rest.
export function solveTabMove(
  all: readonly Session[],
  want: readonly StripItem[],
  layOut: (list: readonly Session[]) => StripItem[],
  prefer: string,
): TabMove | null | undefined {
  const groups = new Set(all.flatMap((s) => splitTabGroup(s.name).group ?? []))
  const target = barShape(want, groups)
  const shows = (list: readonly Session[]) =>
    barShape(layOut(list), groups) === target
  if (shows(all)) return null
  const tabs = [
    ...all.filter((s) => s.id === prefer),
    ...all.filter((s) => s.id !== prefer),
  ]
  for (const { id } of tabs) {
    const from = all.findIndex((s) => s.id === id)
    const rest = all.filter((_, i) => i !== from)
    for (let index = 0; index < all.length; index++) {
      if (index === from) continue
      const list = [...rest]
      list.splice(index, 0, all[from])
      if (shows(list)) return { id, index }
    }
  }
  return undefined
}

// Where no single move shows want: the tab id moved just before the tab
// that follows it there, else just after the one before it. null: already
// so placed.
export function nearestMove(
  all: readonly Session[],
  want: readonly StripItem[],
  id: string,
): TabMove | null {
  const tabs = want.flatMap((it) => (it.kind === 'tab' ? [it.session.id] : []))
  const at = tabs.indexOf(id)
  const from = all.findIndex((s) => s.id === id)
  const where = (other: string) => all.findIndex((s) => s.id === other)
  let index = from
  if (at < tabs.length - 1) {
    const next = where(tabs[at + 1])
    index = from < next ? next - 1 : next
  } else if (at > 0) {
    const prev = where(tabs[at - 1])
    index = from > prev ? prev + 1 : prev
  }
  return index === from ? null : { id, index }
}

// The bar a tab dragged from items[from] is meant to leave, landing at
// place to of the items without it, in group
export function dropWant(
  items: readonly StripItem[],
  from: number,
  to: number,
  group: string | undefined,
): StripItem[] {
  const dragged = items[from] as Extract<StripItem, { kind: 'tab' }>
  const rest = items.filter((_, i) => i !== from)
  rest.splice(to, 0, { ...dragged, group })
  return rest
}

// The bar a tab (items[at]) is meant to leave after one step left (-1) or
// right (1), as a browser moves a tab: past its neighbour within its group,
// out of its group at the group's edge, and past a whole group (or the next
// tab) outside of one. Undefined at either end of the bar.
export function stepWant(
  items: readonly StripItem[],
  at: number,
  delta: -1 | 1,
): StripItem[] | undefined {
  const tab = items[at] as Extract<StripItem, { kind: 'tab' }>
  const next = items[at + delta]
  const without = items.filter((_, i) => i !== at)
  const put = (index: number, group: string | undefined) => {
    const list = [...without]
    list.splice(index, 0, { ...tab, group })
    return list
  }
  if (tab.group !== undefined) {
    // Past a tab of its group
    if (next?.kind === 'tab' && next.group === tab.group)
      return put(at + delta, tab.group)
    // Out of it: before its name, or after its last tab
    return delta === -1 ? put(at - 1, undefined) : put(at, undefined)
  }
  if (!next) return undefined
  const unit = groupOf(next)
  if (unit === undefined) return put(at + delta, undefined)
  // Past the whole group: its name and the tabs it shows
  let edge = at + delta
  while (groupOf(items[edge + delta]) === unit) edge += delta
  return put(edge, undefined)
}

// The bar's items as the units that move along it: a tab in no group, or a
// group's name with the tabs it shows
export function stripUnits(items: readonly StripItem[]): StripItem[][] {
  const units: StripItem[][] = []
  for (const it of items) {
    const last = units.at(-1)
    if (it.kind === 'tab' && it.group !== undefined && last) last.push(it)
    else units.push([it])
  }
  return units
}

// The server's order with the tabs of group taken out and put back together,
// in their order, just before before: the first item of the unit that will
// follow the group on the bar (a group's name: its first tab on the server).
// None: at the end.
export function groupMoveOrder(
  all: readonly Session[],
  group: string,
  before?: StripItem,
): Session[] {
  const mine = (s: Session) => splitTabGroup(s.name).group === group
  const members = all.filter(mine)
  const rest = all.filter((s) => !mine(s))
  const at = !before
    ? rest.length
    : before.kind === 'tab'
      ? rest.findIndex((s) => s.id === before.session.id)
      : rest.findIndex((s) => splitTabGroup(s.name).group === before.group.name)
  rest.splice(at, 0, ...members)
  return rest
}

// The moves, one tab at a time, each by the tab's lasting key and its place
// once moved, that turn the order from into the order to
export function moveSteps(
  from: readonly Session[],
  to: readonly Session[],
): { key: string; index: number }[] {
  const cur = [...from]
  const steps: { key: string; index: number }[] = []
  to.forEach((want, index) => {
    if (cur[index].id === want.id) return
    const at = cur.findIndex((s) => s.id === want.id)
    cur.splice(index, 0, ...cur.splice(at, 1))
    steps.push({ key: lastingKey(want), index })
  })
  return steps
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
