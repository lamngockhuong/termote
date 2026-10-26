/// <reference lib="webworker" />
// Reads an .xlsx in a worker (document-worker-client.ts): its sheet names
// first, then one sheet at a time as TSV for the table view. It keeps the
// file's bytes, never a parsed workbook: each sheet is read on its own, cut
// to the rows the table view takes.
import * as XLSX from 'xlsx'
import { serveDocumentRequests } from './document-worker-client'
import { SHEET_MAX_COLUMNS, type SheetTsv, toTsv } from './sheet-tsv'
import { checkZip, type ZipGuardCode, ZipGuardError } from './zip-guard'

// Rows read of a sheet: more than any sheet whose TSV fits in 1 MiB but for
// rows of one short cell, which are cut here instead
export const SHEET_ROWS = 100_000

export interface SheetInfo {
  name: string
  // Hidden or very hidden in Excel: no tab
  hidden: boolean
}

export type XlsxRequest =
  | { type: 'open'; buf: ArrayBuffer }
  | { type: 'sheet'; name: string }

export type XlsxReply =
  | { type: 'open'; sheets: SheetInfo[] }
  // totalRows: the sheet's rows, read or not
  | { type: 'sheet'; tsv: SheetTsv; totalRows: number }
  | { type: 'error'; code: ZipGuardCode | 'failed' }

// Nothing but the cells and their values as last saved: no formulas, no
// styles, no macros, no other parts of the file
const READ: XLSX.ParsingOptions = {
  type: 'array',
  cellFormula: false,
  cellHTML: false,
  cellStyles: false,
  bookVBA: false,
  bookFiles: false,
  bookProps: false,
  sheetStubs: false,
  WTF: false,
}

let book: Uint8Array | undefined

function open(buf: ArrayBuffer): XlsxReply {
  checkZip(buf)
  const bytes = new Uint8Array(buf)
  // The workbook part only (names, hidden states): no sheet is parsed
  const wb = XLSX.read(bytes, { ...READ, sheets: [] })
  book = bytes
  return { type: 'open', sheets: sheetInfos(wb) }
}

// The sheets in order; a file without their states (not from Excel) has
// none hidden
export function sheetInfos(wb: XLSX.WorkBook): SheetInfo[] {
  const states = wb.Workbook?.Sheets ?? []
  return wb.SheetNames.map((name, i) => ({
    name,
    hidden: (states[i]?.Hidden ?? 0) !== 0,
  }))
}

function sheet(name: string): XlsxReply {
  if (!book) return { type: 'error', code: 'failed' }
  const wb = XLSX.read(book, {
    ...READ,
    sheets: [name],
    sheetRows: SHEET_ROWS,
    dense: true,
  })
  const ws = wb.Sheets[name]
  if (!ws) return { type: 'error', code: 'failed' }
  // Cut at SHEET_ROWS: the rows the sheet declares (SheetJS keeps them in
  // !fullref); else the rows it holds, which a declared range alone (any
  // size) does not change
  const ref = ws['!ref']
  const full = ws['!fullref']
  const totalRows =
    full && full !== ref
      ? XLSX.utils.decode_range(full).e.r + 1
      : Math.min(
          // A dense read always has its rows
          (ws['!data'] as unknown[]).length,
          ref ? XLSX.utils.decode_range(ref).e.r + 1 : 0,
        )
  const tsv = toTsv(sheetRows(ws))
  return {
    type: 'sheet',
    tsv: { ...tsv, truncated: tsv.truncated || tsv.rows < totalRows },
    totalRows,
  }
}

// The cells from A1, as Excel lays them out: each its formatted value (w:
// dates, percentages, errors as Excel shows them), else its value; the rest
// of a merge and a missing cell empty. Made a row at a time, as toTsv takes
// them, and bounded by what the file holds, not by the range it declares (a
// tiny file can declare A1:XFD1048576): rows up to the last one with data,
// one column past those the table view shows, so a cut is still told.
export function* sheetRows(ws: XLSX.WorkSheet): Generator<string[]> {
  const ref = ws['!ref']
  if (!ref) return
  const { e } = XLSX.utils.decode_range(ref)
  const data = (ws['!data'] ?? []) as (XLSX.CellObject | undefined)[][]
  const rows = Math.min(e.r + 1, data.length)
  const cols = Math.min(e.c + 1, SHEET_MAX_COLUMNS + 1)
  for (let r = 0; r < rows; r++) {
    const row: string[] = []
    for (let c = 0; c < cols; c++) {
      const cell = data[r]?.[c]
      row.push(cell?.w ?? (cell?.v == null ? '' : String(cell.v)))
    }
    yield row
  }
}

// One request's reply; a file SheetJS cannot read is failed, never its error
export function handleXlsx(req: XlsxRequest): { reply: XlsxReply } {
  try {
    return { reply: req.type === 'open' ? open(req.buf) : sheet(req.name) }
  } catch (err) {
    if (err instanceof ZipGuardError)
      return { reply: { type: 'error', code: err.code } }
    return { reply: { type: 'error', code: 'failed' } }
  }
}

// For tests: forget the file
export function resetXlsxWorker() {
  book = undefined
}

serveDocumentRequests(self as never, handleXlsx)
