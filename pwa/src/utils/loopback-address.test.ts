import { describe, expect, it } from 'vitest'
import { loopbackAddress } from './loopback-address'

describe('loopbackAddress', () => {
  it('moves a localhost page to 127.0.0.1, keeping port, path and route', () => {
    expect(
      loopbackAddress({
        hostname: 'localhost',
        href: 'http://localhost:7682/?x=1#/s/w1/w1:p2?view=chat',
      }),
    ).toBe('http://127.0.0.1:7682/?x=1#/s/w1/w1:p2?view=chat')
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
    expect(loopbackAddress()).toBe('http://127.0.0.1:3000/')
  })
})
