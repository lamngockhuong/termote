import { describe, expect, it } from 'vitest'
import {
  type CsvTable,
  type Delimiter,
  parseCsv,
  rowValues,
  valueAt,
} from './csv-parse'
import {
  applyPatch,
  applyPatches,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  invertPatch,
  invertPatches,
  type Patch,
  quoteValue,
  replaceCell,
  replaceCells,
} from './csv-patch'
import { randomCsv, rng } from './csv-test-data'

function table(text: string, delimiter: Delimiter = ','): CsvTable {
  const res = parseCsv(text, delimiter)
  if (!res.ok) throw new Error('parse error')
  return res.table
}

function rows(text: string, delimiter: Delimiter = ','): string[][] {
  const t = table(text, delimiter)
  return Array.from({ length: t.rowCount }, (_, r) => rowValues(text, t, r))
}

const enc = new TextEncoder()

// The bytes before and after the changed range are the same in both texts
function onlyRangeChanged(before: string, after: string, p: Patch) {
  const a = enc.encode(before)
  const b = enc.encode(after)
  const prefix = enc.encode(before.slice(0, p.start)).length
  const suffix = enc.encode(before.slice(p.start + p.removed.length)).length
  expect(b.subarray(0, prefix)).toEqual(a.subarray(0, prefix))
  expect(b.subarray(b.length - suffix)).toEqual(a.subarray(a.length - suffix))
  expect(new TextDecoder().decode(b.subarray(prefix, b.length - suffix))).toBe(
    p.inserted,
  )
}

describe('applyPatch', () => {
  it('replaces the range and inverts back', () => {
    const p: Patch = { start: 2, removed: 'b', inserted: 'xyz' }
    expect(applyPatch('a,b,c', p)).toBe('a,xyz,c')
    expect(applyPatch(applyPatch('a,b,c', p), invertPatch(p))).toBe('a,b,c')
  })

  it('throws when the text no longer holds what it removes', () => {
    expect(() =>
      applyPatch('a,q,c', { start: 2, removed: 'b', inserted: 'x' }),
    ).toThrow(/does not match/)
  })
})

describe('quoteValue', () => {
  it.each<[string, string]>([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['cr\r', '"cr\r"'],
    [' lead', '" lead"'],
    ['trail ', '"trail "'],
    ['', ''],
    ['a;b', 'a;b'],
  ])('%j → %j', (value, want) => {
    expect(quoteValue(value, ',')).toBe(want)
  })

  it('quotes the delimiter in use', () => {
    expect(quoteValue('a;b', ';')).toBe('"a;b"')
    expect(quoteValue('a\tb', '\t')).toBe('"a\tb"')
  })

  it('keeps the quotes of a cell that had them', () => {
    expect(quoteValue('x', ',', true)).toBe('"x"')
  })

  it('writes an empty value alone on its row as ""', () => {
    expect(quoteValue('', ',', false, true)).toBe('""')
  })
})

describe('replaceCell', () => {
  it('changes only the bytes of the cell (CRLF, BOM, non-BMP text)', () => {
    const text = '\uFEFFname,note\r\n😀 An,"a, b"\r\nBình,x\r\n'
    const t = table(text)
    const p = replaceCell(text, t, 1, 1, 'new, value')
    const after = applyPatch(text, p)
    onlyRangeChanged(text, after, p)
    expect(after).toBe('\uFEFFname,note\r\n😀 An,"new, value"\r\nBình,x\r\n')
  })

  it('keeps the quotes of a quoted cell even when not needed', () => {
    const text = 'a,"b"\n'
    const after = applyPatch(text, replaceCell(text, table(text), 0, 1, 'c'))
    expect(after).toBe('a,"c"\n')
  })

  it('writes "" for an emptied cell alone on its row', () => {
    const text = 'a\nb\nc\n'
    const after = applyPatch(text, replaceCell(text, table(text), 1, 0, ''))
    expect(after).toBe('a\n""\nc\n')
    expect(rows(after)).toEqual([['a'], [''], ['c']])
  })

  it.each([
    [1, 'a,b,c\n1,2,X\n'],
    [3, 'a,b,c,d,e\n1,2,,,X\n'],
  ])(
    'pads a short row missing %i cell(s), before its line break',
    (missing, want) => {
      const text = missing === 1 ? 'a,b,c\n1,2\n' : 'a,b,c,d,e\n1,2\n'
      const t = table(text)
      const after = applyPatch(text, replaceCell(text, t, 1, 1 + missing, 'X'))
      expect(after).toBe(want)
    },
  )

  it('pads with the delimiter of the table and quotes what needs it', () => {
    const text = 'a;b\n1\n'
    const after = applyPatch(
      text,
      replaceCell(text, table(text, ';'), 1, 1, 'x;y'),
    )
    expect(after).toBe('a;b\n1;"x;y"\n')
  })
})

describe('insertRow', () => {
  it.each<[string, string, number, string[], string]>([
    ['at the top', 'a,b\n1,2\n', -1, ['x', 'y'], 'x,y\na,b\n1,2\n'],
    ['at the top, after the BOM', '\uFEFFa,b\n', -1, ['x'], '\uFEFFx,\na,b\n'],
    ['in the middle', 'a,b\n1,2\n', 0, ['x', 'y'], 'a,b\nx,y\n1,2\n'],
    ['at the end', 'a,b\n1,2\n', 1, ['x', 'y'], 'a,b\n1,2\nx,y\n'],
    [
      'after a last row without a line break',
      'a,b\n1,2',
      1,
      ['x', 'y'],
      'a,b\n1,2\nx,y',
    ],
    ['with CRLF', 'a,b\r\n1,2\r\n', 0, ['x', ''], 'a,b\r\nx,\r\n1,2\r\n'],
    ['into an empty file', '', -1, [], '""'],
    ['into a file of one line break', '\n', -1, ['v'], 'v\n'],
    ['into a BOM-only file', '\uFEFF', 0, ['v'], '\uFEFFv'],
    ['into a one-column CSV', 'a\nb\n', 0, [''], 'a\n""\nb\n'],
    ['with a value to quote', 'a,b\n', 0, ['x,1', ''], 'a,b\n"x,1",\n'],
  ])('inserts %s', (_, text, after, values, want) => {
    const out = applyPatch(text, insertRow(text, table(text), after, values))
    expect(out).toBe(want)
  })
})

describe('deleteRow', () => {
  it.each<[string, string, number, string]>([
    ['the first row', 'a\nb\nc\n', 0, 'b\nc\n'],
    ['the first row after a BOM', '\uFEFFa\nb\n', 0, '\uFEFFb\n'],
    ['a middle row', 'a\nb\nc\n', 1, 'a\nc\n'],
    ['the last row', 'a\nb\nc\n', 2, 'a\nb\n'],
    ['a last row without a line break', 'a\nb\nc', 2, 'a\nb'],
    ['a last row without one, CRLF', 'a\r\nb\r\nc', 2, 'a\r\nb'],
    ['the only row', 'a', 0, ''],
    // The empty line before keeps its line break, or it would be read as
    // the file's last line break and vanish
    ['a last row without one, after an empty line', 'a\n\nb', 2, 'a\n\n'],
    ['a row with a multi-line cell', 'a\n"b\nc",d\ne\n', 1, 'a\ne\n'],
  ])('deletes %s', (_, text, row, want) => {
    expect(applyPatch(text, deleteRow(text, table(text), row))).toBe(want)
  })
})

describe('patches on random files', () => {
  it('keep the row count and decode the new value', () => {
    const rand = rng(7)
    const values = ['', 'x', 'a,b', 'q"q', 'two\nlines', ' pad ', '😀', ';']
    let checked = 0
    while (checked < 300) {
      const delim = (['\t', ',', ';', '|'] as const)[checked % 4]
      const text = randomCsv(rand, delim)
      const t = table(text, delim)
      const value = values[Math.floor(rand() * values.length)]
      if (t.rowCount) {
        const row = Math.floor(rand() * t.rowCount)
        const col = Math.floor(rand() * (t.columnCount + 2))
        const cell = replaceCell(text, t, row, col, value)
        const edited = applyPatch(text, cell)
        const et = table(edited, delim)
        expect(et.rowCount).toBe(t.rowCount)
        expect(valueAt(edited, et, row, col)).toBe(value)
        expect(applyPatch(edited, invertPatch(cell))).toBe(text)

        const del = applyPatch(text, deleteRow(text, t, row))
        expect(table(del, delim).rowCount).toBe(t.rowCount - 1)
      }
      const after = Math.floor(rand() * (t.rowCount + 1)) - 1
      const added = applyPatch(text, insertRow(text, t, after, [value]))
      const at = table(added, delim)
      expect(at.rowCount).toBe(t.rowCount + 1)
      expect(valueAt(added, at, after + 1, 0)).toBe(value)
      checked++
    }
  })
})

describe('applyPatches and invertPatches', () => {
  const ps: Patch[] = [
    { start: 0, removed: 'a', inserted: 'xyz' },
    { start: 2, removed: '', inserted: '!' },
    { start: 3, removed: 'de', inserted: '' },
  ]

  it('applies patches placed on the text before them, in one pass', () => {
    expect(applyPatches('abcde', ps)).toBe('xyzb!c')
    expect(applyPatches('abc', [])).toBe('abc')
  })

  it('their inverse gives the text back', () => {
    expect(applyPatches('xyzb!c', invertPatches(ps))).toBe('abcde')
  })

  it('refuses a patch that does not match, or one before the last', () => {
    expect(() =>
      applyPatches('abc', [{ start: 1, removed: 'x', inserted: '' }]),
    ).toThrow('patch does not match the text')
    expect(() =>
      applyPatches('abc', [
        { start: 1, removed: 'b', inserted: '' },
        { start: 0, removed: 'a', inserted: '' },
      ]),
    ).toThrow('patch does not match the text')
  })
})

describe('insertColumn and deleteColumn', () => {
  const add = (text: string, col: number, d: Delimiter = ',') =>
    applyPatches(text, insertColumn(table(text, d), col))
  const drop = (text: string, col: number, d: Delimiter = ',') =>
    applyPatches(text, deleteColumn(text, table(text, d), col))

  it('adds an empty column at the start, the middle or the end', () => {
    const text = 'a,b\n1,2\n'
    expect(add(text, 0)).toBe(',a,b\n,1,2\n')
    expect(add(text, 1)).toBe('a,,b\n1,,2\n')
    expect(add(text, 2)).toBe('a,b,\n1,2,\n')
  })

  it('keeps quotes, CRLF, the BOM, a last row with no line break and the delimiter', () => {
    expect(add('\uFEFF"a,1";b\r\n"x\ny";z', 1, ';')).toBe(
      '\uFEFF"a,1";;b\r\n"x\ny";;z',
    )
    expect(add('a\tb\n1\t2', 2, '\t')).toBe('a\tb\t\n1\t2\t')
  })

  it('leaves a shorter row and a blank line as they are', () => {
    expect(add('a,b,c\n1\n\n4,5,6\n', 2)).toBe('a,b,,c\n1\n\n4,5,,6\n')
    // A row of exactly col cells gets the cell at its end
    expect(add('a,b,c\n1,2\n', 2)).toBe('a,b,,c\n1,2,\n')
  })

  it('deletes the first, a middle or the last column with one delimiter', () => {
    const text = 'a,"b,1",c\n1,2,3\n'
    expect(drop(text, 0)).toBe('"b,1",c\n2,3\n')
    expect(drop(text, 1)).toBe('a,c\n1,3\n')
    expect(drop(text, 2)).toBe('a,"b,1"\n1,2\n')
  })

  it('a row left with one empty cell writes it "", a blank line and a short row stay', () => {
    expect(drop('a,b\nx\n\n""\n1,2\n', 0)).toBe('b\n""\n\n""\n2\n')
    expect(drop('a,b\nx\n', 1)).toBe('a\nx\n')
    // The last row, no line break after it: still a row
    expect(drop('a,b\n,x', 1)).toBe('a\n""')
    expect(drop('a,b\n"",x', 1)).toBe('a\n""')
  })

  it('on any table and any column, an add or a delete undone is the text again', () => {
    const rand = rng(11)
    for (let i = 0; i < 300; i++) {
      const delim = (['\t', ',', ';', '|'] as const)[i % 4]
      const text = randomCsv(rand, delim)
      const t = table(text, delim)
      const before = rows(text, delim)
      for (let col = 0; col <= t.columnCount; col++) {
        const ins = insertColumn(t, col)
        const added = applyPatches(text, ins)
        expect(applyPatches(added, invertPatches(ins))).toBe(text)
        // Every row long enough, but a blank line, has an empty cell at col
        expect(rows(added, delim)).toEqual(
          before.map((v, r) =>
            v.length < col || blankRow(t, r)
              ? v
              : [...v.slice(0, col), '', ...v.slice(col)],
          ),
        )
        if (col === t.columnCount) continue
        const del = deleteColumn(text, t, col)
        const dropped = applyPatches(text, del)
        expect(applyPatches(dropped, invertPatches(del))).toBe(text)
        // Every row that had it lost cell col; none is gone
        expect(rows(dropped, delim)).toEqual(
          before.map((v) => {
            if (v.length <= col) return v
            const left = [...v.slice(0, col), ...v.slice(col + 1)]
            return left.length ? left : ['']
          }),
        )
      }
    }
  })
})

// Row r of t is a blank line: one cell, nothing written in it
function blankRow(t: CsvTable, r: number): boolean {
  const c = t.rowCells[r]
  return t.rowCells[r + 1] - c === 1 && t.cellStart[c] === t.cellEnd[c]
}

describe('replaceCells', () => {
  const set = (
    text: string,
    cells: { row: number; col: number; value: string }[],
  ) => applyPatches(text, replaceCells(text, table(text), cells))

  it('sets cells of several rows in one pass, quotes kept, short rows grown', () => {
    const text = 'a,"b",c\n1\n2,3,4\n'
    expect(
      set(text, [
        { row: 2, col: 2, value: 'z' },
        { row: 0, col: 1, value: 'B' },
        { row: 1, col: 2, value: 'y,1' },
        { row: 0, col: 0, value: 'A' },
      ]),
    ).toBe('A,"B",c\n1,,"y,1"\n2,3,z\n')
    // A short row: its own cells and the missing ones, one insert at its end
    expect(
      set('a,b,c\n1\n', [
        { row: 1, col: 0, value: 'x' },
        { row: 1, col: 1, value: 'y' },
      ]),
    ).toBe('a,b,c\nx,y\n')
  })

  it('on any table, cells set are read back, and undone give the text', () => {
    const rand = rng(5)
    for (let i = 0; i < 200; i++) {
      const text = randomCsv(rand)
      const t = table(text)
      if (!t.rowCount) continue
      const cells = Array.from({ length: 4 }, () => ({
        row: Math.floor(rand() * t.rowCount),
        col: Math.floor(rand() * (t.columnCount + 2)),
        value: ['', 'v', 'a,b', 'x\ny', '"'][Math.floor(rand() * 5)],
      }))
      const ps = replaceCells(text, t, cells)
      const out = applyPatches(text, ps)
      expect(applyPatches(out, invertPatches(ps))).toBe(text)
      const after = table(out)
      // The last value given for a cell is the one it holds
      const want = new Map(cells.map((c) => [`${c.row}:${c.col}`, c.value]))
      for (const [k, v] of want) {
        const [r, c] = k.split(':').map(Number)
        expect(valueAt(out, after, r, c)).toBe(v)
      }
      expect(after.rowCount).toBe(t.rowCount)
    }
  })
})
