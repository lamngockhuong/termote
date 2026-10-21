import { describe, expect, it } from 'vitest'
import {
  filledCells,
  findRow,
  makeOp,
  type Reapplied,
  reapply,
  redoOp,
  type TableAction,
  type TableOp,
  undoOp,
} from './csv-edits'
import { type CsvTable, type Delimiter, parseCsv } from './csv-parse'

function table(text: string, delimiter: Delimiter = ','): CsvTable {
  const res = parseCsv(text, delimiter)
  if (!res.ok) throw new Error('parse error')
  return res.table
}

// Applies actions one after another, as the table view does: each on the
// text the last one left, parsed again
function edit(
  text: string,
  actions: TableAction[],
  delimiter: Delimiter = ',',
  header = false,
) {
  const ops: TableOp[] = []
  let now = text
  for (const a of actions) {
    const op = makeOp(now, table(now, delimiter), a, header) as TableOp
    ops.push(op)
    now = redoOp(now, op)
  }
  return { text: now, ops }
}

const cell = (row: number, col: number, value: string): TableAction => ({
  kind: 'cell',
  row,
  col,
  name: `c${col}`,
  value,
})

function ok(r: Reapplied) {
  if (!r.ok) throw new Error('not a table')
  return r
}

const people = 'name,price\napple,1\npear,2\nplum,3\n'

describe('makeOp', () => {
  it('a cell op keeps its row, the values before and the patch', () => {
    const op = makeOp(people, table(people), cell(2, 1, '9')) as TableOp
    expect(op).toEqual({
      kind: 'cell',
      row: 2,
      col: 1,
      name: 'c1',
      before: '2',
      after: '9',
      rowValues: ['pear', '2'],
      patch: { start: 24, removed: '2', inserted: '9' },
    })
    expect(redoOp(people, op)).toBe('name,price\napple,1\npear,9\nplum,3\n')
  })

  it('a cell set to its own value makes no op', () => {
    expect(makeOp(people, table(people), cell(1, 0, 'apple'))).toBeUndefined()
    // A cell a short row lacks reads as empty
    expect(
      makeOp('a,b\nc\n', table('a,b\nc\n'), cell(1, 1, '')),
    ).toBeUndefined()
  })

  it('an inserted row has as many empty cells as the widest row, and its anchor', () => {
    const op = makeOp(people, table(people), {
      kind: 'insert',
      after: 1,
    }) as TableOp
    expect(op).toMatchObject({
      kind: 'insert',
      after: 1,
      anchor: ['apple', '1'],
      values: ['', ''],
    })
    expect(redoOp(people, op)).toBe('name,price\napple,1\n,\npear,2\nplum,3\n')
    const first = makeOp(people, table(people), {
      kind: 'insert',
      after: -1,
    }) as TableOp
    expect(first).toMatchObject({ anchor: null })
    expect(redoOp(people, first)).toBe(`,\n${people}`)
    // An empty file gets one cell, quoted so the row is not an empty line
    const empty = makeOp('', table(''), { kind: 'insert', after: -1 })
    expect(redoOp('', empty as TableOp)).toBe('""')
  })

  it('a delete keeps the values of the row it removed', () => {
    const op = makeOp(people, table(people), {
      kind: 'delete',
      row: 3,
    }) as TableOp
    expect(op).toMatchObject({
      kind: 'delete',
      row: 3,
      rowValues: ['plum', '3'],
    })
    expect(redoOp(people, op)).toBe('name,price\napple,1\npear,2\n')
  })

  it('undo gives back the text before the op, redo the text after', () => {
    const { text, ops } = edit(people, [
      cell(1, 1, 'a "quoted", value'),
      { kind: 'insert', after: 3 },
      cell(4, 0, 'fig'),
      { kind: 'delete', row: 2 },
    ])
    let now = text
    const seen = [now]
    for (const op of [...ops].reverse()) {
      now = undoOp(now, op)
      seen.push(now)
    }
    expect(now).toBe(people)
    for (const op of ops) now = redoOp(now, op)
    expect(now).toBe(text)
    expect(text).toBe('name,price\napple,"a ""quoted"", value"\nplum,3\nfig,\n')
    expect(new Set(seen).size).toBe(5)
  })
})

describe('findRow', () => {
  const t = table('a,b\nx,1\ny\nx,1\n')
  const text = 'a,b\nx,1\ny\nx,1\n'
  it('finds the one row with exactly those values', () => {
    expect(findRow(text, t, ['a', 'b'])).toBe(0)
    expect(findRow(text, t, ['y'])).toBe(2)
  })
  it('says when none or several match', () => {
    expect(findRow(text, t, ['x', '1'])).toBe('many')
    expect(findRow(text, t, ['y', ''])).toBe('none')
    expect(findRow(text, t, ['a', 'c'])).toBe('none')
  })
})

describe('reapply', () => {
  it('a row inserted above the edited one: the op follows its row, not its index', () => {
    // The user sets pear's price; the agent puts a row above pear whose
    // price is also 2, at pear's old index
    const { ops } = edit(people, [cell(2, 1, '9')])
    const agent = 'name,price\napple,1\nkiwi,2\npear,2\nplum,3\n'
    const r = ok(reapply(agent, ',', ops))
    expect(r.text).toBe('name,price\napple,1\nkiwi,2\npear,9\nplum,3\n')
    expect(r.skipped).toEqual([])
    expect(r.ops).toHaveLength(1)
    expect(r.ops[0]).toMatchObject({ kind: 'cell', row: 3, before: '2' })
    // The new op undoes on the new text
    expect(undoOp(r.text, r.ops[0])).toBe(agent)
  })

  it('a row deleted above: the op finds its row again', () => {
    const { ops } = edit(people, [cell(3, 1, '7')])
    const agent = 'name,price\npear,2\nplum,3\n'
    const r = ok(reapply(agent, ',', ops))
    expect(r.text).toBe('name,price\npear,2\nplum,7\n')
  })

  it('the edited row deleted: the op is skipped, saying why', () => {
    const { ops } = edit(people, [cell(2, 1, '9'), cell(3, 1, '8')])
    const r = ok(reapply('name,price\napple,1\nplum,3\n', ',', ops))
    expect(r.text).toBe('name,price\napple,1\nplum,8\n')
    expect(r.skipped).toEqual([{ op: ops[0], reason: 'missing' }])
    expect(r.ops).toHaveLength(1)
  })

  it('two identical rows: skipped, never guessed', () => {
    const { ops } = edit(people, [cell(2, 1, '9')])
    const agent = 'name,price\npear,2\napple,1\npear,2\n'
    const r = ok(reapply(agent, ',', ops))
    expect(r.text).toBe(agent)
    expect(r.skipped).toEqual([{ op: ops[0], reason: 'many' }])
  })

  it('a cell already holding the new value counts as applied, with nothing to undo', () => {
    const { ops } = edit(people, [cell(2, 1, '9'), cell(1, 1, '5')])
    const agent = 'name,price\napple,1\npear,9\nplum,3\nnew,0\n'
    const r = ok(reapply(agent, ',', ops))
    expect(r.text).toBe('name,price\napple,5\npear,9\nplum,3\nnew,0\n')
    expect(r.skipped).toEqual([])
    expect(r.ops.map((o) => o.kind === 'cell' && o.row)).toEqual([1])
  })

  it('a short row padded by its op is found once padded', () => {
    const text = 'a,b,c\nx\n'
    const { ops } = edit(text, [cell(1, 2, 'z')])
    expect(edit(text, [cell(1, 2, 'z')]).text).toBe('a,b,c\nx,,z\n')
    // Already in the file (same values with the cell set)
    expect(ok(reapply('a,b,c\nx,,z\n', ',', ops)).skipped).toEqual([])
    // Found as it was: padded the same way
    expect(ok(reapply('a,b,c\ny\nx\n', ',', ops)).text).toBe('a,b,c\ny\nx,,z\n')
  })

  it('several cells of one row follow each other', () => {
    const { ops } = edit(people, [cell(2, 0, 'Pear'), cell(2, 1, '9')])
    const r = ok(reapply(`name,price\nfig,0\n${people.slice(11)}`, ',', ops))
    expect(r.text).toBe('name,price\nfig,0\napple,1\nPear,9\nplum,3\n')
    expect(r.skipped).toEqual([])
  })

  it('an insert goes after its anchor, or first; a delete removes its row', () => {
    const { ops } = edit(people, [
      { kind: 'insert', after: 2 },
      cell(3, 0, 'new'),
      { kind: 'insert', after: -1 },
      { kind: 'delete', row: 2 },
    ])
    const agent = 'name,price\nzz,0\napple,1\npear,2\nplum,3\n'
    const r = ok(reapply(agent, ',', ops))
    expect(r.text).toBe(',\nname,price\nzz,0\npear,2\nnew,\nplum,3\n')
    expect(r.skipped).toEqual([])
    expect(r.ops).toHaveLength(4)
  })

  it('an insert whose anchor is gone skips every op after it', () => {
    const { ops } = edit(people, [
      cell(1, 1, '5'),
      { kind: 'insert', after: 2 },
      cell(3, 0, 'new'),
      cell(1, 0, 'Apple'),
    ])
    const r = ok(reapply('name,price\napple,1\nplum,3\n', ',', ops))
    expect(r.text).toBe('name,price\napple,5\nplum,3\n')
    expect(r.skipped).toEqual([
      { op: ops[1], reason: 'missing' },
      { op: ops[2], reason: 'depends' },
      { op: ops[3], reason: 'depends' },
    ])
  })

  it('a delete of a row found twice skips the ops after it', () => {
    const { ops } = edit(people, [{ kind: 'delete', row: 1 }, cell(1, 1, '8')])
    const r = ok(reapply('name,price\napple,1\napple,1\n', ',', ops))
    expect(r.skipped).toEqual([
      { op: ops[0], reason: 'many' },
      { op: ops[1], reason: 'depends' },
    ])
  })

  it('keeps the delimiter, the line breaks and the BOM of the new text', () => {
    const text = '﻿a;b\r\nx;1\r\n'
    const { ops } = edit(
      text,
      [cell(1, 1, 'q;r'), { kind: 'insert', after: 1 }],
      ';',
    )
    const r = ok(reapply('﻿a;b\r\ny;0\r\nx;1\r\n', ';', ops))
    expect(r.text).toBe('﻿a;b\r\ny;0\r\nx;"q;r"\r\n;\r\n')
  })

  it('says when the new text is no table', () => {
    const { ops } = edit(people, [cell(1, 1, '5')])
    expect(reapply('a,"b\n', ',', ops)).toEqual({ ok: false })
  })

  it('applies nothing to nothing', () => {
    expect(reapply('a,"b\n', ',', [])).toEqual({
      ok: true,
      text: 'a,"b\n',
      ops: [],
      skipped: [],
    })
  })
})

describe('column ops', () => {
  const addCol = (
    col: number,
    side: 'left' | 'right' = 'right',
  ): TableAction => ({
    kind: 'insert-col',
    col,
    side,
  })
  const dropCol = (col: number): TableAction => ({ kind: 'delete-col', col })

  it('an added column keeps its side, the name it is next to and the column count', () => {
    const { text, ops } = edit(people, [addCol(0)], ',', true)
    expect(text).toBe('name,,price\napple,,1\npear,,2\nplum,,3\n')
    expect(ops[0]).toMatchObject({
      kind: 'insert-col',
      col: 0,
      side: 'right',
      name: 'name',
      columns: 2,
    })
    expect(edit(people, [addCol(0, 'left')]).text).toBe(
      ',name,price\n,apple,1\n,pear,2\n,plum,3\n',
    )
    // No header row: no name
    expect(edit(people, [addCol(1)]).ops[0]).toMatchObject({ name: null })
  })

  it('a column with no name in the header is found by its place', () => {
    const { ops } = edit('a,\n1,2\n', [addCol(1)], ',', true)
    expect(ops[0]).toMatchObject({ name: null, columns: 2 })
  })

  it('a deleted column counts the values it took, the header not counted', () => {
    const text = 'a,b\n1,\n2,x\n'
    const { text: after, ops } = edit(text, [dropCol(1)], ',', true)
    expect(after).toBe('a\n1\n2\n')
    expect(ops[0]).toMatchObject({ kind: 'delete-col', name: 'b', values: 1 })
    expect(filledCells(text, table(text), 1, 0)).toBe(2)
    expect(filledCells(text, table(text), 1, 1)).toBe(1)
  })

  it('undo and redo a column op in one step; an older op with one patch still undoes', () => {
    const { text, ops } = edit(people, [addCol(1), cell(1, 2, 'x'), dropCol(0)])
    let now = text
    for (const op of [...ops].reverse()) now = undoOp(now, op)
    expect(now).toBe(people)
    for (const op of ops) now = redoOp(now, op)
    expect(now).toBe(text)
  })

  it('reapplied by name: at its place, or where the column moved', () => {
    const { ops } = edit(people, [addCol(1), dropCol(0)], ',', true)
    // Same columns, a row more
    expect(ok(reapply(`${people}fig,4\n`, ',', ops)).text).toBe(
      'price,\n1,\n2,\n3,\n4,\n',
    )
    // A column added in front: each op finds its column by name
    const r = ok(reapply('id,name,price\n1,apple,1\n', ',', ops))
    expect(r.text).toBe('id,price,\n1,1,\n')
    expect(r.skipped).toEqual([])
    expect(r.ops[0]).toMatchObject({ kind: 'insert-col', col: 2 })
  })

  it('its column gone, or two of that name: skipped, and every op after it', () => {
    const { ops } = edit(people, [dropCol(1), cell(1, 0, 'x')], ',', true)
    expect(ok(reapply('name,cost\napple,1\n', ',', ops)).skipped).toEqual([
      { op: ops[0], reason: 'column' },
      { op: ops[1], reason: 'depends' },
    ])
    expect(
      ok(reapply('price,name,price\n1,a,2\n', ',', ops)).skipped[0].reason,
    ).toBe('columns')
    // An empty file has no columns
    expect(ok(reapply('', ',', ops)).skipped[0].reason).toBe('column')
  })

  it('with no header row, applied while the table has as many columns', () => {
    const { ops } = edit(people, [dropCol(1)])
    expect(ok(reapply('x,y\n1,2\n', ',', ops)).text).toBe('x\n1\n')
    expect(ok(reapply('x,y,z\n1,2,3\n', ',', ops)).skipped).toEqual([
      { op: ops[0], reason: 'column' },
    ])
  })
})

describe('cells ops', () => {
  const block = (
    cells: [number, number, string][],
    addRows?: number,
  ): TableAction => ({
    kind: 'cells',
    cells: cells.map(([row, col, value]) => ({ row, col, value })),
    addRows,
  })

  it('a block sets its cells as one op, a value unchanged left out', () => {
    const { text, ops } = edit(people, [
      block([
        [1, 1, '9'],
        [2, 0, 'pear'],
        [2, 1, '8'],
      ]),
    ])
    expect(text).toBe('name,price\napple,9\npear,8\nplum,3\n')
    expect(ops[0]).toMatchObject({
      kind: 'cells',
      rows: [
        {
          rowValues: ['apple', '1'],
          cells: [{ col: 1, before: '1', after: '9' }],
        },
        {
          rowValues: ['pear', '2'],
          cells: [{ col: 1, before: '2', after: '8' }],
        },
      ],
      added: [],
    })
    expect(undoOp(text, ops[0])).toBe(people)
    // Nothing that changes: no op
    expect(
      makeOp(people, table(people), block([[1, 0, 'apple']])),
    ).toBeUndefined()
  })

  it('rows added at the end take the cells past the last row, with or without a last line break', () => {
    expect(
      edit(people, [
        block(
          [
            [3, 1, 'x'],
            [4, 0, 'fig'],
            [5, 1, '7'],
          ],
          2,
        ),
      ]).text,
    ).toBe('name,price\napple,1\npear,2\nplum,x\nfig,\n,7\n')
    const { text, ops } = edit('a,b\n1,2', [block([[2, 1, 'z']], 1)])
    expect(text).toBe('a,b\n1,2\n,z')
    expect(undoOp(text, ops[0])).toBe('a,b\n1,2')
  })

  it('reapplied: each row found by its values, rows added go at the new end', () => {
    const { ops } = edit(people, [
      block(
        [
          [1, 1, '9'],
          [4, 0, 'fig'],
        ],
        1,
      ),
    ])
    const r = ok(reapply('name,price\nkiwi,0\napple,1\npear,2\n', ',', ops))
    expect(r.text).toBe('name,price\nkiwi,0\napple,9\npear,2\nfig,\n')
    expect(r.skipped).toEqual([])
  })

  it('a row already holding its values counts as applied; a block with nothing left is none', () => {
    const { ops } = edit(people, [
      block([
        [1, 1, '9'],
        [2, 1, '8'],
      ]),
    ])
    const r = ok(reapply('name,price\napple,9\npear,2\n', ',', ops))
    expect(r.text).toBe('name,price\napple,9\npear,8\n')
    const done = ok(reapply('name,price\napple,9\npear,8\n', ',', ops))
    expect(done.ops).toEqual([])
  })

  it('a row gone or doubled skips the block; one that added rows skips the ops after it', () => {
    const { ops } = edit(people, [block([[1, 1, '9']]), cell(2, 1, '5')])
    expect(ok(reapply('name,price\npear,2\n', ',', ops)).skipped).toEqual([
      { op: ops[0], reason: 'missing' },
    ])
    expect(
      ok(reapply('name,price\napple,1\napple,1\npear,2\n', ',', ops)).skipped[0]
        .reason,
    ).toBe('many')
    const added = edit(people, [
      block(
        [
          [1, 1, '9'],
          [4, 0, 'x'],
        ],
        1,
      ),
      cell(4, 1, '5'),
    ]).ops
    expect(ok(reapply('name,price\npear,2\n', ',', added)).skipped).toEqual([
      { op: added[0], reason: 'missing' },
      { op: added[1], reason: 'depends' },
    ])
  })

  it('rows added again on a file with no row yet are rows, one a line', () => {
    const { ops } = edit('a\n1\n', [
      block(
        [
          [2, 0, 'x'],
          [3, 0, 'y'],
        ],
        2,
      ),
    ])
    const r = ok(reapply('', ',', ops))
    expect(r.text).toBe('x\ny')
    expect(undoOp(r.text, r.ops[0])).toBe('')
  })
})
