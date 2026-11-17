import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openInWindow,
  openMachineInWindow,
  POPUP_FEATURES,
} from './open-window'

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

describe('openMachineInWindow', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the app on a machine in a new window, sized when a popup', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    expect(openMachineInWindow('0123456789abcdef')).toBe(true)
    expect(open).toHaveBeenLastCalledWith(
      `${window.location.origin}/?machine=0123456789abcdef`,
      '_blank',
      undefined,
    )
    // This machine, and an id that is none, open the app on this server
    expect(openMachineInWindow('', true)).toBe(true)
    expect(open).toHaveBeenLastCalledWith(
      `${window.location.origin}/`,
      '_blank',
      POPUP_FEATURES,
    )
    openMachineInWindow('../x')
    expect(open).toHaveBeenLastCalledWith(
      `${window.location.origin}/`,
      '_blank',
      undefined,
    )
  })

  it('is false when the browser blocks it', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openMachineInWindow('0123456789abcdef')).toBe(false)
  })
})
