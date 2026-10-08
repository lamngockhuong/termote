import { describe, expect, it } from 'vitest'
import { UNSAFE_CHARS, visibleUnsafe } from './unsafe-chars'

describe('UNSAFE_CHARS', () => {
  it.each([
    '\u0000',
    '\u0009',
    '\u000a',
    '\u001f',
    '\u007f',
    '\u0085',
    '\u009f',
    '\u200b',
    '\u200e',
    '\u200f',
    '\u202a',
    '\u202e',
    '\u2060',
    '\u2066',
    '\u2069',
    '\ufeff',
  ])('matches %j', (c) => {
    expect(c.replace(UNSAFE_CHARS, '')).toBe('')
  })

  it('leaves ordinary text, joined emoji and joiners in scripts', () => {
    for (const text of ['abc é 😀 ✓', '👩\u200d💻', 'می\u200cخواهم']) {
      expect(text.replace(UNSAFE_CHARS, '')).toBe(text)
    }
  })
})

describe('visibleUnsafe', () => {
  it('shows bidi, zero-width and control characters', () => {
    expect(visibleUnsafe('\u202e0001')).toBe('⟨U+202E⟩0001')
    expect(visibleUnsafe('a\u200bb\ufeff')).toBe('a⟨U+200B⟩b⟨U+FEFF⟩')
    expect(visibleUnsafe('bell\u0007\u009b')).toBe('bell⟨U+0007⟩⟨U+009B⟩')
  })

  it('keeps tabs, and draws line breaks on one line', () => {
    expect(visibleUnsafe('a\tb\nc\r\nd')).toBe('a\tb↵c↵d')
    expect(visibleUnsafe('lone\rcr')).toBe('lone⟨U+000D⟩cr')
  })

  it('keeps line breaks across lines, CRLF as one', () => {
    expect(visibleUnsafe('a\nb\r\nc\rd', true)).toBe('a\nb\nc⟨U+000D⟩d')
  })
})
