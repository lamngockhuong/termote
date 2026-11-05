import { afterEach, describe, expect, it } from 'vitest'
import { avatarLetter, avatarTone } from './group-avatar'

describe('avatarLetter', () => {
  const segmenter = Intl.Segmenter
  afterEach(() => {
    Reflect.set(Intl, 'Segmenter', segmenter)
  })

  it('takes the first letter in capitals', () => {
    expect(avatarLetter('termote')).toBe('T')
    expect(avatarLetter('  api')).toBe('A')
  })

  it('keeps a Vietnamese letter with its marks whole', () => {
    expect(avatarLetter('đường')).toBe('Đ')
    // e + combining circumflex + combining acute: one grapheme
    expect(avatarLetter('ế project')).toBe('Ế')
  })

  it('keeps an emoji whole', () => {
    expect(avatarLetter('👩‍💻 work')).toBe('👩‍💻')
  })

  it('skips characters that show nothing', () => {
    expect(avatarLetter('​‮web')).toBe('W')
  })

  it('is a question mark for a name with nothing visible', () => {
    expect(avatarLetter('')).toBe('?')
    expect(avatarLetter(' ​ ')).toBe('?')
  })

  it('takes the first code point where there is no Intl.Segmenter', () => {
    // An older browser has none
    Reflect.set(Intl, 'Segmenter', undefined)
    expect(avatarLetter('ứng dụng')).toBe('Ứ')
    expect(avatarLetter('😀 smile')).toBe('😀')
  })
})

describe('avatarTone', () => {
  it('gives the same name the same colour', () => {
    expect(avatarTone('termote')).toBe(avatarTone('termote'))
  })

  it('spreads names over the eight colours', () => {
    const tones = new Set(
      Array.from({ length: 64 }, (_, i) => avatarTone(`project-${i}`)),
    )
    expect(tones.size).toBe(8)
    for (const tone of tones) expect(tone).toMatch(/^bg-avatar-[1-8]$/)
  })
})
