// How the desktop sidebar lists workspaces: each with its tabs under it
// (detailed), or one line per workspace with the tabs in the header and the
// running agents gathered below (compact). A phone's sheet is always detailed.
export const SIDEBAR_LAYOUTS = ['detailed', 'compact'] as const
export type SidebarLayout = (typeof SIDEBAR_LAYOUTS)[number]

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = 'detailed'

// An edited or future config may hold a layout this version does not know.
export function resolveSidebarLayout(value: unknown): SidebarLayout {
  return SIDEBAR_LAYOUTS.find((l) => l === value) ?? DEFAULT_SIDEBAR_LAYOUT
}
