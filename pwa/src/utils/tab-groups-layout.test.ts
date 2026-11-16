import { describe, expect, it } from 'vitest'
import { resolveTabGroupsLayout } from './tab-groups-layout'

describe('resolveTabGroupsLayout', () => {
  it('keeps a layout it knows', () => {
    expect(resolveTabGroupsLayout('inline')).toBe('inline')
    expect(resolveTabGroupsLayout('row')).toBe('row')
  })

  it('falls back to inline', () => {
    expect(resolveTabGroupsLayout('grid')).toBe('inline')
    expect(resolveTabGroupsLayout(undefined)).toBe('inline')
  })
})
