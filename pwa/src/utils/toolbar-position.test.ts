import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOLBAR_POSITION,
  resolveToolbarPosition,
  TOOLBAR_POSITIONS,
} from './toolbar-position'

describe('resolveToolbarPosition', () => {
  it('keeps each known position', () => {
    for (const position of TOOLBAR_POSITIONS)
      expect(resolveToolbarPosition(position)).toBe(position)
  })

  it('falls back to the header for an unknown or missing value', () => {
    expect(DEFAULT_TOOLBAR_POSITION).toBe('header')
    expect(resolveToolbarPosition('left')).toBe('header')
    expect(resolveToolbarPosition(1)).toBe('header')
    expect(resolveToolbarPosition(null)).toBe('header')
    expect(resolveToolbarPosition(undefined)).toBe('header')
  })
})
