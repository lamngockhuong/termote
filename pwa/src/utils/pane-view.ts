import { loadView, saveView } from './files-persist'

// The view each pane was last left on (Terminal, Chat, Files, Changes) and
// the desktop side panel open next to it, on this device, so coming back to
// a pane (or to the app) shows what it showed. Kept under the pane's key
// (files-persist.ts): a pane without one (before a snapshot) keeps nothing.

export interface PaneView {
  view: string
  // Side panel view on desktop, null when none is open
  panel: string | null
}

export function loadPaneView(paneId: string): PaneView | null {
  const v = loadView<Partial<PaneView>>(paneId)
  if (typeof v?.view !== 'string') return null
  return {
    view: v.view,
    panel: typeof v.panel === 'string' ? v.panel : null,
  }
}

export function savePaneView(paneId: string, value: PaneView | null) {
  saveView(paneId, value)
}
