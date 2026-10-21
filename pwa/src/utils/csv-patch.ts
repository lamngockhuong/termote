// Edits of a CSV text as patches of its raw ranges (csv-parse.ts): a changed
// cell rewrites only its own characters, and every other byte of the file
// stays as it was. A patch keeps both sides, so undo is the inverse patch.
import { type CsvTable, cellsIn, type Delimiter } from './csv-parse'

// Replaces text.slice(start, start + removed.length), which must equal
// removed, with inserted.
export interface Patch {
  start: number
  removed: string
  inserted: string
}

export function applyPatch(text: string, p: Patch): string {
  const end = p.start + p.removed.length
  if (text.slice(p.start, end) !== p.removed) {
    throw new Error('patch does not match the text')
  }
  return text.slice(0, p.start) + p.inserted + text.slice(end)
}

export function invertPatch(p: Patch): Patch {
  return { start: p.start, removed: p.inserted, inserted: p.removed }
}

// Several patches at once: in order of start, none overlapping, each start
// a place in the text before any of them
export function applyPatches(text: string, ps: Patch[]): string {
  const out: string[] = []
  let at = 0
  for (const p of ps) {
    const end = p.start + p.removed.length
    if (p.start < at || text.slice(p.start, end) !== p.removed) {
      throw new Error('patch does not match the text')
    }
    out.push(text.slice(at, p.start), p.inserted)
    at = end
  }
  out.push(text.slice(at))
  return out.join('')
}

// The patches that undo ps, at their places in the text ps made
export function invertPatches(ps: Patch[]): Patch[] {
  let shift = 0
  return ps.map((p) => {
    const inv = {
      start: p.start + shift,
      removed: p.inserted,
      inserted: p.removed,
    }
    shift += p.inserted.length - p.removed.length
    return inv
  })
}

// A value as written in a cell: quoted when the old cell was (the file's own
// style), or when it holds the delimiter, a quote, a line break, or space at
// either end; an empty value alone on its row is "" so the row is not an
// empty line.
export function quoteValue(
  value: string,
  delimiter: Delimiter,
  wasQuoted = false,
  onlyCell = false,
): string {
  const needs =
    wasQuoted ||
    (onlyCell && value === '') ||
    value.includes(delimiter) ||
    /["\r\n]|^\s|\s$/.test(value)
  return needs ? `"${value.replace(/"/g, '""')}"` : value
}

// Sets the cell at row, col. A short row (fewer cells than col + 1) gets the
// missing delimiters and the value after its last cell, before its line
// break.
export function replaceCell(
  text: string,
  t: CsvTable,
  row: number,
  col: number,
  value: string,
): Patch {
  const n = cellsIn(t, row)
  if (col < n) {
    const cell = t.rowCells[row] + col
    const start = t.cellStart[cell]
    return {
      start,
      removed: text.slice(start, t.cellEnd[cell]),
      inserted: quoteValue(
        value,
        t.delimiter,
        t.cellQuoted[cell] === 1,
        n === 1,
      ),
    }
  }
  return {
    start: t.cellEnd[t.rowCells[row + 1] - 1],
    removed: '',
    inserted: t.delimiter.repeat(col - n + 1) + quoteValue(value, t.delimiter),
  }
}

// Sets several cells at once, as patches in order. The cells a short row
// does not have go in one insert at its end, with the missing delimiters.
export function replaceCells(
  text: string,
  t: CsvTable,
  cells: { row: number; col: number; value: string }[],
): Patch[] {
  const byRow = new Map<number, Map<number, string>>()
  for (const c of cells) {
    const row = byRow.get(c.row) ?? new Map<number, string>()
    row.set(c.col, c.value)
    byRow.set(c.row, row)
  }
  const out: Patch[] = []
  for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
    const row = byRow.get(r) as Map<number, string>
    const n = cellsIn(t, r)
    const cols = [...row.keys()].sort((a, b) => a - b)
    for (const c of cols) {
      if (c < n) out.push(replaceCell(text, t, r, c, row.get(c) as string))
    }
    // Past the row's end: its missing cells up to the last one set
    const last = cols[cols.length - 1]
    if (last < n) continue
    let tail = ''
    for (let c = n; c <= last; c++) {
      tail += t.delimiter + quoteValue(row.get(c) ?? '', t.delimiter)
    }
    out.push({
      start: t.cellEnd[t.rowCells[r + 1] - 1],
      removed: '',
      inserted: tail,
    })
  }
  return out
}

// Inserts a row after row `after` (-1: first, after the BOM), with the
// file's delimiter and line break and max(columnCount, 1) cells.
export function insertRow(
  text: string,
  t: CsvTable,
  after: number,
  values: string[],
): Patch {
  const cells = Math.max(t.columnCount, 1)
  const all = [...values]
  while (all.length < cells) all.push('')
  const line = all
    .map((v) => quoteValue(v, t.delimiter, false, all.length === 1))
    .join(t.delimiter)
  const head = t.bom ? 1 : 0
  // No row yet: whatever line break the file holds stays after the new row
  if (t.rowCount === 0) return { start: head, removed: '', inserted: line }
  if (after < 0) return { start: head, removed: '', inserted: line + t.eol }
  const start = t.rowEnd[after]
  // After a last row without a line break: the row gets one before it, and
  // the file still ends without one
  if (start === text.length && !t.trailingEol) {
    return { start, removed: '', inserted: t.eol + line }
  }
  return { start, removed: '', inserted: line + t.eol }
}

// Removes a row with its line break. A last row without one takes the line
// break before it instead, so the file keeps ending as it did; unless the
// row before is an empty line, which would then read as that line break.
export function deleteRow(text: string, t: CsvTable, row: number): Patch {
  let start = t.cellStart[t.rowCells[row]]
  const end = t.rowEnd[row]
  if (end === text.length && !t.trailingEol && row > 0) {
    const prev = t.rowCells[row - 1]
    const emptyLine =
      cellsIn(t, row - 1) === 1 && t.cellStart[prev] === t.cellEnd[prev]
    if (!emptyLine) {
      start = t.rowEnd[row - 1] - (text[t.rowEnd[row - 1] - 2] === '\r' ? 2 : 1)
    }
  }
  return { start, removed: text.slice(start, end), inserted: '' }
}

// A blank line: one cell, nothing in it. A column added or deleted leaves
// it as it is, a blank line still.
function blank(t: CsvTable, row: number): boolean {
  const cell = t.rowCells[row]
  return cellsIn(t, row) === 1 && t.cellStart[cell] === t.cellEnd[cell]
}

// An empty column at col: a delimiter in each row that has at least col
// cells, before its cell col (or after its last one). A shorter row, or a
// blank line, stays as it is.
export function insertColumn(t: CsvTable, col: number): Patch[] {
  const out: Patch[] = []
  for (let r = 0; r < t.rowCount; r++) {
    const n = cellsIn(t, r)
    if (n < col || blank(t, r)) continue
    const first = t.rowCells[r]
    const start = col < n ? t.cellStart[first + col] : t.cellEnd[first + n - 1]
    out.push({ start, removed: '', inserted: t.delimiter })
  }
  return out
}

// Column col out of each row that has it, with one delimiter next to it
// (the one before, or after the first cell). A row left with one empty cell
// or none writes it "", so it does not become a blank line (and a last one,
// with no line break, no row at all); a blank line stays.
export function deleteColumn(text: string, t: CsvTable, col: number): Patch[] {
  const out: Patch[] = []
  for (let r = 0; r < t.rowCount; r++) {
    const n = cellsIn(t, r)
    if (n <= col || blank(t, r)) continue
    const first = t.rowCells[r]
    const cell = first + col
    // The cell left when there are two
    const other = first + (col === 0 ? 1 : 0)
    let start: number
    let end: number
    let inserted = ''
    if (n === 1 || (n === 2 && t.cellStart[other] === t.cellEnd[other])) {
      start = t.cellStart[first]
      end = t.cellEnd[first + n - 1]
      inserted = quoteValue('', t.delimiter, false, true)
    } else if (col > 0) {
      start = t.cellEnd[cell - 1]
      end = t.cellEnd[cell]
    } else {
      start = t.cellStart[cell]
      end = t.cellStart[cell + 1]
    }
    out.push({ start, removed: text.slice(start, end), inserted })
  }
  return out
}
