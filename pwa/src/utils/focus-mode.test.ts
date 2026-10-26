import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('isFocusWindow', () => {
  // test-setup.ts loaded the module already: each test loads it afresh
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    window.location.hash = ''
  })

  it('is read from the address when the page loads', async () => {
    window.location.hash = '#/s/w/t?view=files&solo=1&file=a.ts'
    const m = await import('./focus-mode')
    expect(m.isFocusWindow()).toBe(true)
    // A later change of the address keeps it
    window.location.hash = '#/s/w/t'
    expect(m.isFocusWindow()).toBe(true)
  })

  it('is off without solo, and set for tests', async () => {
    window.location.hash = '#/overview'
    const m = await import('./focus-mode')
    expect(m.isFocusWindow()).toBe(false)
    m.setFocusWindowForTest(true)
    expect(m.isFocusWindow()).toBe(true)
  })
})
