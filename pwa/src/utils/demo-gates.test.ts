import { describe, expect, it, vi } from 'vitest'
import { installOffer } from './install-prompt'
import { needsHomeScreenApp, notificationSupport } from './notify-permission'

// The demo (utils/demo.ts) has no service worker and no manifest
vi.mock('./demo', () => ({ isDemo: true }))

const iphone = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
  maxTouchPoints: 5,
} as Navigator

describe('in the demo', () => {
  it('offers no notifications, even on an iPhone', () => {
    expect(notificationSupport()).toBe('unsupported')
    expect(needsHomeScreenApp(iphone)).toBe(false)
  })

  it('offers no install', () => {
    expect(installOffer()).toBeNull()
  })
})
