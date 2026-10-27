import { afterEach, describe, expect, it, vi } from 'vitest'
import { markClassicScrollbars, scrollbarWidth } from './classic-scrollbars'

// jsdom has no layout: the probe's sizes are given
const sizes = (offset: number, client: number) => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(offset)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(client)
}

describe('classic scrollbars', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete document.documentElement.dataset.classicScrollbars
  })

  it('measures the room a scrollbar takes, and leaves no probe behind', () => {
    sizes(100, 83)
    expect(scrollbarWidth(document)).toBe(17)
    expect(document.body.children).toHaveLength(0)
  })

  it('marks <html> where scrollbars take room', () => {
    sizes(100, 83)
    markClassicScrollbars()
    expect(document.documentElement).toHaveAttribute('data-classic-scrollbars')
  })

  it('leaves overlay scrollbars (macOS, phones) unmarked', () => {
    sizes(100, 100)
    markClassicScrollbars()
    expect(document.documentElement).not.toHaveAttribute(
      'data-classic-scrollbars',
    )
  })
})
