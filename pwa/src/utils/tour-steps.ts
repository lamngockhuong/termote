import type { MessageKey } from '../i18n/messages/en'

// Where the bubble goes from what it points at; it turns to the other side
// when that one has no room
export type Placement = 'top' | 'bottom' | 'left' | 'right'

// What a step adds under its text
export type TourExtra = 'views' | 'gestures' | 'panelViews' | 'keys'

export interface TourStep {
  id: string
  // data-tour names. The first must be on screen for the step to show; the
  // others join the lit area when they are.
  anchors: string[]
  title: MessageKey
  body?: MessageKey
  extra?: TourExtra
  placement: Placement
}

export const MOBILE_STEPS: TourStep[] = [
  {
    id: 'sessions',
    anchors: ['session-chip'],
    title: 'tour.chipTitle',
    body: 'tour.chipBody',
    placement: 'bottom',
  },
  {
    id: 'views',
    anchors: ['view-menu'],
    title: 'tour.viewMenuTitle',
    body: 'tour.viewMenuBody',
    extra: 'views',
    placement: 'bottom',
  },
  {
    id: 'toolbar',
    anchors: ['keyboard-toolbar'],
    title: 'tour.toolbarTitle',
    body: 'tour.toolbarBody',
    placement: 'top',
  },
  {
    id: 'gestures',
    anchors: ['terminal'],
    title: 'tour.gesturesTitle',
    extra: 'gestures',
    placement: 'bottom',
  },
]

export const DESKTOP_STEPS: TourStep[] = [
  {
    id: 'sessions',
    anchors: ['sidebar'],
    title: 'tour.sidebarTitle',
    body: 'tour.sidebarBody',
    placement: 'right',
  },
  {
    id: 'views',
    anchors: ['view-switcher', 'panel-toggles'],
    title: 'tour.viewsTitle',
    extra: 'panelViews',
    placement: 'bottom',
  },
  {
    id: 'panes',
    anchors: ['pane-strip', 'session-tabs'],
    title: 'tour.panesTitle',
    body: 'tour.panesBody',
    placement: 'bottom',
  },
  {
    id: 'palette',
    anchors: ['palette'],
    title: 'tour.paletteTitle',
    body: 'tour.paletteBody',
    extra: 'keys',
    placement: 'bottom',
  },
]

export interface Rect {
  top: number
  left: number
  width: number
  height: number
}

// The area that holds every rect
export function unionRect(rects: Rect[]): Rect {
  const top = Math.min(...rects.map((r) => r.top))
  const left = Math.min(...rects.map((r) => r.left))
  const bottom = Math.max(...rects.map((r) => r.top + r.height))
  const right = Math.max(...rects.map((r) => r.left + r.width))
  return { top, left, width: right - left, height: bottom - top }
}

// The area of a step's anchors on screen, or null when its first is not
// (hidden, or of no size)
export function stepRect(
  step: TourStep,
  measure: (anchor: string) => Rect | null,
): Rect | null {
  const rects = step.anchors.map(measure)
  if (!rects[0]) return null
  return unionRect(rects.filter((r): r is Rect => r !== null))
}

// The steps that can show now
export function visibleSteps(
  steps: TourStep[],
  measure: (anchor: string) => Rect | null,
): TourStep[] {
  return steps.filter((s) => stepRect(s, measure) !== null)
}

// Room kept between the bubble and the screen's edge, and its target
export const EDGE = 16
export const GAP = 12

export interface BubblePosition {
  top: number
  left: number
  // The side of its target the bubble sits on (its arrow on the facing
  // edge), and how far along that edge the arrow is (px); null when no side
  // had room and the bubble covers its target
  side: Placement | null
  arrow: number
}

const OPPOSITE: Record<Placement, Placement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), Math.max(min, max))

// Where a bubble of size goes for target in a viewport: the preferred side,
// else its opposite, else the other two, else over the target; always
// inside the viewport, EDGE from its edges
export function placeBubble(
  target: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  prefer: Placement,
): BubblePosition {
  const room: Record<Placement, number> = {
    top: target.top - GAP - EDGE,
    bottom: viewport.height - (target.top + target.height) - GAP - EDGE,
    left: target.left - GAP - EDGE,
    right: viewport.width - (target.left + target.width) - GAP - EDGE,
  }
  const need = (side: Placement) =>
    side === 'top' || side === 'bottom' ? size.height : size.width
  const order: Placement[] = [
    prefer,
    OPPOSITE[prefer],
    ...(['bottom', 'top', 'right', 'left'] as Placement[]).filter(
      (p) => p !== prefer && p !== OPPOSITE[prefer],
    ),
  ]
  const side = order.find((p) => room[p] >= need(p)) ?? null
  const maxLeft = viewport.width - size.width - EDGE
  const maxTop = viewport.height - size.height - EDGE
  const centerX = target.left + target.width / 2
  const centerY = target.top + target.height / 2
  if (side === 'top' || side === 'bottom') {
    const left = clamp(centerX - size.width / 2, EDGE, maxLeft)
    const top =
      side === 'top'
        ? target.top - GAP - size.height
        : target.top + target.height + GAP
    return {
      top,
      left,
      side,
      arrow: clamp(centerX - left, 16, size.width - 16),
    }
  }
  if (side === 'left' || side === 'right') {
    const top = clamp(centerY - size.height / 2, EDGE, maxTop)
    const left =
      side === 'left'
        ? target.left - GAP - size.width
        : target.left + target.width + GAP
    return {
      top,
      left,
      side,
      arrow: clamp(centerY - top, 16, size.height - 16),
    }
  }
  // No side has room (a target filling the screen): in its middle
  return {
    top: clamp(centerY - size.height / 2, EDGE, maxTop),
    left: clamp(centerX - size.width / 2, EDGE, maxLeft),
    side: null,
    arrow: 0,
  }
}
