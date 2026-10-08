// Sorting and filtering of the table view: only which rows show and in what
// order, never the file. Runs on the main thread for a small file and in
// csv-parse-worker.ts for a large one.
import { type CsvTable, rowValues, valueAt } from './csv-parse'

export interface ViewOptions {
  sort: { col: number; dir: 'asc' | 'desc' } | null
  // Substring, any case, of any cell of the row
  filter: string
  // Row 0 is the header: never sorted or filtered out, never in the result
  header: boolean
}

// Decoded values of one parse, filled as views need them
export interface ViewCache {
  text: string
  table: CsvTable
  columns: Map<number, string[]>
  lower?: string[]
}

export function viewCache(text: string, table: CsvTable): ViewCache {
  return { text, table, columns: new Map() }
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

function column(cache: ViewCache, col: number): string[] {
  let values = cache.columns.get(col)
  if (!values) {
    const { text, table } = cache
    values = Array.from({ length: table.rowCount }, (_, r) =>
      valueAt(text, table, r, col),
    )
    cache.columns.set(col, values)
  }
  return values
}

// The rows to show, as row indices of the file
export function computeView(cache: ViewCache, opts: ViewOptions): Int32Array {
  const { text, table } = cache
  const first = opts.header ? 1 : 0
  let rows: number[] = []
  for (let r = first; r < table.rowCount; r++) rows.push(r)
  const needle = opts.filter.toLowerCase()
  if (needle) {
    cache.lower ??= Array.from({ length: table.rowCount }, (_, r) =>
      rowValues(text, table, r).join('\0').toLowerCase(),
    )
    const lower = cache.lower
    rows = rows.filter((r) => lower[r].includes(needle))
  }
  if (opts.sort) {
    const values = column(cache, opts.sort.col)
    const sign = opts.sort.dir === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      const va = values[a]
      const vb = values[b]
      // Empty cells last, whichever the direction
      if (!va || !vb) return (va ? 0 : 1) - (vb ? 0 : 1)
      return sign * collator.compare(va, vb)
    })
  }
  return Int32Array.from(rows)
}
