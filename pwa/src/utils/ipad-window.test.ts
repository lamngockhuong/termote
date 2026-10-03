import { afterEach, describe, expect, it } from 'vitest'
import { isIPadWindowed, watchIPadWindow } from './ipad-window'

// iPadOS sends the same user agent as Safari on a Mac
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const IPAD_UA = MAC_UA

function win({
  ua = IPAD_UA,
  touch = 5,
  standalone = true,
  width = 1366,
  height = 1024,
}: {
  ua?: string
  touch?: number
  standalone?: boolean
  width?: number
  height?: number
} = {}) {
  return {
    innerWidth: width,
    innerHeight: height,
    // iPadOS keeps screen.width/height in portrait
    screen: { width: 1024, height: 1366 },
    navigator: {
      userAgent: ua,
      maxTouchPoints: touch,
      standalone,
    } as unknown as Navigator & { standalone?: boolean },
  }
}

describe('isIPadWindowed', () => {
  it('is false for an installed app full screen, in either orientation', () => {
    expect(isIPadWindowed(win())).toBe(false)
    expect(isIPadWindowed(win({ width: 1024, height: 1366 }))).toBe(false)
  })

  it('is true for an installed app in a window', () => {
    expect(isIPadWindowed(win({ width: 900, height: 700 }))).toBe(true)
    expect(isIPadWindowed(win({ width: 600, height: 900 }))).toBe(true)
  })

  it('is false in Safari, where the browser bar sits under the controls', () => {
    expect(
      isIPadWindowed(win({ standalone: false, width: 900, height: 700 })),
    ).toBe(false)
  })

  it('reads display-mode when navigator.standalone is missing', () => {
    const w = {
      ...win({ standalone: false, width: 900, height: 700 }),
      matchMedia: (q: string) =>
        ({ matches: q === '(display-mode: standalone)' }) as MediaQueryList,
    }
    expect(isIPadWindowed(w)).toBe(true)
  })

  it('is false on a Mac, which has no touch points', () => {
    expect(isIPadWindowed(win({ ua: MAC_UA, touch: 0, width: 900 }))).toBe(
      false,
    )
  })

  it('is false on an iPhone', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15'
    expect(isIPadWindowed(win({ ua, width: 300, height: 600 }))).toBe(false)
  })
})

describe('watchIPadWindow', () => {
  const { navigator, screen, innerWidth, innerHeight } = window

  afterEach(() => {
    delete document.documentElement.dataset.ipadWindow
    Object.defineProperty(window, 'navigator', {
      value: navigator,
      configurable: true,
    })
    Object.defineProperty(window, 'screen', {
      value: screen,
      configurable: true,
    })
    window.innerWidth = innerWidth
    window.innerHeight = innerHeight
  })

  it('marks <html> and follows resizes until stopped', () => {
    const nav = win().navigator
    Object.defineProperty(window, 'navigator', {
      value: nav,
      configurable: true,
    })
    Object.defineProperty(window, 'screen', {
      value: { width: 1024, height: 1366 },
      configurable: true,
    })
    window.innerWidth = 900
    window.innerHeight = 700
    const stop = watchIPadWindow(window)
    expect(document.documentElement.dataset.ipadWindow).toBe('')

    window.innerWidth = 1366
    window.innerHeight = 1024
    window.dispatchEvent(new Event('resize'))
    expect(document.documentElement.dataset.ipadWindow).toBeUndefined()

    stop()
    window.innerWidth = 900
    window.dispatchEvent(new Event('resize'))
    expect(document.documentElement.dataset.ipadWindow).toBeUndefined()
  })
})
