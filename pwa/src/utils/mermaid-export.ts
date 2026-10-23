// A drawn Mermaid diagram taken out of the preview: as a PNG through the
// share sheet or the clipboard (what a note app takes as a picture), or as
// its SVG file. Everything comes from the data: URL already on screen: the
// PNG is that image drawn on a canvas, the SVG that URL decoded, and nothing
// is fetched (connect-src has no data:).
import {
  BLOB_REVOKE_MS,
  isIosStandalone,
  shareFile,
  startDownload,
} from './download-file'
import type { MermaidImage } from './mermaid-render'
import { UNSAFE_CHARS } from './unsafe-chars'

// The PNG is twice the diagram's size, less when that would pass what iOS
// can draw on one canvas (about 16.7 million pixels): past it the canvas
// stays blank.
export const MAX_PIXELS = 16_000_000
export const MAX_SIDE = 16_384

// The clipboard and the share sheet exist in a secure context only (HTTPS
// or localhost): a page opened over plain HTTP gets the SVG download alone.
export function canCopyImage(): boolean {
  return (
    window.isSecureContext &&
    typeof ClipboardItem === 'function' &&
    typeof navigator.clipboard?.write === 'function' &&
    (ClipboardItem.supports?.('image/png') ?? true)
  )
}

export function canShareImage(): boolean {
  if (!window.isSecureContext || typeof navigator.share !== 'function')
    return false
  const probe = new File([], 'diagram.png', { type: 'image/png' })
  return navigator.canShare?.({ files: [probe] }) === true
}

export function exportScale(width: number, height: number): number {
  return Math.min(
    2,
    Math.sqrt(MAX_PIXELS / (width * height)),
    MAX_SIDE / Math.max(width, height),
  )
}

// The PNGs made last, by URL: a share the browser refused (the tap's
// activation ran out while drawing) is shared at once from the next tap.
const CACHE_SIZE = 4
const pngs = new Map<string, Promise<Blob>>()

async function drawPng(image: MermaidImage): Promise<Blob> {
  const img = new Image()
  img.src = image.url
  // Safari can draw an SVG blank right after it loads: decode first
  await img.decode()
  const scale = exportScale(image.width, image.height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  try {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.fillStyle = image.background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    )
    if (!blob) throw new Error('canvas too large')
    return blob
  } finally {
    // iOS keeps a canvas's memory until its size is zero
    canvas.width = 0
    canvas.height = 0
  }
}

export function pngOf(image: MermaidImage): Promise<Blob> {
  const hit = pngs.get(image.url)
  if (hit) {
    pngs.delete(image.url)
    pngs.set(image.url, hit)
    return hit
  }
  const png = drawPng(image)
  pngs.set(image.url, png)
  if (pngs.size > CACHE_SIZE) pngs.delete(pngs.keys().next().value as string)
  // A failed drawing is tried again next time
  png.catch(() => {
    if (pngs.get(image.url) === png) pngs.delete(image.url)
  })
  return png
}

// The SVG of the diagram's data: URL, as svgToDataUrl wrote it, with the
// background it is shown on: Pele paints none, and a dark diagram opened on
// a white page would be light grey on white
export function svgBlob(image: MermaidImage): Blob {
  const url = image.url
  const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1)).replace(
    /<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/,
    (tag) =>
      /\sstyle="/.test(tag)
        ? tag.replace(/\sstyle="/, ` style="background:${image.background};`)
        : tag.replace(/>$/, ` style="background:${image.background}">`),
  )
  return new Blob([svg], { type: 'image/svg+xml' })
}

// The name a diagram is saved as, without its extension: the Markdown
// file's name and the diagram's number, the characters that could make
// one name pose as another removed
export function exportName(path: string, index: number): string {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(UNSAFE_CHARS, '')
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem ? `${stem}-mermaid-${index}` : `mermaid-${index}`
}

// The actions below never throw: each tells the user what happened.

export async function sharePng(
  image: MermaidImage,
  name: string,
  notify: (message: string) => void,
): Promise<void> {
  try {
    const png = await pngOf(image)
    const file = new File([png], `${name}.png`, { type: 'image/png' })
    if ((await shareFile(navigator, file)) === 'blocked')
      notify('Diagram ready: tap Share again')
  } catch {
    notify('Could not share the diagram')
  }
}

// Call it straight from the click: Safari takes the clipboard only when the
// ClipboardItem is made in the tap, with the PNG still to come as a promise.
export async function copyPng(
  image: MermaidImage,
  notify: (message: string) => void,
): Promise<void> {
  try {
    const item = new ClipboardItem({ 'image/png': pngOf(image) })
    await navigator.clipboard.write([item])
    notify('Diagram copied')
  } catch {
    notify('Could not copy the diagram')
  }
}

// A link to a blob: URL; in the iOS home-screen app, where a link with
// download does nothing, the share sheet ("Save to Files").
export async function downloadSvg(
  image: MermaidImage,
  name: string,
  notify: (message: string) => void,
  iosStandalone = isIosStandalone(),
): Promise<void> {
  const blob = svgBlob(image)
  const href = URL.createObjectURL(blob)
  try {
    await startDownload(href, `${name}.svg`, {
      iosStandalone,
      fetchBlob: async () => blob,
      nav: navigator,
      onShareBlocked: () => notify('Diagram ready: tap Download again'),
    })
  } catch {
    notify('Could not download the diagram')
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), BLOB_REVOKE_MS)
  }
}

// For tests: forget the PNGs made.
export function resetMermaidExport() {
  pngs.clear()
}
