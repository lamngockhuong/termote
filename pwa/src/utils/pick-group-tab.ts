// The tab a workspace opens on when picked as a whole (the compact sidebar):
// the one last shown on this device, then the server's current one, then
// its first. An id no longer among tabIds (a closed tab) is passed over:
// hc marks its first tab current whatever the desktop shows, so the tab
// this device remembers comes first.
export function pickGroupTab(
  tabIds: readonly string[],
  last?: string,
  serverActive?: string,
): string | undefined {
  for (const id of [last, serverActive]) {
    if (id !== undefined && tabIds.includes(id)) return id
  }
  return tabIds[0]
}
