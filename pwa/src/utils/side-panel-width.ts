// Width of the desktop side panel (Files, Changes), dragged from its left edge.
export const SIDE_PANEL_DEFAULT = 440
export const SIDE_PANEL_MIN = 320
// Room the terminal or the Chat view always keeps next to the panel
export const MAIN_MIN = 360
// One arrow key press on the resize handle
export const SIDE_PANEL_STEP = 16

// Widest the panel can be in a row this wide (null: not measured yet).
// A row too narrow for both minimums keeps the panel's.
export function maxPanelWidth(rowWidth: number | null): number {
  if (rowWidth === null) return Number.POSITIVE_INFINITY
  return Math.max(SIDE_PANEL_MIN, rowWidth - MAIN_MIN)
}

// The width shown for a saved one: within the limits of the row. A saved
// value that is not a number (an edited config) is the default.
export function clampPanelWidth(
  width: unknown,
  rowWidth: number | null,
): number {
  const w =
    typeof width === 'number' && Number.isFinite(width)
      ? Math.round(width)
      : SIDE_PANEL_DEFAULT
  return Math.min(Math.max(w, SIDE_PANEL_MIN), maxPanelWidth(rowWidth))
}
