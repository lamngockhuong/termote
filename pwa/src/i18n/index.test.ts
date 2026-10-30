import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserLanguages,
  detectLocale,
  resolveLanguage,
  resolveLocales,
} from '.'

describe('detectLocale', () => {
  it('is Vietnamese when the first language is', () => {
    expect(detectLocale(['vi-VN', 'en'])).toBe('vi')
    expect(detectLocale(['VI'])).toBe('vi')
  })

  it('is English otherwise', () => {
    expect(detectLocale(['en-US', 'vi'])).toBe('en')
    expect(detectLocale(['ja'])).toBe('en')
    expect(detectLocale([])).toBe('en')
  })
})

describe('resolveLanguage', () => {
  it('keeps a known setting', () => {
    expect(resolveLanguage('vi')).toBe('vi')
    expect(resolveLanguage('en')).toBe('en')
    expect(resolveLanguage('auto')).toBe('auto')
  })

  it('reads anything else as auto', () => {
    expect(resolveLanguage('fr')).toBe('auto')
    expect(resolveLanguage(undefined)).toBe('auto')
  })
})

describe('resolveLocales', () => {
  it('auto follows the browser, for the tour and the app alike', () => {
    expect(
      resolveLocales({ setting: 'auto', navigatorLanguages: ['vi-VN'] }),
    ).toEqual({ tourLocale: 'vi', appLocale: 'vi' })
    expect(
      resolveLocales({ setting: 'auto', navigatorLanguages: ['en-US'] }),
    ).toEqual({ tourLocale: 'en', appLocale: 'en' })
  })

  it('a picked language wins over the browser', () => {
    expect(
      resolveLocales({ setting: 'en', navigatorLanguages: ['vi-VN'] }),
    ).toEqual({ tourLocale: 'en', appLocale: 'en' })
  })

  it('the app speaks a picked language: Vietnamese now', () => {
    expect(
      resolveLocales({ setting: 'vi', navigatorLanguages: ['en'] }),
    ).toEqual({ tourLocale: 'vi', appLocale: 'vi' })
  })

  it('a language not yet an app locale reaches the tour alone', () => {
    expect(
      resolveLocales({
        setting: 'vi',
        navigatorLanguages: ['en'],
        appLocales: ['en'],
      }),
    ).toEqual({ tourLocale: 'vi', appLocale: 'en' })
  })
})

describe('browserLanguages', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads navigator.languages', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['vi-VN', 'en'])
    expect(browserLanguages()).toEqual(['vi-VN', 'en'])
  })

  it('falls back to navigator.language', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([])
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('vi')
    expect(browserLanguages()).toEqual(['vi'])
  })

  it('is empty when the browser names none', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(
      undefined as unknown as readonly string[],
    )
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('')
    expect(browserLanguages()).toEqual([])
  })
})
