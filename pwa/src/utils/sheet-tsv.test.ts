import { describe, expect, it } from 'vitest'
import { MAX_COLUMNS } from '../components/table-preview'
import { parseCsv } from './csv-parse'
import { SHEET_MAX_BYTES, SHEET_MAX_COLUMNS, toTsv } from './sheet-tsv'

describe('toTsv', () => {
  it('writes cells by tab and rows by line, empty cells kept', () => {
    expect(
      toTsv([
        ['a', 1, null],
        [undefined, '', true],
      ]),
    ).toEqual({
      text: 'a\t1\t\n\t\ttrue\n',
      rows: 2,
      truncated: false,
      columnsCut: false,
    })
    expect(toTsv([])).toEqual({
      text: '',
      rows: 0,
      truncated: false,
      columnsCut: false,
    })
  })

  it('quotes what would split a cell, and parseCsv reads it back', () => {
    const cells = [
      'tab\there',
      'say "hi"',
      'two\nlines',
      'cr\rhere',
      'plain',
      '日本語',
    ]
    const { text } = toTsv([cells])
    expect(text).toBe(
      '"tab\there"\t"say ""hi"""\t"two\nlines"\t"cr\rhere"\tplain\t日本語\n',
    )
    const parsed = parseCsv(text, '\t')
    if (!parsed.ok) throw new Error('not parsed')
    const t = parsed.table
    const back = Array.from({ length: cells.length }, (_, c) =>
      text
        .slice(t.cellStart[c], t.cellEnd[c])
        .replace(/^"|"$/g, '')
        .replaceAll('""', '"'),
    )
    expect(back).toEqual(cells)
  })

  it('cuts at a whole row, counting UTF-8 bytes', () => {
    // "日\n" is 4 bytes
    const rows = [['日'], ['日'], ['日']]
    expect(toTsv(rows, 8)).toEqual({
      text: '日\n日\n',
      rows: 2,
      truncated: true,
      columnsCut: false,
    })
    expect(toTsv(rows, 12).truncated).toBe(false)
    expect(toTsv([['x'.repeat(10)]], 5)).toMatchObject({
      text: '',
      rows: 0,
      truncated: true,
    })
    expect(SHEET_MAX_BYTES).toBe(1024 * 1024)
  })

  it('keeps the columns the table view shows', () => {
    expect(SHEET_MAX_COLUMNS).toBe(MAX_COLUMNS)
    const wide = Array.from({ length: SHEET_MAX_COLUMNS + 5 }, (_, i) => i)
    const r = toTsv([wide, [1]])
    expect(r.columnsCut).toBe(true)
    expect(r.text.split('\n')[0].split('\t')).toHaveLength(SHEET_MAX_COLUMNS)
  })
})
