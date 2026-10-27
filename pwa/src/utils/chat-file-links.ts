// The file paths an agent writes in the Chat view, as places in the pane's
// Files view: which inline code is a path (and the line it names), and the
// path under the pane's root a path the agent wrote is. No React: plain
// functions.

export interface FileRef {
  path: string
  // The first line named: ":12", ":12:5", ":12-20", "#L12"
  line?: number
}

// A drive ("C:/", "C:\") or a "/" at the start
const ABSOLUTE = /^(?:[A-Za-z]:)?[\\/]/
// Characters a path the agent means rarely holds, and code often does: a
// glob, a call, an assignment, a shell word
const NOT_A_PATH = /[\s*?<>|"'`$(){}[\],;=]/

function lineOf(s: string | undefined) {
  const n = s ? Number(s) : 0
  return n > 0 ? n : undefined
}

// The path inline code names, or null when it does not look like one.
// link: the text is a Markdown link's href, which is a path by being a link;
// inline code is one only when it names a file (its last part has a dot),
// says where it starts ("/", "./", "../") or names a line. "and/or",
// "text/html" or "owner/repo" are not.
export function parseFileRef(text: string, link = false): FileRef | null {
  let s = text.trim()
  if (!s || s.length > 1024) return null
  // A scheme (a URL), except a Windows drive or a line ("Makefile:3");
  // another host without one
  if (
    /^[a-z][a-z\d+.-]*:(?!\d+(?::\d+)?(?:-\d+)?$)/i.test(s) &&
    !/^[A-Za-z]:[\\/]/.test(s)
  )
    return null
  if (s.startsWith('//') || s.startsWith('~')) return null
  let line: number | undefined
  const hash = s.indexOf('#')
  if (hash >= 0) {
    line = lineOf(s.slice(hash + 1).match(/^L(\d+)(?:-L?\d+)?$/)?.[1])
    s = s.slice(0, hash)
  }
  const at = s.match(/:(\d+)(?::\d+)?(?:-\d+)?$/)
  if (at) {
    line ??= lineOf(at[1])
    s = s.slice(0, at.index)
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  if (!s || /[\0-\x1f]/.test(s)) return null
  if (!link) {
    if (NOT_A_PATH.test(s)) return null
    if (!/[\\/]/.test(s) || !/[A-Za-z_]/.test(s)) return null
    const name = s.split(/[\\/]/).pop() ?? ''
    const named = /.\.[^.]+$/.test(name) || /^\.[^.]/.test(name)
    if (!named && !ABSOLUTE.test(s) && !/^\.\.?[\\/]/.test(s) && !line)
      return null
  }
  return { path: s, ...(line && { line }) }
}

// A Markdown link's href as a file, or null for a URL, another host or an
// anchor of the same message
export function fileRefFromHref(href: string | undefined): FileRef | null {
  if (!href || href.startsWith('#')) return null
  let s = href.replace(/\?[^#]*/, '')
  try {
    s = decodeURIComponent(s)
  } catch {
    return null
  }
  return parseFileRef(s, true)
}

export const isAbsolutePath = (path: string) => ABSOLUTE.test(path)

// path under root ("/"-separated, "" for the root itself), or null when it
// is elsewhere or steps out of it. A relative path is taken from the root.
// On Windows (a root with a drive) "\" and "/" are the same and case does
// not matter.
export function underRoot(path: string, root: string): string | null {
  const p = path.replace(/\\/g, '/')
  let rest = p
  if (isAbsolutePath(path)) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!r) return null
    const windows = /^[A-Za-z]:/.test(r)
    const same = (a: string, b: string) =>
      windows ? a.toLowerCase() === b.toLowerCase() : a === b
    if (same(p, r)) return ''
    const head = p.slice(0, r.length + 1)
    if (!same(head, `${r}/`)) return null
    rest = p.slice(r.length + 1)
  }
  const parts: string[] = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(seg)
    }
  }
  return parts.join('/')
}
