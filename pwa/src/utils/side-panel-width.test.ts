import { describe, expect, it } from 'vitest'
import {
  clampPanelWidth,
  MAIN_MIN,
  maxPanelWidth,
  SIDE_PANEL_DEFAULT,
  SIDE_PANEL_MIN,
} from './side-panel-width'

describe('side panel width', () => {
  it('has no maximum before the row is measured', () => {
    expect(maxPanelWidth(null)).toBe(Number.POSITIVE_INFINITY)
    expect(clampPanelWidth(2000, null)).toBe(2000)
  })

  it('leaves the main area its minimum', () => {
    expect(maxPanelWidth(1200)).toBe(1200 - MAIN_MIN)
    expect(clampPanelWidth(1000, 1200)).toBe(1200 - MAIN_MIN)
    expect(clampPanelWidth(500, 1200)).toBe(500)
  })

  it('keeps the panel minimum, also in a row too narrow for both', () => {
    expect(clampPanelWidth(100, 1200)).toBe(SIDE_PANEL_MIN)
    expect(maxPanelWidth(500)).toBe(SIDE_PANEL_MIN)
    expect(clampPanelWidth(440, 500)).toBe(SIDE_PANEL_MIN)
  })

  it('reads a saved value that is not a number as the default', () => {
    expect(clampPanelWidth(undefined, null)).toBe(SIDE_PANEL_DEFAULT)
    expect(clampPanelWidth('wide', null)).toBe(SIDE_PANEL_DEFAULT)
    expect(clampPanelWidth(Number.NaN, null)).toBe(SIDE_PANEL_DEFAULT)
    expect(clampPanelWidth(450.6, null)).toBe(451)
  })
})
