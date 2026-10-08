import { describe, expect, it } from 'vitest'
import {
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
) {
  const ops: TableOp[] = []
  let now = text
  for (const a of actions) {
    const op = makeOp(now, table(now, delimiter), a) as TableOp
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
