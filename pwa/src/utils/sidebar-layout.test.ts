import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIDEBAR_LAYOUT,
  resolveSidebarLayout,
  SIDEBAR_LAYOUTS,
} from './sidebar-layout'

describe('resolveSidebarLayout', () => {
  it('keeps each known layout', () => {
    for (const layout of SIDEBAR_LAYOUTS)
      expect(resolveSidebarLayout(layout)).toBe(layout)
  })

  it('falls back to detailed for an unknown or missing value', () => {
    expect(DEFAULT_SIDEBAR_LAYOUT).toBe('detailed')
    expect(resolveSidebarLayout('grid')).toBe('detailed')
    expect(resolveSidebarLayout(1)).toBe('detailed')
    expect(resolveSidebarLayout(null)).toBe('detailed')
    expect(resolveSidebarLayout(undefined)).toBe('detailed')
  })
})
