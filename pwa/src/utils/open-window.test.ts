import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInWindow, POPUP_FEATURES } from './open-window'

describe('openInWindow', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the link in a new window, sized when a popup', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    expect(openInWindow('#/s/w/t?solo=1')).toBe(true)
    expect(open).toHaveBeenLastCalledWith(
      `${window.location.origin}/#/s/w/t?solo=1`,
      '_blank',
      undefined,
    )
    expect(openInWindow('#/overview?solo=1', true)).toBe(true)
    expect(open).toHaveBeenLastCalledWith(
      `${window.location.origin}/#/overview?solo=1`,
      '_blank',
      POPUP_FEATURES,
    )
  })

  it('is false when the browser blocks it', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openInWindow('#/overview?solo=1')).toBe(false)
  })
})
