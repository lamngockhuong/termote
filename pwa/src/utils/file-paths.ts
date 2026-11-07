// Paths of a file in the Files tree as the user copies or types them. A tree
// path is "/"-separated and relative to the root the tree route returned
// (its "" is the root itself); nothing here goes back to the server.

// A root of a Windows host: a drive (C:\) or a share (\\server\share)
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/

// The last part of a tree path: its name
export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// path on the host: under root, with the host's separator. A symlink stays
// the link's own path, never where it leads.
export function absolutePath(root: string, path: string): string {
  const windows = WINDOWS_ROOT.test(root)
  if (!path) return root
  // A root ending in its separator (C:\, /) does not get a second one
  const base = root.replace(/[\\/]+$/, '')
  if (!windows) return `${base}/${path}`
  return `${base}\\${path}`.replace(/\//g, '\\')
}

// path as the agent in the pane reads it after @: from the pane's directory
// (dir, under root) when the file is below it, or from the root when the
// pane sits at the root (dir ""); otherwise (above or beside the pane's
// directory, in a Place, or where the pane's directory is not known: dir
// null) the absolute path. Claude Code's own completion quotes a path
// with whitespace as @"my notes.txt"; a backslash before the space is not
// taken.
export function mentionPath(o: {
  root: string
  dir?: string | null
  place?: string
  path: string
}): string {
  const { root, dir = '', place, path } = o
  const known = dir !== null && !place
  let at: string
  if (known && path && !dir) at = path
  else if (known && dir && path.startsWith(`${dir}/`))
    at = path.slice(dir.length + 1)
  else at = absolutePath(root, path)
  return /\s/.test(at) ? `@"${at}"` : `@${at}`
}

// Whether text may be typed into a terminal as one word: a name may hold
// anything but NUL, and a line break would run what follows it in a shell
// that takes no bracketed paste; a quote would end the @"…" early.
export const pasteable = (text: string) =>
  ![...text].some((ch) => {
    const code = ch.charCodeAt(0)
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || ch === '"'
  })
