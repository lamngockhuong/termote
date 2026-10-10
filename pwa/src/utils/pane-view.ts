import type { PaneShift } from './pane-remap'

// The view each pane was last left on (Terminal, Chat, Files, Changes) and
// the desktop side panel open next to it, for this tab of the browser, so
// coming back to a pane shows what it showed.

export interface PaneView {
  view: string
  // Side panel view on desktop, null when none is open
  panel: string | null
}

const paneViewKey = (paneId: string) => `termote-pane-view:${paneId}`

export function loadPaneView(paneId: string): PaneView | null {
  try {
    const raw = sessionStorage.getItem(paneViewKey(paneId))
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<PaneView>
    if (typeof v.view !== 'string') return null
    return {
      view: v.view,
      panel: typeof v.panel === 'string' ? v.panel : null,
    }
  } catch {
    return null
  }
}

export function savePaneView(paneId: string, value: PaneView | null) {
  try {
    if (value)
      sessionStorage.setItem(paneViewKey(paneId), JSON.stringify(value))
    else sessionStorage.removeItem(paneViewKey(paneId))
  } catch {
    // A private window without storage starts every pane on the terminal.
  }
}

// Each pane's view follows it to the id it has now, all at once (a shifted
// run is a chain); one whose pane is gone, or whose id now names another
// pane, is dropped.
export function remapPaneViews(shift: PaneShift) {
  const moved = new Map<string, PaneView>()
  for (const [from, to] of shift.moved) {
    const v = loadPaneView(from)
    if (v) moved.set(to, v)
  }
  for (const id of shift.stale) savePaneView(id, null)
  for (const [id, v] of moved) savePaneView(id, v)
}
