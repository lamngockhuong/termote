// An image pasted into a Markdown file being edited: a placeholder goes in
// at the cursor while it is saved next to the file, then becomes a link to
// it. Plain functions; the paste itself is the viewer's (file-viewer.tsx).

// What an editor offers a pasted image: text put in at the cursor, then that
// text replaced where it is now. replace is false once the editor is gone or
// the text is no longer there; the viewer changes the draft instead.
export interface PasteEdit {
  insert: (text: string) => void
  replace: (find: string, with_: string) => boolean
}

// The directory of a path under the root, "." for the root itself
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '.' : path.slice(0, i)
}

// A part of a link's path, encoded; brackets too, which encodeURIComponent
// leaves and a lone ")" would end the link at
function encodePart(part: string): string {
  return encodeURIComponent(part).replace(
    /[()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

// The Markdown that shows the image saved at saved (under the root) from the
// file at mdPath: relative to the file's directory, each part encoded so a
// space or a bracket keeps the link whole; its name without the extension as
// the text
export function imageLink(mdPath: string, saved: string): string {
  const from = mdPath.split('/').slice(0, -1)
  const to = saved.split('/')
  let same = 0
  while (same < from.length && same < to.length - 1 && from[same] === to[same])
    same++
  const parts = [
    ...from.slice(same).map(() => '..'),
    ...to.slice(same).map(encodePart),
  ]
  const name = to[to.length - 1]
  const dot = name.lastIndexOf('.')
  const alt = (dot > 0 ? name.slice(0, dot) : name).replace(/[[\]\\]/g, '')
  return `![${alt}](${parts.join('/')})`
}

// A token no text typed meanwhile holds: the placeholder of one paste. Not
// crypto.randomUUID: over plain HTTP (a LAN address) it is missing.
export function pasteToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

// What stands in for the image while it is saved: valid Markdown (an image
// with no source), so a save meanwhile keeps a file that still renders
export function placeholder(token: string): string {
  return `![Uploading ${token}…]()`
}

// text with the placeholder of token replaced by with ("" drops it), and
// whether it was there to replace (the user may have undone or deleted it)
export function replacePlaceholder(
  text: string,
  token: string,
  with_: string,
): { text: string; found: boolean } {
  const ph = placeholder(token)
  const i = text.indexOf(ph)
  if (i < 0) return { text, found: false }
  return {
    text: text.slice(0, i) + with_ + text.slice(i + ph.length),
    found: true,
  }
}
