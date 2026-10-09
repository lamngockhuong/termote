// Zoom and pan of one image in a box, as a transform: a point of the image
// at (px, py) shows at (x + px * scale, y + py * scale) in the box.

export interface Size {
  width: number
  height: number
}
export interface Point {
  x: number
  y: number
}
export interface View {
  // Screen pixels per image pixel
  scale: number
  x: number
  y: number
}
export interface Limits {
  min: number
  max: number
}

// Relative to the scale that fits the image in the box
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 8
// A double tap zooms to this, relative to fit
export const DOUBLE_TAP_ZOOM = 2

// The whole image in the box, centred; never larger than its own size, so
// a small image is not blown up
export function fitView(img: Size, box: Size): View {
  const scale = Math.min(box.width / img.width, box.height / img.height, 1)
  return {
    scale,
    x: (box.width - img.width * scale) / 2,
    y: (box.height - img.height * scale) / 2,
  }
}

export function zoomLimits(img: Size, box: Size): Limits {
  const fit = fitView(img, box).scale
  return { min: fit * MIN_ZOOM, max: fit * MAX_ZOOM }
}

// Scaled by factor (kept within lim) around p, which stays where it is
export function zoomAt(v: View, factor: number, p: Point, lim: Limits): View {
  const scale = Math.min(lim.max, Math.max(lim.min, v.scale * factor))
  const k = scale / v.scale
  return { scale, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k }
}

// One axis: centred when the image is narrower than the box, else never
// leaving an empty band on either side
function clampAxis(at: number, size: number, box: number): number {
  if (size <= box) return (box - size) / 2
  return Math.min(0, Math.max(box - size, at))
}

// The image kept on screen
export function clampView(v: View, img: Size, box: Size): View {
  return {
    scale: v.scale,
    x: clampAxis(v.x, img.width * v.scale, box.width),
    y: clampAxis(v.y, img.height * v.scale, box.height),
  }
}

// Zoomed in past fit: back to fit; else to DOUBLE_TAP_ZOOM around p
export function toggleDoubleTap(v: View, p: Point, img: Size, box: Size): View {
  const fit = fitView(img, box)
  if (v.scale > fit.scale * 1.01) return fit
  const target = fit.scale * DOUBLE_TAP_ZOOM
  return clampView(
    zoomAt(v, target / v.scale, p, zoomLimits(img, box)),
    img,
    box,
  )
}

const LINE = 16
const PAGE = 400

// How much one wheel event zooms. Ctrl is a trackpad pinch (or Ctrl+wheel),
// whose deltas are small, so it counts more per pixel.
export function wheelFactor(
  deltaY: number,
  deltaMode: number,
  ctrl: boolean,
): number {
  const px = deltaY * (deltaMode === 1 ? LINE : deltaMode === 2 ? PAGE : 1)
  return Math.exp(-px * (ctrl ? 0.01 : 0.002))
}
