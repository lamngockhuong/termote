import { describe, expect, it } from 'vitest'
import {
  type CsvTable,
  cellsIn,
  cellValue,
  type Delimiter,
  delimiterFor,
  isTablePath,
  parseCsv,
  rowValues,
  sniffDelimiter,
  valueAt,
} from './csv-parse'
import { randomCsv, rng } from './csv-test-data'

function table(text: string, delimiter: Delimiter = ','): CsvTable {
  const res = parseCsv(text, delimiter)
  if (!res.ok) throw new Error(`parse error at line ${res.line}`)
  return res.table
}

// Every row as its decoded values
function rows(text: string, delimiter: Delimiter = ','): string[][] {
  const t = table(text, delimiter)
  return Array.from({ length: t.rowCount }, (_, r) => rowValues(text, t, r))
}

describe('parseCsv', () => {
  it.each<[string, string, string[][]]>([
    [
      'plain rows',
      'a,b\n1,2',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    ['a delimiter in quotes', '"a,b",c', [['a,b', 'c']]],
    ['doubled quotes', '"say ""hi"""', [['say "hi"']]],
    ['a line break in quotes', '"line1\nline2",x', [['line1\nline2', 'x']]],
    [
      'CRLF in and out of quotes',
      '"a\r\nb",c\r\nd,e\r\n',
      [
        ['a\r\nb', 'c'],
        ['d', 'e'],
      ],
    ],
    ['empty cells', 'a,,b', [['a', '', 'b']]],
    ['a row of only ""', 'a\n""\nb', [['a'], [''], ['b']]],
    ['a quote inside an unquoted cell', 'a"b,c', [['a"b', 'c']]],
    ['text after a closing quote', '"a"b,c', [['ab', 'c']]],
    ['a trailing delimiter', 'a,\n', [['a', '']]],
    ['a lone CR inside a cell', 'a\rb,c', [['a\rb', 'c']]],
  ])('reads %s', (_, text, want) => {
    expect(rows(text)).toEqual(want)
  })

  it('skips a BOM: the first cell starts at 1', () => {
    const text = '\uFEFFname,age\nAn,3\n'
    const t = table(text)
    expect(t.bom).toBe(true)
    expect(t.cellStart[0]).toBe(1)
    expect(cellValue(text, t, 0)).toBe('name')
  })

  it.each<[string, string, number, boolean]>([
    ['an empty file', '', 0, false],
    ['a lone line break', '\n', 0, true],
    ['a lone CRLF', '\r\n', 0, true],
    ['a lone BOM', '\uFEFF', 0, false],
    ['a BOM and a line break', '\uFEFF\n', 0, true],
    ['a trailing line break', 'a\nb\n', 2, true],
    ['no trailing line break', 'a\nb', 2, false],
    ['two empty lines', '\n\n', 2, true],
  ])('counts the rows of %s', (_, text, count, trailing) => {
    const t = table(text)
    expect(t.rowCount).toBe(count)
    expect(t.trailingEol).toBe(trailing)
    expect(t.rowCells).toHaveLength(count + 1)
  })

  it('reads an empty line in the middle as one empty cell', () => {
    expect(rows('a\n\nb\n')).toEqual([['a'], [''], ['b']])
  })

  it('records the first line break and defaults to LF', () => {
    expect(table('a\r\nb\nc').eol).toBe('\r\n')
    expect(table('a\nb\r\nc').eol).toBe('\n')
    expect(table('a').eol).toBe('\n')
  })

  it('takes the widest row as the column count', () => {
    const text = 'a,b,c\n1\n1,2,3,4\n'
    const t = table(text)
    expect(t.columnCount).toBe(4)
    expect([0, 1, 2].map((r) => cellsIn(t, r))).toEqual([3, 1, 4])
    expect(valueAt(text, t, 1, 0)).toBe('1')
    expect(valueAt(text, t, 1, 2)).toBe('')
  })

  it('reports an unclosed quote with the line of its opening quote', () => {
    expect(parseCsv('a,b\nc,d\ne,"f\ng\n', ',')).toEqual({
      ok: false,
      line: 3,
      offset: 10,
    })
  })

  it('ends each row past its line break', () => {
    const text = 'a,b\r\n"c\nd"\ne'
    const t = table(text)
    expect(Array.from(t.rowEnd)).toEqual([5, 11, 12])
  })

  it('parses with any delimiter', () => {
    expect(rows('a;b\n1;2', ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(rows('a\tb,c', '\t')).toEqual([['a', 'b,c']])
    expect(rows('a|"b|c"', '|')).toEqual([['a', 'b|c']])
  })

  it('decodes only the start of a cell given a limit', () => {
    const quoted = `"${'""'.repeat(3000)}x"`
    const t = table(`${quoted},${'y'.repeat(5000)}`)
    const q = cellValue(quoted, t, 0, 10)
    expect(q.length).toBeGreaterThanOrEqual(10)
    expect(q).toBe('"'.repeat(q.length))
    expect(valueAt(quoted, t, 0, 0, 10_000)).toBe(`${'"'.repeat(3000)}x`)
    const text = `${quoted},${'y'.repeat(5000)}`
    expect(valueAt(text, t, 0, 1, 10).length).toBeGreaterThanOrEqual(10)
    // A limit inside a "" pair, and one at the closing quote
    const small = table('"a""b"')
    expect(cellValue('"a""b"', small, 0, 1)).toBe('a"')
    expect(cellValue('"a""b"', small, 0, 2)).toBe('a"b')
  })

  it('grows its arrays for many cells', () => {
    const text = `${'a,'.repeat(5000)}a\n`
    const t = table(text)
    expect(t.columnCount).toBe(5001)
  })

  it('keeps raw ranges that rebuild the text exactly (random files)', () => {
    const rand = rng(42)
    for (let i = 0; i < 300; i++) {
      const delim = (['\t', ',', ';', '|'] as const)[i % 4]
      const text = randomCsv(rand, delim)
      const t = table(text, delim)
      let out = t.bom ? '\uFEFF' : ''
      for (let r = 0; r < t.rowCount; r++) {
        const first = t.rowCells[r]
        const last = t.rowCells[r + 1] - 1
        expect(t.cellStart[first]).toBe(out.length)
        for (let c = first; c <= last; c++) {
          if (c > first) out += t.delimiter
          const raw = text.slice(t.cellStart[c], t.cellEnd[c])
          expect(raw.startsWith('"')).toBe(t.cellQuoted[c] === 1)
          out += raw
        }
        out += text.slice(t.cellEnd[last], t.rowEnd[r])
      }
      expect(out).toBe(text)
    }
  })

  it('logs how long a 1 MiB file takes', () => {
    const line = 'id,"name, quoted",value,more text here\n'
    const text = line.repeat(Math.ceil((1 << 20) / line.length))
    const t0 = performance.now()
    const t = table(text)
    // Logged, not asserted: a timing assertion would be flaky
    console.info(`parseCsv 1 MiB: ${(performance.now() - t0).toFixed(0)} ms`)
    expect(t.columnCount).toBe(4)
  })
})

describe('sniffDelimiter', () => {
  it.each<[string, string, Delimiter]>([
    ['commas', 'a,b,c\n1,2,3\n', ','],
    ['semicolons', 'a;b\n1;2\n', ';'],
    ['tabs', 'a\tb\n1\t2', '\t'],
    ['pipes', 'a|b|c\n1|2|3', '|'],
    ['a decimal comma with semicolons', 'a;b\n1,5;2,5\n', ';'],
    ['delimiters inside quotes', '"a;b;c",d\n"e;f;g",h\n', ','],
    ['nothing', 'abc\ndef', ','],
    ['an empty text', '', ','],
    ['a tie', 'a,b;c\n1,2;3', ','],
    ['ragged rows', 'a;b;c\n1;2\n', ';'],
    [
      'the most on every line when none is stable',
      'a,b,c,d;e\n1,2,3;4;5\n',
      ',',
    ],
    ['CRLF', 'a;b\r\n1;2\r\n', ';'],
  ])('finds %s', (_, text, want) => {
    expect(sniffDelimiter(text)).toBe(want)
  })

  it('never counts a line cut at the end of what it reads', () => {
    // A long first line of ';', then lines of ',' cut mid-way
    const head = `a;b\n1;2\n${'x,'.repeat(40 * 1024)}`
    expect(sniffDelimiter(head)).toBe(';')
    // A single line longer than what it reads still counts
    expect(sniffDelimiter('a;'.repeat(40 * 1024))).toBe(';')
  })

  it('reads only the first 20 lines', () => {
    const text = `${'a;b\n'.repeat(20)}${'a,b,c,d\n'.repeat(50)}`
    expect(sniffDelimiter(text)).toBe(';')
  })

  it('stops at a line with none of the stable one', () => {
    // ',' is on every line but not the same number of times; ';' is not on every line
    expect(sniffDelimiter('a,b;c\n1,2,3\n')).toBe(',')
  })
})

describe('paths', () => {
  it.each([
    ['data.csv', true],
    ['DATA.CSV', true],
    ['a/b.tsv', true],
    ['x.tab', true],
    ['x.csv.bak', false],
    ['notes.md', false],
  ])('%s is a table: %s', (path, want) => {
    expect(isTablePath(path)).toBe(want)
  })

  it('takes tabs for .tsv and .tab, sniffs a .csv', () => {
    expect(delimiterFor('a.tsv', 'a,b')).toBe('\t')
    expect(delimiterFor('a.TAB', 'a,b')).toBe('\t')
    expect(delimiterFor('a.csv', 'a;b\n1;2')).toBe(';')
  })
})
