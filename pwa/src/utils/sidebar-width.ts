import { MAIN_MIN } from './side-panel-width'

// Width of the expanded desktop sidebar, dragged from its right edge, so a
// name cut short can be read whole.
export const SIDEBAR_DEFAULT = 256
export const SIDEBAR_MIN = 208
export const SIDEBAR_MAX = 560
// One arrow key press on the resize handle
export const SIDEBAR_STEP = 16

// Widest the sidebar can be in a row this wide (null: not measured yet): the
// main area keeps MAIN_MIN. A row too narrow for both keeps the sidebar's
// minimum.
export function maxSidebarWidth(rowWidth: number | null): number {
  if (rowWidth === null) return SIDEBAR_MAX
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, rowWidth - MAIN_MIN))
}

// The width shown for a saved one: within the limits of the row. A saved
// value that is not a number (an edited config) is the default.
export function clampSidebarWidth(
  width: unknown,
  rowWidth: number | null,
): number {
  const w =
    typeof width === 'number' && Number.isFinite(width)
      ? Math.round(width)
      : SIDEBAR_DEFAULT
  return Math.min(Math.max(w, SIDEBAR_MIN), maxSidebarWidth(rowWidth))
}
