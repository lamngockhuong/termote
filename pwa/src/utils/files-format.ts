// Shown sizes and paths of the Files and Changes views.

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

// A root under a home directory as ~/…; the server does not say where home
// is, so the usual places are matched.
export function shortRoot(root: string): string {
  const m = root.match(
    /^(\/home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=$|[/\\])/,
  )
  return m ? `~${root.slice(m[0].length)}` : root
}

// "dir/sub/name" → ["dir/sub/", "name"]
export function splitPath(path: string): [dir: string, name: string] {
  const at = path.lastIndexOf('/') + 1
  return [path.slice(0, at), path.slice(at)]
}

// A long path loses its start, not its end (where the name is): the text runs
// right to left for the ellipsis, with marks that keep it in reading order.
export const TRUNCATE_START = 'truncate text-left [direction:rtl]'
export const keepOrder = (path: string) => `\u200e${path}\u200e`
