import { describe, expect, it } from 'vitest'
import { MAIN_MIN } from './side-panel-width'
import {
  clampSidebarWidth,
  maxSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from './sidebar-width'

describe('sidebar width', () => {
  it('is held at its own maximum before the row is measured', () => {
    expect(maxSidebarWidth(null)).toBe(SIDEBAR_MAX)
    expect(clampSidebarWidth(2000, null)).toBe(SIDEBAR_MAX)
    expect(clampSidebarWidth(300, null)).toBe(300)
  })

  it('leaves the main area its minimum in a narrow row', () => {
    expect(maxSidebarWidth(800)).toBe(800 - MAIN_MIN)
    expect(clampSidebarWidth(500, 800)).toBe(800 - MAIN_MIN)
    expect(maxSidebarWidth(3000)).toBe(SIDEBAR_MAX)
  })

  it('keeps the sidebar minimum, also in a row too narrow for both', () => {
    expect(clampSidebarWidth(100, 1200)).toBe(SIDEBAR_MIN)
    expect(maxSidebarWidth(400)).toBe(SIDEBAR_MIN)
    expect(clampSidebarWidth(256, 400)).toBe(SIDEBAR_MIN)
  })

  it('reads a saved value that is not a number as the default', () => {
    expect(clampSidebarWidth(undefined, null)).toBe(SIDEBAR_DEFAULT)
    expect(clampSidebarWidth('wide', null)).toBe(SIDEBAR_DEFAULT)
    expect(clampSidebarWidth(Number.NaN, null)).toBe(SIDEBAR_DEFAULT)
    expect(clampSidebarWidth(300.6, null)).toBe(301)
  })
})
