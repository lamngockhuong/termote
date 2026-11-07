import { useCallback, useRef, useState } from 'react'

// Room the tabs must have beyond the labels' width before the labels come
// back, so a width near the edge does not flip them on and off
export const LABEL_SLACK = 24

// Marks a label that the header hides when its tabs run out of room
export const COMPACT_LABEL_ATTR = 'data-header-label'

// Whether the header's view and panel buttons show their icon only. spare:
// the room left after the last tab (negative: the tabs overflow).
// labelWidth: the room the labels took when they were last shown. Hidden
// once the tabs overflow; shown again only once the tabs would still fit
// with them.
export function nextCompact(
  prev: boolean,
  spare: number,
  labelWidth: number,
): boolean {
  if (!prev) return spare < 0
  return spare < labelWidth + LABEL_SLACK
}

// The room the shown labels inside el take: each label and the gap before
// it. null when a label is already hidden (the header is narrower than
// 60rem and hides them itself) or there is none, so nothing is measured.
export function measureLabels(el: HTMLElement | null): number | null {
  const labels = el
    ? [...el.querySelectorAll<HTMLElement>(`[${COMPACT_LABEL_ATTR}]`)]
    : []
  if (labels.length === 0) return null
  let width = 0
  for (const label of labels) {
    // sr-only is position: absolute, out of the row
    if (getComputedStyle(label).position === 'absolute') return null
    const gap = parseFloat(getComputedStyle(label.parentElement!).columnGap)
    width += label.getBoundingClientRect().width + (gap || 0)
  }
  return width
}

// The header's compact state, fed by the tabs' spare room (onSpareChange)
// and measuring the labels inside controlsRef while they are shown
export function useCompactLabels() {
  const [compact, setCompact] = useState(false)
  const compactRef = useRef(false)
  const labelWidth = useRef(0)
  const controlsRef = useRef<HTMLDivElement>(null)
  const onSpareChange = useCallback((spare: number) => {
    const prev = compactRef.current
    if (!prev) {
      const width = measureLabels(controlsRef.current)
      if (width !== null) labelWidth.current = width
    }
    const next = nextCompact(prev, spare, labelWidth.current)
    if (next === prev) return
    compactRef.current = next
    setCompact(next)
  }, [])
  return { compact, onSpareChange, controlsRef }
}
