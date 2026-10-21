import { describe, expect, it } from 'vitest'
import { fromTsv, toTsv } from './tsv-clipboard'

describe('tsv clipboard', () => {
  it('writes rows of tabs, quoting a tab, a line break or a quote', () => {
    expect(
      toTsv([
        ['a', 'b'],
        ['', 'c\td'],
        ['x\ny', 'say "hi"'],
      ]),
    ).toBe('a\tb\n\t"c\td"\n"x\ny"\t"say ""hi"""')
  })

  it('reads back what it writes, and what a spreadsheet copies', () => {
    const values = [
      ['a', ''],
      ['x\ny', '"q"'],
      ['', ''],
    ]
    expect(fromTsv(toTsv(values))).toEqual(values)
    // Excel: CRLF, and a line break at the end
    expect(fromTsv('1\t2\r\n3\t4\r\n')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
    expect(fromTsv('one\n')).toEqual([['one']])
  })

  it('every line break read is \\n, a quoted CRLF and a lone CR too', () => {
    expect(fromTsv('"multi\r\nline"\tb\r\nx\r')).toEqual([
      ['multi\nline', 'b'],
      ['x'],
    ])
  })

  it('reads nothing from nothing; a quote never closed is one cell as typed', () => {
    expect(fromTsv('')).toEqual([])
    expect(fromTsv('"a\tb\nc')).toEqual([['"a\tb\nc']])
  })
})
