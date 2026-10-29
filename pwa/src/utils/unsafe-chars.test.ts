import { describe, expect, it } from 'vitest'
import { splitUnsafe, UNSAFE_CHARS, visibleUnsafe } from './unsafe-chars'

describe('UNSAFE_CHARS', () => {
  it.each([
    '\u0000',
    '\u0009',
    '\u000a',
    '\u001f',
    '\u007f',
    '\u0085',
    '\u061c',
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
    '\u00ad',
    '\u115f',
    '\u1160',
    '\u180e',
    '\u2028',
    '\u2029',
    '\u2061',
    '\u2064',
    '\u3164',
    '\uffa0',
    '\ufff9',
    '\ufffb',
    '\u{e0000}',
    '\u{e0041}',
    '\u{e007f}',
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

  it('shows separators, fillers and tag characters, one mark per character', () => {
    expect(visibleUnsafe('a\u2029b\u00adc\u3164')).toBe(
      'a⟨U+2029⟩b⟨U+00AD⟩c⟨U+3164⟩',
    )
    expect(visibleUnsafe('ok\u{e0068}\u{e0069}')).toBe('ok⟨U+E0068⟩⟨U+E0069⟩')
  })

  it('keeps tabs, and draws line breaks on one line', () => {
    expect(visibleUnsafe('a\tb\nc\r\nd')).toBe('a\tb↵c↵d')
    expect(visibleUnsafe('lone\rcr')).toBe('lone⟨U+000D⟩cr')
  })

  it('keeps line breaks across lines, CRLF as one', () => {
    expect(visibleUnsafe('a\nb\r\nc\rd', true)).toBe('a\nb\nc⟨U+000D⟩d')
  })
})

describe('splitUnsafe', () => {
  it('cuts the text around each unsafe character, tab and newline kept', () => {
    expect(splitUnsafe('a\u202eb\tc\n\u200b\u200b')).toEqual([
      { text: 'a' },
      { text: '\u202e', mark: '⟨U+202E⟩' },
      { text: 'b\tc\n' },
      { text: '\u200b', mark: '⟨U+200B⟩' },
      { text: '\u200b', mark: '⟨U+200B⟩' },
    ])
    expect(splitUnsafe('plain')).toEqual([{ text: 'plain' }])
    expect(splitUnsafe('')).toEqual([])
  })
})
