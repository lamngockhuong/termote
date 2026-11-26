// Files shown as an Excalidraw drawing: a scene (.excalidraw), a library of
// shapes (.excalidrawlib), an SVG or PNG image with the scene inside
// (.excalidraw.svg, .excalidraw.png), or the Markdown of Obsidian's
// Excalidraw plugin (.excalidraw.md). The name only picks the view: a file
// that holds no drawing says so in it.
export type DrawingKind = 'scene' | 'library' | 'svg' | 'png' | 'obsidian'

const KINDS: Record<string, DrawingKind> = {
  '': 'scene',
  lib: 'library',
  '.svg': 'svg',
  '.png': 'png',
  '.md': 'obsidian',
}

export function drawingKindOf(path: string): DrawingKind | undefined {
  const m = /\.excalidraw(lib|\.svg|\.png|\.md)?$/i.exec(path)
  return m ? KINDS[(m[1] ?? '').toLowerCase()] : undefined
}
