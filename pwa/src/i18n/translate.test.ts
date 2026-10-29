import { afterEach, describe, expect, it, vi } from 'vitest'
import { createT, interpolate } from './translate'

const en = {
  hello: 'Hello {name}',
  files_one: '{count} file',
  files_other: '{count} files',
  onlyEn: 'English only',
}

describe('interpolate', () => {
  it('puts each value in its placeholder', () => {
    expect(interpolate('{a} and {b}', { a: 1, b: 'two' })).toBe('1 and two')
  })

  it('leaves a placeholder without a value', () => {
    expect(interpolate('Hi {name}', { other: 'x' })).toBe('Hi {name}')
  })

  it('returns the text as it is without values', () => {
    expect(interpolate('Hi {name}')).toBe('Hi {name}')
  })
})

describe('createT', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads and fills a message', () => {
    const t = createT(en, en, 'en')
    expect(t('hello', { name: 'Ana' })).toBe('Hello Ana')
  })

  it('picks the English plural form for count', () => {
    const t = createT(en, en, 'en')
    expect(t('files', { count: 1 })).toBe('1 file')
    expect(t('files', { count: 3 })).toBe('3 files')
    expect(t('files', { count: 0 })).toBe('0 files')
  })

  it('uses _other for a locale with one plural form', () => {
    const vi = { files_other: '{count} tệp' }
    const t = createT(vi, en, 'vi')
    expect(t('files', { count: 1 })).toBe('1 tệp')
  })

  it('falls back to _other when the category has no form', () => {
    const t = createT({ files_other: '{count} x' }, en, 'en')
    expect(t('files', { count: 1 })).toBe('1 x')
  })

  it('reads a key without plural forms when count is given', () => {
    const t = createT(en, en, 'en')
    expect(t('hello', { name: 'B', count: 2 })).toBe('Hello B')
  })

  it('reads a key the locale lacks in English', () => {
    const t = createT({}, en, 'vi')
    expect(t('onlyEn')).toBe('English only')
  })

  it('shows the key and warns in development when no locale has it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = createT({}, en, 'vi')
    expect(t('missing')).toBe('missing')
    expect(warn).toHaveBeenCalledWith('i18n: no message for "missing"')
  })

  it('does not warn outside development', () => {
    vi.stubEnv('DEV', false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(createT({}, {}, 'en')('missing')).toBe('missing')
    expect(warn).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})
