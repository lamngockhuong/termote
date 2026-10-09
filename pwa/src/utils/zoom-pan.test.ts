import { describe, expect, it } from 'vitest'
import {
  clampView,
  DOUBLE_TAP_ZOOM,
  fitView,
  MAX_ZOOM,
  MIN_ZOOM,
  toggleDoubleTap,
  type View,
  wheelFactor,
  zoomAt,
  zoomLimits,
} from './zoom-pan'

const box = { width: 400, height: 300 }
const big = { width: 1600, height: 600 }
const small = { width: 100, height: 50 }

// Where an image point shows on screen
const onScreen = (v: View, px: number, py: number) => ({
  x: v.x + px * v.scale,
  y: v.y + py * v.scale,
})

describe('fitView', () => {
  it('fits a large image by its tighter side, centred', () => {
    expect(fitView(big, box)).toEqual({ scale: 0.25, x: 0, y: 75 })
  })

  it('never enlarges a small image', () => {
    expect(fitView(small, box)).toEqual({ scale: 1, x: 150, y: 125 })
  })
})

describe('zoomAt', () => {
  const lim = zoomLimits(big, box)

  it('keeps the point under the cursor where it is', () => {
    const v = fitView(big, box)
    const p = { x: 123, y: 210 }
    // The image point under p before
    const px = (p.x - v.x) / v.scale
    const py = (p.y - v.y) / v.scale
    const z = zoomAt(v, 3, p, lim)
    expect(z.scale).toBe(0.75)
    const after = onScreen(z, px, py)
    expect(after.x).toBeCloseTo(p.x)
    expect(after.y).toBeCloseTo(p.y)
  })

  it('stays within the limits, relative to fit', () => {
    const v = fitView(big, box)
    expect(lim).toEqual({ min: 0.25 * MIN_ZOOM, max: 0.25 * MAX_ZOOM })
    expect(zoomAt(v, 1000, { x: 0, y: 0 }, lim).scale).toBe(lim.max)
    expect(zoomAt(v, 0.001, { x: 0, y: 0 }, lim).scale).toBe(lim.min)
  })
})

describe('clampView', () => {
  it('leaves no empty band beside an image larger than the box', () => {
    const v = { scale: 1, x: 50, y: -1000 }
    expect(clampView(v, big, box)).toEqual({ scale: 1, x: 0, y: -300 })
    expect(clampView({ scale: 1, x: -5000, y: 10 }, big, box)).toEqual({
      scale: 1,
      x: -1200,
      y: 0,
    })
    expect(clampView({ scale: 1, x: -100, y: -50 }, big, box)).toEqual({
      scale: 1,
      x: -100,
      y: -50,
    })
  })

  it('centres an image smaller than the box on that axis', () => {
    expect(clampView({ scale: 1, x: 999, y: -999 }, small, box)).toEqual({
      scale: 1,
      x: 150,
      y: 125,
    })
  })
})

describe('toggleDoubleTap', () => {
  it('zooms to 2× fit around the tap, then back to fit', () => {
    const fit = fitView(big, box)
    const p = { x: 200, y: 150 }
    const z = toggleDoubleTap(fit, p, big, box)
    expect(z.scale).toBe(fit.scale * DOUBLE_TAP_ZOOM)
    // The centre of the box stays on the same image point
    const px = (p.x - fit.x) / fit.scale
    expect(onScreen(z, px, 0).x).toBeCloseTo(p.x)
    expect(toggleDoubleTap(z, p, big, box)).toEqual(fit)
  })

  it('zooms in from below fit too', () => {
    const under = { scale: 0.2, x: 0, y: 0 }
    expect(toggleDoubleTap(under, { x: 0, y: 0 }, big, box).scale).toBe(0.5)
  })
})

describe('wheelFactor', () => {
  it('zooms in when scrolling up, out when down', () => {
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1)
    expect(wheelFactor(100, 0, false)).toBeLessThan(1)
    expect(wheelFactor(0, 0, false)).toBe(1)
  })

  it('counts lines and pages as pixels', () => {
    expect(wheelFactor(1, 1, false)).toBeCloseTo(wheelFactor(16, 0, false))
    expect(wheelFactor(1, 2, false)).toBeCloseTo(wheelFactor(400, 0, false))
  })

  it('makes a pinch (Ctrl) count more per pixel', () => {
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(
      wheelFactor(-10, 0, false),
    )
  })
})
