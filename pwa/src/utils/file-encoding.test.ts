import { describe, expect, it } from 'vitest'
import { ENCODINGS, encodingLabel, isFileEncoding } from './file-encoding'

describe('file encoding', () => {
  it.each([
    ['utf-8', false, 'UTF-8'],
    ['utf-8', true, 'UTF-8 with BOM'],
    ['utf-16le', true, 'UTF-16 LE with BOM'],
    ['utf-16be', false, 'UTF-16 BE'],
    ['shift_jis', false, 'Shift-JIS'],
    ['euc-jp', false, 'EUC-JP'],
  ] as const)('%s (BOM %s) is %s', (enc, bom, want) => {
    expect(encodingLabel(enc, bom)).toBe(want)
  })

  it('names a BOM only when there is one', () => {
    expect(encodingLabel('utf-8')).toBe('UTF-8')
  })

  it('knows every listed encoding and nothing else', () => {
    for (const enc of ENCODINGS) expect(isFileEncoding(enc)).toBe(true)
    for (const v of ['latin1', 'UTF-8', 'toString', '', 1, undefined])
      expect(isFileEncoding(v)).toBe(false)
  })
})
