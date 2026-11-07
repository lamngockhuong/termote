// Where the desktop's view, panel, pane, fullscreen and palette buttons go:
// in the header row beside the tabs (header), or on a bar down the right
// edge, leaving the header to the tabs (right). A phone keeps its header.
export const TOOLBAR_POSITIONS = ['header', 'right'] as const
export type ToolbarPosition = (typeof TOOLBAR_POSITIONS)[number]

export const DEFAULT_TOOLBAR_POSITION: ToolbarPosition = 'header'

// An edited or future config may hold a position this version does not know.
export function resolveToolbarPosition(value: unknown): ToolbarPosition {
  return TOOLBAR_POSITIONS.find((p) => p === value) ?? DEFAULT_TOOLBAR_POSITION
}
