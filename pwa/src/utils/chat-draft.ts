import type { PaneShift } from './pane-remap'

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
