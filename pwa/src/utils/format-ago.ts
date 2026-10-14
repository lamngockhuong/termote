// How long ago, in whole minutes then hours: "just now", "3 min ago",
// "2 h ago".
export function formatAgo(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  return `${Math.floor(min / 60)} h ago`
}
