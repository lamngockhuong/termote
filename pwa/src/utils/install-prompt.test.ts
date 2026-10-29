import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installOffer,
  onInstallOfferChange,
  promptInstall,
  registerInstallPrompt,
  resetInstallPromptForTest,
} from './install-prompt'

function promptEvent(outcome: 'accepted' | 'dismissed') {
  const e = new Event('beforeinstallprompt', { cancelable: true })
  return Object.assign(e, {
    prompt: vi.fn(async () => {}),
    userChoice: Promise.resolve({ outcome }),
  })
}

function setUserAgent(ua: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
}

describe('install prompt', () => {
  const win = new EventTarget() as Window
  registerInstallPrompt(win)

  afterEach(() => {
    resetInstallPromptForTest()
    vi.restoreAllMocks()
  })

  it('offers nothing before the browser fires its prompt (not iOS)', () => {
    expect(installOffer()).toBeNull()
  })

  it('holds the prompt, tells listeners, and shows it on request', async () => {
    const changed = vi.fn()
    onInstallOfferChange(changed)
    const e = promptEvent('accepted')
    win.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(installOffer()).toBe('prompt')
    await expect(promptInstall()).resolves.toBe(true)
    expect(e.prompt).toHaveBeenCalled()
    // Served once
    expect(installOffer()).toBeNull()
    await expect(promptInstall()).resolves.toBe(false)
  })

  it('resolves false when the user dismisses it', async () => {
    win.dispatchEvent(promptEvent('dismissed'))
    await expect(promptInstall()).resolves.toBe(false)
  })

  it('forgets the prompt once the app is installed', () => {
    const changed = vi.fn()
    const off = onInstallOfferChange(changed)
    win.dispatchEvent(promptEvent('accepted'))
    win.dispatchEvent(new Event('appinstalled'))
    expect(installOffer()).toBeNull()
    expect(changed).toHaveBeenCalledTimes(2)
    off()
    win.dispatchEvent(promptEvent('accepted'))
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('tells iPhone Safari to use Share › Add to Home Screen', () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
    expect(installOffer()).toBe('ios')
  })

  it('offers nothing once running installed', () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
    Object.defineProperty(navigator, 'standalone', {
      value: true,
      configurable: true,
    })
    try {
      expect(installOffer()).toBeNull()
    } finally {
      delete (navigator as { standalone?: boolean }).standalone
    }
  })
})
