import { describe, expect, it } from 'vitest'
import {
  DESKTOP_STEPS,
  EDGE,
  GAP,
  MOBILE_STEPS,
  placeBubble,
  type Rect,
  stepRect,
  unionRect,
  visibleSteps,
} from './tour-steps'

const r = (top: number, left: number, width = 10, height = 10): Rect => ({
  top,
  left,
  width,
  height,
})

describe('tour steps', () => {
  it('names the anchors the app carries', () => {
    expect(MOBILE_STEPS.map((s) => s.anchors)).toEqual([
      ['session-chip'],
      ['view-menu'],
      ['keyboard-toolbar'],
      ['terminal'],
    ])
    expect(DESKTOP_STEPS.map((s) => s.anchors)).toEqual([
      ['sidebar'],
      ['view-switcher', 'panel-toggles'],
      ['pane-strip', 'session-tabs'],
      ['palette'],
    ])
  })

  it('unionRect holds every rect', () => {
    expect(unionRect([r(10, 20, 30, 5), r(0, 40, 10, 50)])).toEqual(
      r(0, 20, 30, 50),
    )
  })

  it('a step needs its first anchor; the others join when shown', () => {
    const [, views, panes] = DESKTOP_STEPS
    const shown: Record<string, Rect> = {
      'view-switcher': r(0, 100, 50, 30),
      'panel-toggles': r(0, 160, 40, 30),
      'session-tabs': r(40, 0, 500, 30),
    }
    const measure = (a: string) => shown[a] ?? null
    expect(stepRect(views, measure)).toEqual(r(0, 100, 100, 30))
    // One pane: no strip, no step, though the tabs show
    expect(stepRect(panes, measure)).toBeNull()
    expect(visibleSteps(DESKTOP_STEPS, measure).map((s) => s.id)).toEqual([
      'views',
    ])
  })
})

describe('placeBubble', () => {
  const viewport = { width: 390, height: 844 }
  const size = { width: 300, height: 200 }

  it('goes below a target at the top, its arrow under the target', () => {
    const p = placeBubble(r(6, 6, 132, 40), size, viewport, 'bottom')
    expect(p).toMatchObject({ side: 'bottom', top: 6 + 40 + GAP, left: EDGE })
    expect(p.arrow).toBe(72 - EDGE)
  })

  it('turns to the other side without room', () => {
    const p = placeBubble(r(794, 2, 386, 48), size, viewport, 'bottom')
    expect(p).toMatchObject({ side: 'top', top: 794 - GAP - 200 })
    // Centred, within the edges
    expect(p.left).toBe(45)
  })

  it('goes beside the target, then the other sides, in order', () => {
    const wide = { width: 1280, height: 800 }
    expect(placeBubble(r(50, 0, 256, 700), size, wide, 'right')).toMatchObject({
      side: 'right',
      left: 256 + GAP,
      top: 300,
    })
    expect(
      placeBubble(r(50, 1000, 256, 700), size, wide, 'right'),
    ).toMatchObject({ side: 'left', left: 1000 - GAP - 300 })
    // Neither left nor right of a full-width target: below it
    expect(placeBubble(r(10, 0, 1280, 40), size, wide, 'right').side).toBe(
      'bottom',
    )
    // Nor below: above
    expect(placeBubble(r(500, 0, 1280, 290), size, wide, 'left').side).toBe(
      'top',
    )
  })

  it('keeps the arrow on the bubble', () => {
    const p = placeBubble(r(100, 380, 4, 4), size, viewport, 'bottom')
    expect(p.left).toBe(390 - 300 - EDGE)
    expect(p.arrow).toBe(300 - 16)
  })

  it('covers a target that fills the screen, in its middle', () => {
    expect(placeBubble(r(0, 0, 390, 844), size, viewport, 'bottom')).toEqual({
      top: 322,
      left: 45,
      side: null,
      arrow: 0,
    })
  })
})
