// Cells on the clipboard as a spreadsheet puts them there: tab separated,
// one line a row, a value holding a tab, a line break or a quote in quotes
// with "" for a quote.
import { parseCsv, rowValues } from './csv-parse'

const NEEDS_QUOTES = /[\t\n\r"]/

export function toTsv(values: string[][]): string {
  return values
    .map((row) =>
      row
        .map((v) => (NEEDS_QUOTES.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
        .join('\t'),
    )
    .join('\n')
}

// The rows of a block, without the line break a spreadsheet ends it with.
// Every line break is \n, as in the text edited (a \r would be saved as a
// line break of another kind). Text whose quote never closes is one cell.
export function fromTsv(text: string): string[][] {
  const body = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  const p = parseCsv(body, '\t')
  if (!p.ok) return [[body]]
  return Array.from({ length: p.table.rowCount }, (_, r) =>
    rowValues(body, p.table, r),
  )
}
