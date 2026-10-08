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
