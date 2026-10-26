import type { TextInsert } from './chat-draft'

// A prompt template the user picked for a pane's Chat (from the composer's
// button, its / list or the command palette), waiting for the one fill
// dialog App mounts, which takes it at once. One at a time: a new pick
// replaces the last.

export interface TemplateFill {
  paneId: string
  templateId: string
  // The pane's agent when it was picked: the text goes to that agent only
  agent?: string
  // The "/name" typed in the draft that the text replaces
  at?: TextInsert['at']
}

let pending: TemplateFill | null = null
const listeners = new Set<() => void>()
const tell = () => {
  for (const fn of listeners) fn()
}

export function requestTemplateFill(fill: TemplateFill) {
  pending = fill
  tell()
}

// The pick that waits, taken (once): null when none
export function takeTemplateFill(): TemplateFill | null {
  const p = pending
  pending = null
  return p
}

// Runs fn when a template is picked; returns the unregister
export function onTemplateFill(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
