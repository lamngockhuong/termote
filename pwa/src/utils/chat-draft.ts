import type { PaneShift } from './pane-remap'
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
}

// A command picked in the command palette for paneId's Chat composer, which
// puts it in front of its draft and takes focus (null: focus only). Held in
// memory, so it reaches a composer that mounts later, and one whose storage
// fails.
const inserts = new Map<string, SlashCommand | null>()
const insertListeners = new Set<() => void>()

export function requestDraftInsert(
  paneId: string,
  command: SlashCommand | null = null,
) {
  inserts.set(paneId, command)
  for (const fn of insertListeners) fn()
}

// What waits for paneId's composer, taken (once): undefined when nothing
export function takeDraftInsert(
  paneId: string,
): SlashCommand | null | undefined {
  const c = inserts.get(paneId)
  inserts.delete(paneId)
  return c
}

// Runs fn when a command is asked for; returns the unregister
export function onDraftInsert(fn: () => void): () => void {
  insertListeners.add(fn)
  return () => {
    insertListeners.delete(fn)
  }
}
