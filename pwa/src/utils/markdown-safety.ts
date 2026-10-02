// What makes untrusted markdown safe to render (agent text in the Chat view,
// files in the Files view): raw HTML is shown as the text it is, and only
// http(s) URLs may leave the app.

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

// A remark plugin: raw HTML in the markdown is shown as the text it is.
export function htmlAsText() {
  const walk = (node: MdNode) => {
    if (node.type === 'html') node.type = 'text'
    node.children?.forEach(walk)
  }
  return walk
}

// The URL when it is http(s), else null.
export function safeUrl(url: unknown): URL | null {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}
