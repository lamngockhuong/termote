import { onSignedOutElsewhere, onSignedOutHere } from './files-persist'
import { destination, type PaneShift } from './pane-remap'

// The review being written for a pane's changes, for this tab of the
// browser: comments on line ranges of a diff or a file, sent to an agent
// as one message (utils/review-message.ts).

export type ReviewSource = 'unstaged' | 'staged' | 'file'

export interface ReviewComment {
  id: string
  // The pane's folder when the comment was made; path is relative to it
  root: string
  path: string
  // A renamed file's old path, as its diff was listed
  orig?: string
  source: ReviewSource
  // The range, as the new side numbers it (a file: its lines)
  start: number
  end: number
  // The deleted lines in the range, as the old side numbers them
  removed?: { start: number; end: number }
  // The range has deleted lines only: start and end are where they were
  // removed
  removedOnly?: boolean
  // The lines when commented (a diff's keep their ' ', '+', '-'); never for
  // a sensitive file
  quote?: string
  sensitive?: boolean
  // Made in an editor with unsaved edits: quote is the edited text
  unsaved?: boolean
  text: string
  at: number
}

// What a comment is made on, before its text
export type ReviewTarget = Omit<ReviewComment, 'id' | 'text' | 'at'>

export const MAX_REVIEW_COMMENTS = 50
export const MAX_COMMENT_BYTES = 4 * 1024

const draftKey = (paneId: string) => `termote-review:${paneId}`

const EMPTY: ReviewComment[] = []

// What was read or written per pane: the snapshot the views share, and
// what is kept when storage fails
const cache = new Map<string, ReviewComment[]>()
const listeners = new Set<() => void>()
let warned = false

const isRange = (r: unknown): boolean =>
  typeof r === 'object' &&
  r !== null &&
  typeof (r as { start: unknown }).start === 'number' &&
  typeof (r as { end: unknown }).end === 'number'

const optional = (v: unknown, type: string) =>
  v === undefined || typeof v === type

function isComment(c: unknown): c is ReviewComment {
  if (typeof c !== 'object' || c === null) return false
  const o = c as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.root === 'string' &&
    typeof o.path === 'string' &&
    optional(o.orig, 'string') &&
    (o.source === 'unstaged' || o.source === 'staged' || o.source === 'file') &&
    isRange(o) &&
    (o.removed === undefined || isRange(o.removed)) &&
    optional(o.removedOnly, 'boolean') &&
    optional(o.quote, 'string') &&
    optional(o.sensitive, 'boolean') &&
    optional(o.unsaved, 'boolean') &&
    typeof o.text === 'string' &&
    typeof o.at === 'number'
  )
}

// What storage holds for paneId; anything not written by this version, or
// not whole, is nothing
function read(paneId: string): ReviewComment[] {
  try {
    const raw = sessionStorage.getItem(draftKey(paneId))
    if (!raw) return EMPTY
    const data = JSON.parse(raw) as { v?: unknown; comments?: unknown }
    if (data?.v !== 1 || !Array.isArray(data.comments)) return EMPTY
    return data.comments.every(isComment) ? data.comments : EMPTY
  } catch {
    return EMPTY
  }
}

// The comments of paneId's review, oldest first: the same array until one
// changes
export function loadReview(paneId: string): ReviewComment[] {
  let list = cache.get(paneId)
  if (!list) {
    list = read(paneId)
    cache.set(paneId, list)
  }
  return list
}

// Keeps list as paneId's review. Returns false when storage refused it
// (kept in memory, for this page only).
function write(paneId: string, list: ReviewComment[]): boolean {
  cache.set(paneId, list.length ? list : EMPTY)
  let kept = true
  try {
    if (list.length)
      sessionStorage.setItem(
        draftKey(paneId),
        JSON.stringify({ v: 1, comments: list }),
      )
    else sessionStorage.removeItem(draftKey(paneId))
  } catch {
    kept = false
  }
  for (const fn of listeners) fn()
  return kept
}

// Adds c to paneId's review. too_many: the review is full, nothing added.
// memory: added, but storage refused it, said once per page (it is gone
// after a reload).
export function addReviewComment(
  paneId: string,
  c: ReviewComment,
): 'ok' | 'too_many' | 'memory' {
  const list = loadReview(paneId)
  if (list.length >= MAX_REVIEW_COMMENTS) return 'too_many'
  // A sensitive file's lines never reach storage
  const { quote, ...rest } = c
  const kept = write(paneId, [...list, c.sensitive ? rest : c])
  if (kept || warned) return 'ok'
  warned = true
  return 'memory'
}

export function updateReviewComment(paneId: string, id: string, text: string) {
  const list = loadReview(paneId)
  if (!list.some((c) => c.id === id)) return
  write(
    paneId,
    list.map((c) => (c.id === id ? { ...c, text } : c)),
  )
}

// Removes the comments with these ids (the ones sent: others added since
// stay)
export function removeReviewComments(paneId: string, ids: Iterable<string>) {
  const drop = new Set(ids)
  const list = loadReview(paneId)
  const rest = list.filter((c) => !drop.has(c.id))
  if (rest.length !== list.length) write(paneId, rest)
}

// Runs fn when any review changes; returns the unregister
export function onReviewChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// Each review follows its pane to the id it has now, all at once (a shifted
// run is a chain); one whose pane is gone, or whose id now names another
// pane, is dropped. Called on every applied snapshot.
export function remapReviewDrafts(shift: PaneShift) {
  const moved = new Map<string, ReviewComment[]>()
  for (const id of shift.stale) {
    const list = loadReview(id)
    const to = destination(shift, id)
    if (list.length && to !== null) moved.set(to, list)
  }
  for (const id of shift.stale) write(id, moved.get(id) ?? EMPTY)
}

// Every review of this tab: on sign-out, since a comment quotes the files
export function clearReviewDrafts() {
  cache.clear()
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith(draftKey(''))) sessionStorage.removeItem(key)
  } catch {
    // No storage: nothing kept
  }
  for (const fn of listeners) fn()
}

// For tests: forget what was read, and that storage failed.
export function resetReviewDrafts() {
  cache.clear()
  warned = false
}

// Signing out clears them; tests call it again after resetFilesPersist.
export function clearReviewDraftsOnSignOut() {
  onSignedOutHere(clearReviewDrafts)
  onSignedOutElsewhere(clearReviewDrafts)
}
clearReviewDraftsOnSignOut()

const range = (start: number, end: number) =>
  Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i)

// The lines of a diff (root, path, staged or not) a comment is on:
// `n:<new line>`, `o:<old line>` for a deleted one
export function commentedDiffLines(
  comments: ReviewComment[],
  root: string | undefined,
  path: string,
  source: ReviewSource,
): Set<string> {
  const out = new Set<string>()
  for (const c of comments) {
    if (c.root !== root || c.path !== path || c.source !== source) continue
    if (!c.removedOnly) for (const n of range(c.start, c.end)) out.add(`n:${n}`)
    if (c.removed)
      for (const n of range(c.removed.start, c.removed.end)) out.add(`o:${n}`)
  }
  return out
}

// The lines of a file (root, path) a comment is on
export function commentedFileLines(
  comments: ReviewComment[],
  root: string | undefined,
  path: string,
): Set<number> {
  const out = new Set<number>()
  for (const c of comments)
    if (c.root === root && c.path === path && c.source === 'file')
      for (const n of range(c.start, c.end)) out.add(n)
  return out
}
