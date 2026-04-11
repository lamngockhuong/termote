import { describe, expect, it } from 'vitest'
import { APP_INFO } from './app-info'

describe('APP_INFO', () => {
  it('has a name', () => {
    expect(typeof APP_INFO.name).toBe('string')
    expect(APP_INFO.name.length).toBeGreaterThan(0)
  })

  it('has a version', () => {
    expect(typeof APP_INFO.version).toBe('string')
    expect(APP_INFO.version.length).toBeGreaterThan(0)
  })

  it('has description', () => {
    expect(APP_INFO.description).toBe(
      'Terminal + Remote - Control CLI tools from anywhere',
    )
  })

  it('has author with name and url', () => {
    expect(APP_INFO.author.name).toBe('Lam Ngoc Khuong')
    expect(APP_INFO.author.url).toBe('https://khuong.dev')
  })

  it('has repository', () => {
    expect(APP_INFO.repository).toBe('https://github.com/lamngockhuong/termote')
  })

  it('has license MIT', () => {
    expect(APP_INFO.license).toBe('MIT')
  })

  it('has links with changelog and issues', () => {
    expect(APP_INFO.links.changelog).toBe(
      'https://github.com/lamngockhuong/termote/releases',
    )
    expect(APP_INFO.links.issues).toBe(
      'https://github.com/lamngockhuong/termote/issues',
    )
  })

  it('has sponsor links', () => {
    expect(APP_INFO.sponsor.momo).toBe('https://me.momo.vn/khuong')
    expect(APP_INFO.sponsor.github).toBe(
      'https://github.com/sponsors/lamngockhuong',
    )
    expect(APP_INFO.sponsor.buyMeACoffee).toBe(
      'https://buymeacoffee.com/lamngockhuong',
    )
  })
})
