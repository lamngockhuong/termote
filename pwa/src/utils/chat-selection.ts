import { onSignedOutElsewhere, onSignedOutHere } from './files-persist'
import { onPaneRemap, remapEntries } from './pane-remap'

// The text last selected in each pane's Chat transcript, for the
// composer's Quote button. Kept as text, not as the DOM selection: a tap on
// the button (a phone), a message coming in or the transcript drawn again
// drops the selection before the button is used. Forgotten once quoted, on
// a click or tap in the transcript that leaves nothing selected, on leaving
// the pane, on another server and
// on sign-out. Held in memory only, never stored.

const selections = new Map<string, string>()
const listeners = new Set<() => void>()
// The server they were selected on: another one has other panes under the
// same ids
let server: string | null = null

const tell = () => {
  for (const fn of listeners) fn()
}

// Every listener is told when a pane gains or loses its selection, not on
// each step of a drag
function change(fn: () => void) {
  const before = new Set(selections.keys())
  fn()
  const after = new Set(selections.keys())
  if (before.size !== after.size || [...before].some((k) => !after.has(k))) {
    tell()
  }
}

// Keeps text as paneId's selection; null (or whitespace) forgets it.
export function setChatSelection(paneId: string, text: string | null) {
  change(() => {
    if (text?.trim()) selections.set(paneId, text)
    else selections.delete(paneId)
  })
}

// paneId's selection, or ''
export const chatSelection = (paneId: string): string =>
  selections.get(paneId) ?? ''

export const hasChatSelection = (paneId: string): boolean =>
  selections.has(paneId)

// Calls fn when a pane gains or loses its selection; returns the unsubscribe
export function onChatSelection(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const forget = () => change(() => selections.clear())

// The server of the latest snapshot (its instanceId): another one drops
// every selection.
export function setChatSelectionServer(instanceId: string | null) {
  if (instanceId !== server) forget()
  server = instanceId
}

// A selection follows its pane to the id it has now.
onPaneRemap((shift) => change(() => remapEntries(selections, shift)))

onSignedOutHere(forget)
onSignedOutElsewhere(forget)

// For tests: forget every selection and the server, and forget them again
// on sign-out (resetFilesPersist drops the listeners).
export function resetChatSelections() {
  forget()
  server = null
  onSignedOutHere(forget)
  onSignedOutElsewhere(forget)
}
