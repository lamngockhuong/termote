// CSV/TSV for the table view of Files. RFC 4180, lenient like a spreadsheet:
// a quote in the middle of an unquoted cell is a character, not an error.
// Every cell keeps its raw range in the text it was parsed from (UTF-16
// indices of the JS string, the same string a save sends back), so an edit
// patches exactly that range and never rebuilds the file from the table.

export type Delimiter = ',' | ';' | '\t' | '|'

export const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|']

export const DELIMITER_NAMES: Record<Delimiter, string> = {
  ',': 'Comma',
  ';': 'Semicolon',
  '\t': 'Tab',
  '|': 'Pipe',
}

export interface CsvTable {
  delimiter: Delimiter
  bom: boolean
  // The first line break met; '\n' when there is none
  eol: '\n' | '\r\n'
  // The text ends with a line break
  trailingEol: boolean
  rowCount: number
  // Cells of the widest row
  columnCount: number
  // rowCount + 1 entries: the first cell of row r is rowCells[r]
  rowCells: Int32Array
  // Index just past the line break of row r (or text.length)
  rowEnd: Int32Array
  // Raw range of each cell, quotes included
  cellStart: Int32Array
  cellEnd: Int32Array
  cellQuoted: Uint8Array
}

export type CsvParse =
  | { ok: true; table: CsvTable }
  // A quote never closed: line (from 1) and index of its opening quote
  | { ok: false; line: number; offset: number }

const QUOTE = 34
const LF = 10
const CR = 13
const BOM = 0xfeff

// An Int32Array that doubles as it fills: no object per cell, even for the
// hundreds of thousands of cells of a 1 MiB file.
class Ints {
  a: Int32Array
  n = 0
  constructor(size: number) {
    this.a = new Int32Array(size)
  }
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    this.a[this.n++] = v
  }
  done(): Int32Array {
    return this.a.slice(0, this.n)
  }
}

export function parseCsv(text: string, delimiter: Delimiter): CsvParse {
  const len = text.length
  const bom = text.charCodeAt(0) === BOM
  const first = bom ? 1 : 0
  const d = delimiter.charCodeAt(0)
  const size = Math.max(16, Math.min(len >> 2, 1 << 20))
  const rowCells = new Ints(64)
  const rowEnd = new Ints(64)
  const cellStart = new Ints(size)
  const cellEnd = new Ints(size)
  const quoted = new Ints(size)
  let eol: '\n' | '\r\n' | undefined
  let columnCount = 0
  const rest = text.slice(first)
  // A file of nothing but one line break holds no row
  let p = rest === '\n' || rest === '\r\n' ? len : first
  while (p < len) {
    const firstCell = cellStart.n
    rowCells.push(firstCell)
    // One row: cells until a line break outside quotes, or the end
    for (;;) {
      const start = p
      let q = 0
      if (text.charCodeAt(p) === QUOTE) {
        q = 1
        p++
        for (;;) {
          if (p >= len) {
            let line = 1
            for (let i = 0; i < start; i++)
              if (text.charCodeAt(i) === LF) line++
            return { ok: false, line, offset: start }
          }
          if (text.charCodeAt(p) === QUOTE) {
            if (text.charCodeAt(p + 1) === QUOTE) p += 2
            else {
              p++
              break
            }
          } else p++
        }
      }
      // Unquoted text, or anything left after a closing quote, up to the
      // delimiter or the line break
      let c = text.charCodeAt(p)
      while (
        p < len &&
        c !== d &&
        c !== LF &&
        !(c === CR && text.charCodeAt(p + 1) === LF)
      ) {
        c = text.charCodeAt(++p)
      }
      cellStart.push(start)
      cellEnd.push(p)
      quoted.push(q)
      if (p < len && c === d) {
        p++
        continue
      }
      // End of the row
      if (p < len) {
        const crlf = c === CR
        eol ??= crlf ? '\r\n' : '\n'
        p += crlf ? 2 : 1
      }
      break
    }
    rowEnd.push(p)
    columnCount = Math.max(columnCount, cellStart.n - firstCell)
  }
  rowCells.push(cellStart.n)
  const quotedFlags = new Uint8Array(quoted.n)
  quotedFlags.set(quoted.a.subarray(0, quoted.n))
  return {
    ok: true,
    table: {
      delimiter,
      bom,
      eol: eol ?? '\n',
      trailingEol: text.charCodeAt(len - 1) === LF,
      rowCount: rowEnd.n,
      columnCount,
      rowCells: rowCells.done(),
      rowEnd: rowEnd.done(),
      cellStart: cellStart.done(),
      cellEnd: cellEnd.done(),
      cellQuoted: quotedFlags,
    },
  }
}

// Lines read by sniffDelimiter, and at most this much text
const SNIFF_LINES = 20
const SNIFF_CHARS = 64 * 1024

// The delimiter of a .csv: the candidate found the same number of times on
// each of the first lines (outside quotes), the most often; else the one
// found on every line the most; else ','. Ties go to the order of DELIMITERS.
export function sniffDelimiter(text: string): Delimiter {
  const counts: number[][] = DELIMITERS.map(() => [])
  let row = DELIMITERS.map(() => 0)
  let inQuotes = false
  let lines = 0
  let any = false
  const end = Math.min(text.length, SNIFF_CHARS)
  const flush = () => {
    if (any) {
      for (let i = 0; i < DELIMITERS.length; i++) counts[i].push(row[i])
    }
    row = DELIMITERS.map(() => 0)
    any = false
    lines++
  }
  for (let i = 0; i < end && lines < SNIFF_LINES; i++) {
    const ch = text[i]
    if (ch === '"') inQuotes = !inQuotes
    if (inQuotes) continue
    if (ch === '\n') {
      flush()
      continue
    }
    if (ch !== '\r') any = true
    const k = DELIMITERS.indexOf(ch as Delimiter)
    if (k >= 0) row[k]++
  }
  // The last line counts when the text ends there, not when SNIFF_CHARS cut
  // it, unless it is the only one
  if (lines < SNIFF_LINES && (end === text.length || !lines)) flush()
  let best: Delimiter = ','
  let bestStable = 0
  let bestMin = 0
  let fallback: Delimiter | undefined
  DELIMITERS.forEach((delim, i) => {
    const c = counts[i]
    if (!c.length) return
    const min = Math.min(...c)
    if (min === 0) return
    if (c.every((n) => n === c[0]) && c[0] > bestStable) {
      bestStable = c[0]
      best = delim
    } else if (min > bestMin) {
      bestMin = min
      fallback = delim
    }
  })
  return bestStable ? best : (fallback ?? ',')
}

const TABLE_EXT = /\.(csv|tsv|tab)$/i

export function isTablePath(path: string): boolean {
  return TABLE_EXT.test(path)
}

// .tsv/.tab are always tab-separated; a .csv is sniffed
export function delimiterFor(path: string, text: string): Delimiter {
  return /\.(tsv|tab)$/i.test(path) ? '\t' : sniffDelimiter(text)
}

// Number of cells in row r
export function cellsIn(t: CsvTable, row: number): number {
  return t.rowCells[row + 1] - t.rowCells[row]
}

// The value of a cell: quotes removed, "" read as one quote. Text after a
// closing quote (`"a"b`) is kept as written, as a spreadsheet does. With a
// limit, only the start is decoded (at least limit characters when the value
// is longer, "" counting two in the text): enough to show a 1 MiB cell.
export function cellValue(
  text: string,
  t: CsvTable,
  cell: number,
  limit = Number.POSITIVE_INFINITY,
): string {
  const start = t.cellStart[cell]
  const end = Math.min(t.cellEnd[cell], start + 2 * limit + 2)
  if (!t.cellQuoted[cell]) return text.slice(start, end)
  let out = ''
  let i = start + 1
  for (;;) {
    const close = text.indexOf('"', i)
    if (close < 0 || close >= end) return out + text.slice(i, end)
    out += text.slice(i, close)
    if (text.charCodeAt(close + 1) === QUOTE && close + 1 < t.cellEnd[cell]) {
      out += '"'
      i = close + 2
    } else return out + text.slice(close + 1, end)
  }
}

// The value at row, col; '' for a cell a short row does not have
export function valueAt(
  text: string,
  t: CsvTable,
  row: number,
  col: number,
  limit?: number,
): string {
  return col < cellsIn(t, row)
    ? cellValue(text, t, t.rowCells[row] + col, limit)
    : ''
}

// Every value of a row, as written (a short row stays short)
export function rowValues(text: string, t: CsvTable, row: number): string[] {
  const out: string[] = []
  for (let c = t.rowCells[row]; c < t.rowCells[row + 1]; c++) {
    out.push(cellValue(text, t, c))
  }
  return out
}
