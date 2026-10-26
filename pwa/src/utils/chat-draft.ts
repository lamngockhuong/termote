import { onSignedOutElsewhere, onSignedOutHere } from './files-persist'
import { type PaneShift, remapEntries } from './pane-remap'
import type { SlashCommand } from './slash-commands'

// The Chat view's unsent message, per pane, for this tab of the browser.

const draftKey = (paneId: string) => `termote-chat-draft:${paneId}`

export function loadDraft(paneId: string): string {
  try {
    return sessionStorage.getItem(draftKey(paneId)) ?? ''
  } catch {
    return ''
  }
}

export function saveDraft(paneId: string, text: string) {
  try {
    if (text) sessionStorage.setItem(draftKey(paneId), text)
    else sessionStorage.removeItem(draftKey(paneId))
  } catch {
    // A private window without storage keeps the draft in memory only.
  }
}

// Every draft of this tab, and what waits to be put in one: on sign-out,
// since a draft may hold a template filled with a selection or a path.
export function clearChatDrafts() {
  inserts.clear()
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith(draftKey(''))) sessionStorage.removeItem(key)
  } catch {
    // No storage: nothing kept
  }
}

// Each draft follows its pane to the id it has now, all at once (a shifted
// run is a chain); one whose pane is gone, or whose id now names another
// pane, is dropped. Called on every applied snapshot, since the Chat view
// (which reads them) may not be loaded.
export function remapChatDrafts(shift: PaneShift) {
  const moved = new Map<string, string>()
  for (const [from, to] of shift.moved) {
    const text = loadDraft(from)
    if (text) moved.set(to, text)
  }
  for (const id of shift.stale) saveDraft(id, '')
  for (const [id, text] of moved) saveDraft(id, text)
  remapEntries(inserts, shift)
}

// Text for the draft (a filled prompt template), put where the caret is.
// at: the "/name" typed in the draft that it replaces, when the draft
// still holds was between start and end.
export interface TextInsert {
  text: string
  at?: { start: number; end: number; was: string }
}

// What the command palette or a template asks paneId's Chat composer to put
// in its draft: a command (in front of the draft), text, or nothing (null:
// focus only).
export type DraftInsert = SlashCommand | TextInsert | null

export const isTextInsert = (i: DraftInsert): i is TextInsert =>
  i !== null && 'text' in i

// Held in memory, so it reaches a composer that mounts later, and one whose
// storage fails; it follows its pane when ids shift. agent: the pane's agent
// when it was asked, so another agent started there since never gets it.
const inserts = new Map<string, { item: DraftInsert; agent?: string }>()
const insertListeners = new Set<() => void>()

export function requestDraftInsert(
  paneId: string,
  item: DraftInsert = null,
  agent?: string,
) {
  inserts.set(paneId, { item, agent })
  for (const fn of insertListeners) fn()
}

// What waits for paneId's composer, taken (once): undefined when nothing,
// or when it was asked for another agent than agent
export function takeDraftInsert(
  paneId: string,
  agent?: string,
): DraftInsert | undefined {
  const c = inserts.get(paneId)
  inserts.delete(paneId)
  if (!c || (c.agent !== undefined && c.agent !== agent)) return undefined
  return c.item
}

// Runs fn when a command is asked for; returns the unregister
export function onDraftInsert(fn: () => void): () => void {
  insertListeners.add(fn)
  return () => {
    insertListeners.delete(fn)
  }
}

// Signing out clears them; tests call it again after resetFilesPersist.
export function clearChatDraftsOnSignOut() {
  onSignedOutHere(clearChatDrafts)
  onSignedOutElsewhere(clearChatDrafts)
}
clearChatDraftsOnSignOut()
