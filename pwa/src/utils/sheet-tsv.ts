// A sheet's cells as TSV text for the table view (TablePreview reads a .tsv
// path with a tab), at most the size the table view parses on the main
// thread when its worker fails (csv-parse-client.ts), and no wider than it
// shows. Cells that hold a tab, a quote or a line break are quoted (RFC 4180),
// so parseCsv reads each back as one cell.

// The text, in UTF-8 bytes, a sheet is cut to
export const SHEET_MAX_BYTES = 1 << 20
// MAX_COLUMNS of table-preview.tsx: the columns it shows
export const SHEET_MAX_COLUMNS = 200

export interface SheetTsv {
  text: string
  // Rows in text
  rows: number
  // Cut by size: fewer rows than given
  truncated: boolean
  // Cut to SHEET_MAX_COLUMNS: some row had more cells
  columnsCut: boolean
}

const encoder = new TextEncoder()

function cellText(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[\t"\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

// rows as TSV: whole rows only, while they fit in maxBytes. Rows are taken
// one at a time: none past the cut is made.
export function toTsv(
  rows: Iterable<readonly unknown[]>,
  maxBytes = SHEET_MAX_BYTES,
): SheetTsv {
  const lines: string[] = []
  let bytes = 0
  let columnsCut = false
  for (const row of rows) {
    if (row.length > SHEET_MAX_COLUMNS) columnsCut = true
    const line = `${row.slice(0, SHEET_MAX_COLUMNS).map(cellText).join('\t')}\n`
    bytes += encoder.encode(line).length
    if (bytes > maxBytes)
      return {
        text: lines.join(''),
        rows: lines.length,
        truncated: true,
        columnsCut,
      }
    lines.push(line)
  }
  return {
    text: lines.join(''),
    rows: lines.length,
    truncated: false,
    columnsCut,
  }
}
