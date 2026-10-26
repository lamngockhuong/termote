import { onSignedOutElsewhere, onSignedOutHere } from './files-persist'
import { onPaneRemap, remapEntries } from './pane-remap'
import { MAX_TEMPLATE_TEXT, templateBytes } from './prompt-templates'

// The latest text selected for each pane, wherever it was selected (the
// terminal, a file, the Chat transcript), for a prompt template's
// {{selection}}: the user selects, then opens the Chat to use it. Held in
// memory only, never stored, and forgotten on sign-out.

export interface PaneSelection {
  text: string
  // Where it was selected, for the fill dialog: "the terminal", a path
  source: string
}

const selections = new Map<string, PaneSelection>()
// The server they were selected on: another one on the same origin has
// other panes under the same ids
let server: string | null = null

// text cut to MAX_TEMPLATE_TEXT bytes, never inside a character
function cut(text: string): string {
  if (templateBytes(text) <= MAX_TEMPLATE_TEXT) return text
  const bytes = new TextEncoder().encode(text)
  let end = MAX_TEMPLATE_TEXT
  // Back to the first byte of the character the cut falls in
  while ((bytes[end] & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end))
}

// Records text as paneId's latest selection; an empty one (a selection
// cleared) keeps the one before.
export function recordSelection(paneId: string, text: string, source: string) {
  if (!text.trim()) return
  selections.set(paneId, { text: cut(text), source })
}

// paneId's latest selection, or null
export const paneSelection = (paneId: string): PaneSelection | null =>
  selections.get(paneId) ?? null

// The server of the latest snapshot (its instanceId): another one drops
// every selection.
export function setSelectionServer(instanceId: string | null) {
  if (instanceId !== server) selections.clear()
  server = instanceId
}

// A selection follows its pane to the id it has now.
onPaneRemap((shift) => remapEntries(selections, shift))

const forget = () => selections.clear()
onSignedOutHere(forget)
onSignedOutElsewhere(forget)

// For tests: forget every selection, and forget them again on sign-out
// (resetFilesPersist drops the listeners).
export function resetPaneSelections() {
  forget()
  onSignedOutHere(forget)
  onSignedOutElsewhere(forget)
}
