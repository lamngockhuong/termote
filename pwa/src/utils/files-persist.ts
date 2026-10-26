import { isFocusWindow } from './focus-mode'
import {
  paneGroupOf,
  paneInstance,
  paneKeyOf,
  renamedGroupId,
} from './pane-remap'

// What the PWA keeps on this device for a pane, so closing the app (or the
// OS killing it) loses nothing: the Files and Changes tabs, the unsaved
// drafts of files that are not sensitive, the view the pane was left on,
// and the files opened lately (the command palette lists them first).
// Each record is stored under the server's instance id and the pane's key
// (pane-remap.ts), never its id: another server on the same origin, or a
// tmux window move, never shows a record to the wrong pane. Records not
// written for 14 days are swept when the module loads, and signing out
// removes them all, in every tab of the origin.

export type PersistKind = 'files' | 'changes' | 'drafts' | 'view' | 'recent'

const PREFIXES: Record<PersistKind, string> = {
  files: 'termote-files-tabs:',
  changes: 'termote-changes-tabs:',
  drafts: 'termote-file-drafts:',
  view: 'termote-pane-view:',
  recent: 'termote-recent-files:',
}
const ALL_KINDS = Object.keys(PREFIXES) as PersistKind[]

// The most files kept in a pane's list of files opened lately
export const RECENT_LIMIT = 20

// Set (to the time) when a tab of the origin signs out: the others stop
// writing and forget what they hold
export const SIGNED_OUT_KEY = 'termote-signed-out'

export const PERSIST_TTL = 14 * 24 * 60 * 60 * 1000
// Tab changes (a scroll, a tab opened) are written this long after the last
export const TABS_DELAY = 500
// Drafts are measured as stored (JSON, escapes included): one at most, and
// all of them, so the app's other keys always have room
export const DRAFT_LIMIT = 1_000_000
export const DRAFTS_LIMIT = 1_500_000

interface StoredRecord {
  v: 1
  // The pane's key; the storage key holds it too, but a key with ":" in it
  // (Zellij) would make one pane's prefix match another's
  pane: string
  // The name of the pane's group when written: a tmux window key (@N) is
  // used again after tmux restarts, most likely in another session
  group: string | null
  savedAt?: number
  editedAt?: number
}

interface TabsRecord<T> extends StoredRecord {
  savedAt: number
  state: T
}

interface DraftRecord<T> extends StoredRecord {
  editedAt: number
  role: 'full'
  draft: T
}

interface ViewRecord<T> extends StoredRecord {
  savedAt: number
  view: T
}

// A file opened lately: its path under root
export interface RecentFile {
  root: string
  path: string
}

interface RecentRecord extends StoredRecord {
  savedAt: number
  files: RecentFile[]
}

// A stored draft, as loadDrafts returns it
export interface StoredDraft<T> {
  draft: T
  editedAt: number
}

// Set once this tab signed out, or saw another one do: every write is
// dropped until the page loads again
let disabled = false
// Tab records waiting for their delay, by storage key (null removes)
const pending = new Map<string, unknown>()
let timer: ReturnType<typeof setTimeout> | undefined
// What was last written under each tab key and when, to skip writing it
// again (the Changes view sets its state every poll)
const written = new Map<string, { json: string; at: number }>()
const DAY = 24 * 60 * 60 * 1000
// Each stored draft's size, for DRAFTS_LIMIT
const draftSizes = new Map<string, number>()
const signedOutListeners = new Set<() => void>()
const signedOutHereListeners = new Set<() => void>()
const draftElsewhereListeners = new Set<(key: string) => void>()
// SIGNED_OUT_KEY as this page found it: another value means a tab signed
// out since, even before its storage event arrives here
let signedOutMark: string | null = null

// The storage key of paneId's record of kind (path: a draft's file), null
// when the pane has no key yet
export function persistKey(
  kind: PersistKind,
  paneId: string,
  path?: string,
): string | null {
  const key = paneKeyOf(paneId)
  return key && keyFor(kind, key, path)
}

function keyFor(kind: PersistKind, paneKey: string, path?: string) {
  const tail = path === undefined ? '' : `:${path}`
  return `${PREFIXES[kind]}${paneInstance()}:${paneKey}${tail}`
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// Every storage key of the given kinds
function keysOf(kinds: PersistKind[]): string[] {
  const s = storage()
  if (!s) return []
  const prefixes = kinds.map((k) => PREFIXES[k])
  const out: string[] = []
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && prefixes.some((p) => k.startsWith(p))) out.push(k)
    }
  } catch {
    // Storage that cannot be listed holds nothing for us
  }
  return out
}

function remove(key: string) {
  written.delete(key)
  draftSizes.delete(key)
  try {
    storage()?.removeItem(key)
  } catch {
    // Nothing to remove without storage
  }
}

// Writes value under key: false without storage, or out of room. Callers
// write nothing once signed out.
function write(key: string, value: string): boolean {
  try {
    const s = storage()
    if (!s) return false
    // Another tab signed out after its last check here: nothing is written
    // back after its clear
    if (s.getItem(SIGNED_OUT_KEY) !== signedOutMark) {
      signedOutElsewhere()
      return false
    }
    s.setItem(key, value)
    return true
  } catch {
    return false
  }
}

// The record under key, removed when it is not one (another version,
// broken JSON)
function read<T extends StoredRecord>(key: string): T | null {
  let raw: string | null
  try {
    raw = storage()?.getItem(key) ?? null
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const r = JSON.parse(raw) as T
    if (r && r.v === 1 && typeof r.pane === 'string') return r
  } catch {
    // Removed below
  }
  remove(key)
  return null
}

// The record of paneId under key, or null: one written for another pane
// (a prefix of its key), or for a pane of another group, is not its; the
// latter is removed.
function readFor<T extends StoredRecord>(
  key: string | null,
  paneId: string,
  keepOtherGroup = false,
): T | null {
  // A focus window starts from its link, never from what the main one kept
  if (!key || disabled || isFocusWindow()) return null
  const r = read<T>(key)
  if (!r || r.pane !== paneKeyOf(paneId)) return null
  if (r.group !== paneGroupOf(paneId)) {
    // A draft is left to expire instead: the group may be renamed back
    if (!keepOtherGroup) remove(key)
    return null
  }
  return r
}

function record(paneId: string): StoredRecord {
  return { v: 1, pane: paneKeyOf(paneId)!, group: paneGroupOf(paneId) }
}

// Tabs

// Writes paneId's tab state of kind after TABS_DELAY (null removes it). The
// key is the pane's now: a tmux window move before the write keeps it with
// its pane.
export function saveTabs<T>(
  kind: 'files' | 'changes',
  paneId: string,
  state: T | null,
) {
  const key = persistKey(kind, paneId)
  if (!key || disabled || isFocusWindow()) return
  pending.set(
    key,
    state === null
      ? null
      : ({ ...record(paneId), savedAt: 0, state } satisfies TabsRecord<T>),
  )
  clearTimeout(timer)
  timer = setTimeout(flushAll, TABS_DELAY)
}

// Writes every waiting tab record now (the page is hidden or closing)
export function flushAll() {
  clearTimeout(timer)
  timer = undefined
  if (disabled) return
  const now = Date.now()
  for (const [key, value] of pending) {
    if (value === null) {
      remove(key)
      continue
    }
    const r = value as TabsRecord<unknown>
    const json = JSON.stringify(r)
    // Unchanged: written again once a day, so tabs left open never expire
    const last = written.get(key)
    if (last && last.json === json && now - last.at < DAY) continue
    if (write(key, JSON.stringify({ ...r, savedAt: now })))
      written.set(key, { json, at: now })
  }
  pending.clear()
}

// paneId's tab state of kind, null when none is kept for it
export function loadTabs<T>(
  kind: 'files' | 'changes',
  paneId: string,
): T | null {
  const key = persistKey(kind, paneId)
  if (key && pending.has(key) && !isFocusWindow()) {
    const p = pending.get(key) as TabsRecord<T> | null
    return p?.state ?? null
  }
  return readFor<TabsRecord<T>>(key, paneId)?.state ?? null
}

// Drafts

// Writes paneId's draft of draft.path now, edited at editedAt. False when it
// is not kept: too big, no room, no storage, signed out, no pane key.
export function writeDraft<T extends { path: string }>(
  paneId: string,
  draft: T,
  editedAt: number,
): boolean {
  const key = persistKey('drafts', paneId, draft.path)
  if (!key || disabled || isFocusWindow()) return false
  const value = JSON.stringify({
    ...record(paneId),
    editedAt,
    role: 'full',
    draft,
  } satisfies DraftRecord<T>)
  let others = 0
  for (const [k, n] of draftSizes) if (k !== key) others += n
  if (value.length > DRAFT_LIMIT || others + value.length > DRAFTS_LIMIT) {
    remove(key)
    return false
  }
  if (!write(key, value)) {
    // The older text is not kept either: it would come back over the newer
    remove(key)
    return false
  }
  draftSizes.set(key, value.length)
  return true
}

export function removeDraft(paneId: string, path: string) {
  const key = persistKey('drafts', paneId, path)
  if (key && !isFocusWindow()) remove(key)
}

// Every draft kept for paneId
export function loadDrafts<T>(paneId: string): StoredDraft<T>[] {
  const prefix = persistKey('drafts', paneId, '')
  if (!prefix || disabled || isFocusWindow()) return []
  const out: StoredDraft<T>[] = []
  for (const key of keysOf(['drafts'])) {
    if (!key.startsWith(prefix)) continue
    const r = readFor<DraftRecord<T>>(key, paneId, true)
    if (r && typeof r.editedAt === 'number' && r.draft)
      out.push({ draft: r.draft, editedAt: r.editedAt })
  }
  return out
}

// Removes every kept draft (a view-only client must not hold any)
export function clearDrafts() {
  for (const key of keysOf(['drafts'])) remove(key)
}

// Pane views

export function loadView<T>(paneId: string): T | null {
  return (
    readFor<ViewRecord<T>>(persistKey('view', paneId), paneId)?.view ?? null
  )
}

export function saveView<T>(paneId: string, view: T | null) {
  const key = persistKey('view', paneId)
  if (!key || disabled || isFocusWindow()) return
  if (view === null) {
    remove(key)
    return
  }
  write(
    key,
    JSON.stringify({
      ...record(paneId),
      savedAt: Date.now(),
      view,
    } satisfies ViewRecord<T>),
  )
}

// Files opened lately

const isRecentFile = (f: unknown): f is RecentFile =>
  !!f &&
  typeof (f as RecentFile).root === 'string' &&
  typeof (f as RecentFile).path === 'string'

// paneId's files opened lately, the latest first
export function loadRecent(paneId: string): RecentFile[] {
  const files = readFor<RecentRecord>(
    persistKey('recent', paneId),
    paneId,
  )?.files
  return Array.isArray(files)
    ? files.filter(isRecentFile).slice(0, RECENT_LIMIT)
    : []
}

export function saveRecent(paneId: string, files: RecentFile[]) {
  const key = persistKey('recent', paneId)
  if (!key || disabled || isFocusWindow()) return
  if (!files.length) {
    remove(key)
    return
  }
  write(
    key,
    JSON.stringify({
      ...record(paneId),
      savedAt: Date.now(),
      files: files.slice(0, RECENT_LIMIT),
    } satisfies RecentRecord),
  )
}

// A Zellij group this client renamed from id from to id to, now called
// name: its panes' keys change with it, so do the records kept under them.
export function renamePersistedGroup(
  from: string,
  to: string,
  name: string | null,
) {
  flushAll()
  if (disabled || isFocusWindow()) return
  for (const key of keysOf(ALL_KINDS)) {
    const head = key.slice(0, key.indexOf(':') + 1)
    const rest = key.slice(head.length)
    const instance = rest.slice(0, rest.indexOf(':'))
    if (instance !== paneInstance()) continue
    const r = read<StoredRecord>(key)
    if (!r) continue
    const pane = renamedGroupId(r.pane, from, to)
    if (pane === r.pane) continue
    const tail = rest.slice(instance.length + 1 + r.pane.length)
    const next = `${head}${instance}:${pane}${tail}`
    const value = JSON.stringify({ ...r, pane, group: name })
    const size = draftSizes.get(key)
    remove(key)
    if (write(next, value) && size !== undefined)
      draftSizes.set(next, value.length)
  }
}

// Panes whose group was renamed (tmux, Herdr: their keys stay), each with
// its group's new name: their records follow, so they are not taken for
// another group's when read back.
export function regroupPersisted(names: Map<string, string | null>) {
  if (!names.size) return
  flushAll()
  if (disabled || isFocusWindow()) return
  const prefix = `:${paneInstance()}:`
  for (const key of keysOf(ALL_KINDS)) {
    if (!key.includes(prefix)) continue
    const r = read<StoredRecord>(key)
    if (!r || !names.has(r.pane)) continue
    const value = JSON.stringify({ ...r, group: names.get(r.pane) })
    if (write(key, value) && draftSizes.has(key))
      draftSizes.set(key, value.length)
  }
}

// Signing out

// This tab signed out: nothing is written again, everything kept is
// removed, and the other tabs of the origin are told to do the same.
export function signedOut() {
  disable()
  clearAll()
  try {
    storage()?.setItem(SIGNED_OUT_KEY, String(Date.now()))
  } catch {
    // No other tab shares no storage
  }
  for (const fn of signedOutHereListeners) fn()
}

// Runs fn when this tab signs out; returns the unregister
export function onSignedOutHere(fn: () => void): () => void {
  signedOutHereListeners.add(fn)
  return () => {
    signedOutHereListeners.delete(fn)
  }
}

// Runs fn with the storage key of a draft another tab wrote or removed;
// returns the unregister
export function onDraftChangedElsewhere(fn: (key: string) => void): () => void {
  draftElsewhereListeners.add(fn)
  return () => {
    draftElsewhereListeners.delete(fn)
  }
}

// Signs this page out (its session was revoked here) and shows sign-in
export function signOutPage() {
  signedOut()
  window.location.assign('/login')
}

// Runs fn when another tab of the origin signs out; returns the unregister
export function onSignedOutElsewhere(fn: () => void): () => void {
  signedOutListeners.add(fn)
  return () => {
    signedOutListeners.delete(fn)
  }
}

function disable() {
  disabled = true
  clearTimeout(timer)
  timer = undefined
  pending.clear()
  detach()
}

function clearAll() {
  for (const key of keysOf(ALL_KINDS)) remove(key)
}

// Another tab signed out: this one stops too and forgets what it holds
function signedOutElsewhere() {
  disable()
  clearAll()
  for (const fn of signedOutListeners) fn()
}

function onStorage(e: StorageEvent) {
  if (e.key === SIGNED_OUT_KEY && e.newValue) {
    signedOutElsewhere()
    return
  }
  // Another tab's drafts count towards the limit too
  if (e.key?.startsWith(PREFIXES.drafts)) {
    if (e.newValue === null) draftSizes.delete(e.key)
    else draftSizes.set(e.key, e.newValue.length)
    for (const fn of draftElsewhereListeners) fn(e.key)
  }
}

const onHidden = () => {
  if (document.visibilityState === 'hidden') flushAll()
}

function readMark() {
  try {
    return storage()?.getItem(SIGNED_OUT_KEY) ?? null
  } catch {
    return null
  }
}

function attach() {
  window.addEventListener('pagehide', flushAll)
  window.addEventListener('storage', onStorage)
  document.addEventListener('visibilitychange', onHidden)
}

function detach() {
  window.removeEventListener('pagehide', flushAll)
  document.removeEventListener('visibilitychange', onHidden)
}

// Removes every record older than PERSIST_TTL (a draft by when it was last
// edited, anything else by when it was written) or not readable, and
// measures the drafts left.
export function sweepExpired(now: number) {
  for (const key of keysOf(ALL_KINDS)) {
    const r = read<StoredRecord>(key)
    if (!r) continue
    const draft = key.startsWith(PREFIXES.drafts)
    const at = draft ? r.editedAt : r.savedAt
    if (typeof at !== 'number' || now - at > PERSIST_TTL) {
      remove(key)
      continue
    }
    // As written: the record is stored as JSON.stringify made it
    if (draft) draftSizes.set(key, JSON.stringify(r).length)
  }
}

// For tests: as if the page had just loaded, with nothing kept.
export function resetFilesPersist() {
  disable()
  disabled = false
  written.clear()
  draftSizes.clear()
  signedOutListeners.clear()
  signedOutHereListeners.clear()
  draftElsewhereListeners.clear()
  window.removeEventListener('storage', onStorage)
  clearAll()
  signedOutMark = readMark()
  attach()
}

signedOutMark = readMark()
attach()
// The main window sweeps; a focus window removes nothing
if (!isFocusWindow()) sweepExpired(Date.now())
