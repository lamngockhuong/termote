import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  COMPACT_LABEL_ATTR,
  LABEL_SLACK,
  measureLabels,
  nextCompact,
  useCompactLabels,
} from './use-compact-labels'

// A row of buttons, each with a label of the given width; gap on each button
function controls(widths: number[], gap = '6px') {
  const row = document.createElement('div')
  for (const width of widths) {
    const button = document.createElement('button')
    button.style.columnGap = gap
    const label = document.createElement('span')
    label.setAttribute(COMPACT_LABEL_ATTR, '')
    label.getBoundingClientRect = () => ({ width }) as DOMRect
    button.append(label)
    row.append(button)
  }
  return row
}

describe('nextCompact', () => {
  it('compacts once the tabs overflow', () => {
    expect(nextCompact(false, -1, 200)).toBe(true)
    expect(nextCompact(false, 0, 200)).toBe(false)
    expect(nextCompact(false, 500, 200)).toBe(false)
  })

  it('shows the labels again only with room for them and the slack', () => {
    expect(LABEL_SLACK).toBe(24)
    expect(nextCompact(true, -5, 200)).toBe(true)
    expect(nextCompact(true, 200 + 23, 200)).toBe(true)
    expect(nextCompact(true, 200 + 24, 200)).toBe(false)
  })
})

describe('measureLabels', () => {
  it('adds each label and the gap before it', () => {
    expect(measureLabels(controls([60, 40]))).toBe(60 + 6 + 40 + 6)
  })

  it('counts no gap where the button has none', () => {
    expect(measureLabels(controls([50], 'normal'))).toBe(50)
  })

  it('measures nothing without labels or an element', () => {
    expect(measureLabels(null)).toBeNull()
    expect(measureLabels(document.createElement('div'))).toBeNull()
  })

  it('measures nothing while a label is already hidden (sr-only)', () => {
    const row = controls([60, 40])
    row.querySelector<HTMLElement>('span')!.style.position = 'absolute'
    expect(measureLabels(row)).toBeNull()
  })
})

describe('useCompactLabels', () => {
  it('hides the labels on overflow and shows them past their width', () => {
    const { result } = renderHook(() => useCompactLabels())
    const row = controls([100])
    result.current.controlsRef.current = row as HTMLDivElement
    expect(result.current.compact).toBe(false)
    act(() => result.current.onSpareChange(-10))
    expect(result.current.compact).toBe(true)
    // Measured while shown: 106 px
    act(() => result.current.onSpareChange(106 + 23))
    expect(result.current.compact).toBe(true)
    act(() => result.current.onSpareChange(106 + 24))
    expect(result.current.compact).toBe(false)
  })

  it('keeps the last width while the labels cannot be measured', () => {
    const { result } = renderHook(() => useCompactLabels())
    const row = controls([100])
    result.current.controlsRef.current = row as HTMLDivElement
    act(() => result.current.onSpareChange(10))
    // Hidden by the header's own width: nothing to measure, 106 kept
    row.querySelector<HTMLElement>('span')!.style.position = 'absolute'
    act(() => result.current.onSpareChange(-1))
    expect(result.current.compact).toBe(true)
    act(() => result.current.onSpareChange(129))
    expect(result.current.compact).toBe(true)
    act(() => result.current.onSpareChange(130))
    expect(result.current.compact).toBe(false)
  })

  it('without a measure, shows the labels again past the slack', () => {
    const { result } = renderHook(() => useCompactLabels())
    act(() => result.current.onSpareChange(-1))
    expect(result.current.compact).toBe(true)
    act(() => result.current.onSpareChange(24))
    expect(result.current.compact).toBe(false)
  })
})
