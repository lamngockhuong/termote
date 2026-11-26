import { type LinkTarget, resolveLink } from './markdown-links'

// Where the link of a drawing's element goes, read from the drawing at
// from: an Obsidian wiki link ("[[Note]]", "[[Note#Heading|shown]]",
// "![[Note]]") names a file beside the drawing, a Markdown note when it has
// no extension; any other link is read as a Markdown file's link is (a web
// page, a file under the root, never one that leaves it).
export function drawingLink(link: string, from: string): LinkTarget {
  const href = link.trim()
  const wiki = /^!?\[\[([^\]|]*)(?:\|[^\]]*)?\]\]$/.exec(href)
  if (!wiki) return resolveLink(href, from)
  const hash = wiki[1].indexOf('#')
  const name = (hash < 0 ? wiki[1] : wiki[1].slice(0, hash)).trim()
  const heading = hash < 0 ? '' : wiki[1].slice(hash + 1).trim()
  if (!name) return { kind: 'none' }
  const file = /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.md`
  const path = file.split('/').map(encodeURIComponent).join('/')
  return resolveLink(
    heading ? `${path}#${encodeURIComponent(heading)}` : path,
    from,
  )
}
