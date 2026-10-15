import { type TableLayout, WRAP_LINE_CHOICES } from './table-columns'

// What of a pane's Files and Changes tabs is kept on the device
// (files-persist.ts), and reading it back. Kept: the tabs, their order,
// the one shown, where each was left, and the tabs waiting for the user to
// close or keep them. Never kept: a sensitive file the user chose to show
// (its tab is left out whole, so neither its name nor its place is stored),
// an intent, the tree's open directories. A record read back is checked
// field by field: a tab that is not one is left out, the rest still opens.

export interface PersistedFileTab {
  id: string
  pinned: boolean
  lastUsed: number
  root: string
  path: string
  anchor?: string
  scrollTop?: number
  table?: TableLayout
  history: { path: string; scrollTop: number }[]
}

export interface PersistedChangeTab {
  id: string
  pinned: boolean
  lastUsed: number
  root: string
  path: string
  orig?: string
  staged: boolean
  editing: boolean
  scrollTop?: number
  editScrollTop?: number
}

export interface PersistedTabs<T> {
  root?: string
  tabs: T[]
  activeId: string | null
  pendingRootClose?: string[]
}

interface TabsState<T> {
  root?: string
  tabs: T[]
  activeId: string | null
  pendingRootClose?: string[]
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const optional =
  <T>(is: (v: unknown) => v is T) =>
  (v: unknown): v is T | undefined =>
    v === undefined || is(v)
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function isTable(v: unknown): v is TableLayout {
  return (
    isObject(v) &&
    isString(v.key) &&
    isObject(v.widths) &&
    Object.values(v.widths).every(isNumber) &&
    Array.isArray(v.wrapped) &&
    v.wrapped.every(isNumber) &&
    (v.lines === undefined ||
      (WRAP_LINE_CHOICES as readonly unknown[]).includes(v.lines))
  )
}

const isHistory = (v: unknown): v is PersistedFileTab['history'] =>
  Array.isArray(v) &&
  v.every((e) => isObject(e) && isString(e.path) && isNumber(e.scrollTop))

function isFileTab(v: unknown): v is PersistedFileTab {
  return (
    isObject(v) &&
    isString(v.id) &&
    isBool(v.pinned) &&
    isNumber(v.lastUsed) &&
    isString(v.root) &&
    isString(v.path) &&
    optional(isString)(v.anchor) &&
    optional(isNumber)(v.scrollTop) &&
    optional(isTable)(v.table) &&
    isHistory(v.history)
  )
}

function isChangeTab(v: unknown): v is PersistedChangeTab {
  return (
    isObject(v) &&
    isString(v.id) &&
    isBool(v.pinned) &&
    isNumber(v.lastUsed) &&
    isString(v.root) &&
    isString(v.path) &&
    optional(isString)(v.orig) &&
    isBool(v.staged) &&
    isBool(v.editing) &&
    optional(isNumber)(v.scrollTop) &&
    optional(isNumber)(v.editScrollTop)
  )
}

// state's tabs as kept, without those hidden (sensitive files shown); null
// when no tab is left to keep
function persisted<T extends { id: string }, P>(
  state: TabsState<T>,
  hidden: (t: T) => boolean,
  pick: (t: T) => P,
): PersistedTabs<P> | null {
  const tabs = state.tabs.filter((t) => !hidden(t))
  if (!tabs.length) return null
  const ids = new Set(tabs.map((t) => t.id))
  const pending = state.pendingRootClose?.filter((id) => ids.has(id))
  return {
    root: state.root,
    tabs: tabs.map(pick),
    activeId:
      state.activeId !== null && ids.has(state.activeId)
        ? state.activeId
        : null,
    pendingRootClose: pending?.length ? pending : undefined,
  }
}

// The tabs of a record, checked: null when none is left
function restored<P extends { id: string }>(
  raw: unknown,
  isTab: (v: unknown) => v is P,
): PersistedTabs<P> | null {
  if (!isObject(raw) || !Array.isArray(raw.tabs)) return null
  const tabs: P[] = []
  for (const t of raw.tabs) {
    // One tab per id: a second would be closed with the first
    if (isTab(t) && !tabs.some((o) => o.id === t.id)) tabs.push(t)
  }
  if (!tabs.length) return null
  const ids = new Set(tabs.map((t) => t.id))
  const pending = Array.isArray(raw.pendingRootClose)
    ? raw.pendingRootClose.filter((id): id is string => ids.has(id as string))
    : []
  return {
    root: isString(raw.root) ? raw.root : undefined,
    tabs,
    activeId:
      isString(raw.activeId) && ids.has(raw.activeId) ? raw.activeId : null,
    pendingRootClose: pending.length ? pending : undefined,
  }
}

export function persistedFilesState<
  T extends Omit<PersistedFileTab, 'history'> & {
    reveal: boolean
    history: { path: string; scrollTop: number; reveal?: boolean }[]
  },
>(state: TabsState<T>): PersistedTabs<PersistedFileTab> | null {
  return persisted(
    state,
    (t) => t.reveal,
    (t) => ({
      id: t.id,
      pinned: t.pinned,
      lastUsed: t.lastUsed,
      root: t.root,
      path: t.path,
      anchor: t.anchor,
      scrollTop: t.scrollTop,
      table: t.table,
      // A sensitive file shown and left by a link: not its name either
      history: t.history
        .filter((e) => !e.reveal)
        .map((e) => ({ path: e.path, scrollTop: e.scrollTop })),
    }),
  )
}

export function restoreFilesState(
  raw: unknown,
): PersistedTabs<PersistedFileTab> | null {
  return restored(raw, isFileTab)
}

export function persistedChangesState<
  T extends PersistedChangeTab & { revealed: boolean },
>(state: TabsState<T>): PersistedTabs<PersistedChangeTab> | null {
  return persisted(
    state,
    (t) => t.revealed,
    (t) => ({
      id: t.id,
      pinned: t.pinned,
      lastUsed: t.lastUsed,
      root: t.root,
      path: t.path,
      orig: t.orig,
      staged: t.staged,
      editing: t.editing,
      scrollTop: t.scrollTop,
      editScrollTop: t.editScrollTop,
    }),
  )
}

export function restoreChangesState(
  raw: unknown,
): PersistedTabs<PersistedChangeTab> | null {
  return restored(raw, isChangeTab)
}

// Where a restored store's counters start: past every tab's lastUsed and
// past every id with a number after its prefix (t3, c12), so a tab opened
// next never takes a restored one's id
export function restoredCounters(tabs: { id: string; lastUsed: number }[]) {
  let clock = 0
  let ids = 0
  for (const t of tabs) {
    clock = Math.max(clock, t.lastUsed)
    const n = Number(t.id.slice(1))
    if (Number.isInteger(n)) ids = Math.max(ids, n)
  }
  return { clock, ids }
}
