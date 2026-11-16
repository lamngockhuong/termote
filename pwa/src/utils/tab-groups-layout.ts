// Where the desktop header shows a workspace's tab groups: their names in the
// tab bar, each before its tabs (inline, like a browser's), or in a row of
// their own above the tab bar, which then shows the picked group's tabs only
// (row).
export const TAB_GROUPS_LAYOUTS = ['inline', 'row'] as const
export type TabGroupsLayout = (typeof TAB_GROUPS_LAYOUTS)[number]

export const DEFAULT_TAB_GROUPS_LAYOUT: TabGroupsLayout = 'inline'

// An edited or future config may hold a layout this version does not know.
export function resolveTabGroupsLayout(value: unknown): TabGroupsLayout {
  return (
    TAB_GROUPS_LAYOUTS.find((l) => l === value) ?? DEFAULT_TAB_GROUPS_LAYOUT
  )
}
