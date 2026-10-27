import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dismissLocalhostNotice,
  localhostNoticeDismissed,
  loopbackAddress,
} from './loopback-address'

describe('loopbackAddress', () => {
  it('moves a localhost page to 127.0.0.1, keeping port, path and route', () => {
    expect(
      loopbackAddress({
        hostname: 'localhost',
        href: 'http://localhost:7682/?x=1#/s/w1/w1:p2?view=chat',
      }),
    ).toBe('http://127.0.0.1:7682/?x=1#/s/w1/w1:p2?view=chat')
  })

  it('matches localhost in any case', () => {
    expect(
      loopbackAddress({
        hostname: 'LocalHost',
        href: 'http://LocalHost:7680/',
      }),
    ).toBe('http://127.0.0.1:7680/')
  })

  it.each([
    ['127.0.0.1', 'http://127.0.0.1:7680/'],
    ['box.ts.net', 'https://box.ts.net/'],
    ['192.168.1.5', 'http://192.168.1.5:7680/'],
  ])('leaves %s alone', (hostname, href) => {
    expect(loopbackAddress({ hostname, href })).toBeNull()
  })

  it('reads the current page by default', () => {
    // jsdom serves the tests from http://localhost:3000
    expect(loopbackAddress()).toBe(
      window.location.href.replace('//localhost', '//127.0.0.1'),
    )
  })
})

describe('localhost notice dismissal', () => {
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('is remembered on the device', () => {
    expect(localhostNoticeDismissed()).toBe(false)
    dismissLocalhostNotice()
    expect(localhostNoticeDismissed()).toBe(true)
  })

  it('treats storage that throws as not dismissed', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => dismissLocalhostNotice()).not.toThrow()
    expect(localhostNoticeDismissed()).toBe(false)
  })
})
