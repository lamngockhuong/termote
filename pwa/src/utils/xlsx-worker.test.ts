import { afterEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { SHEET_MAX_BYTES, SHEET_MAX_COLUMNS, toTsv } from './sheet-tsv'
import {
  handleXlsx,
  resetXlsxWorker,
  SHEET_ROWS,
  sheetInfos,
  sheetRows,
} from './xlsx-worker'

// The worker's global scope, in place of the page's before the module loads
const scope = vi.hoisted(() => {
  const posted: unknown[] = []
  const s = {
    posted,
    onmessage: null as ((e: MessageEvent) => Promise<void>) | null,
    postMessage: (msg: unknown) => posted.push(msg),
  }
  ;(globalThis as { self: unknown }).self = s
  return s
})

// A workbook as Excel would save it: values cached for formulas, number
// formats, a merge, an error, a hidden sheet
function workbook(): ArrayBuffer {
  const cases: XLSX.WorkSheet = {
    A1: { t: 's', v: 'Case' },
    B1: { t: 's', v: 'Result' },
    A2: { t: 'n', v: 2 },
    B2: { t: 'n', v: 4, f: 'A2*2' },
    A3: { t: 's', v: 'merged' },
    A4: { t: 'n', v: 45292, z: 'yyyy-mm-dd' },
    B4: { t: 'n', v: 0.25, z: '0%' },
    A5: { t: 'e', v: 0x07 },
    B5: { t: 's', v: 'tab\tin "cell"' },
    '!ref': 'A1:B5',
    '!merges': [{ s: { r: 2, c: 0 }, e: { r: 2, c: 1 } }],
  }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, cases, 'Cases')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Notes')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['s']]), 'Secret')
  wb.Workbook = { Sheets: [{}, {}, { Hidden: 1 }] }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}

const ask = (req: Parameters<typeof handleXlsx>[0]) => handleXlsx(req).reply

afterEach(() => resetXlsxWorker())

describe('xlsx worker', () => {
  it('serves requests in its scope once loaded', async () => {
    expect(scope.posted).toEqual([{ ready: true }])
    await scope.onmessage?.(
      new MessageEvent('message', {
        data: { id: 1, req: { type: 'sheet', name: 'x' } },
      }),
    )
    expect(scope.posted[1]).toEqual({
      id: 1,
      reply: { type: 'error', code: 'failed' },
    })
  })

  it('lists the sheets in order, hidden ones marked', () => {
    expect(ask({ type: 'open', buf: workbook() })).toEqual({
      type: 'open',
      sheets: [
        { name: 'Cases', hidden: false },
        { name: 'Notes', hidden: false },
        { name: 'Secret', hidden: true },
      ],
    })
  })

  it('reads a sheet as Excel shows it: values, formats, merges, errors', () => {
    ask({ type: 'open', buf: workbook() })
    const r = ask({ type: 'sheet', name: 'Cases' })
    expect(r).toEqual({
      type: 'sheet',
      totalRows: 5,
      tsv: {
        text: 'Case\tResult\n2\t4\nmerged\t\n2024-01-01\t25%\n#DIV/0!\t"tab\tin ""cell"""\n',
        rows: 5,
        truncated: false,
        columnsCut: false,
      },
    })
    // Another sheet, from the same bytes
    expect(ask({ type: 'sheet', name: 'Notes' })).toMatchObject({
      tsv: { text: 'x\n' },
    })
  })

  it('cuts a sheet larger than the table view takes', () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => [
      `row ${i}`,
      'x'.repeat(40),
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Big')
    ask({
      type: 'open',
      buf: XLSX.write(wb, { type: 'array', bookType: 'xlsx' }),
    })
    const r = ask({ type: 'sheet', name: 'Big' })
    if (r.type !== 'sheet') throw new Error(r.type)
    expect(r.totalRows).toBe(30_000)
    expect(r.tsv.truncated).toBe(true)
    expect(r.tsv.rows).toBeLessThan(30_000)
    expect(new TextEncoder().encode(r.tsv.text).length).toBeLessThanOrEqual(
      SHEET_MAX_BYTES,
    )
  })

  it('says a sheet was cut by rows read when it fits in size', () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([['a']])
    // Declares more rows than are read
    ws['!ref'] = `A1:A${SHEET_ROWS + 10}`
    ws[`A${SHEET_ROWS + 10}`] = { t: 's', v: 'last' }
    XLSX.utils.book_append_sheet(wb, ws, 'Long')
    ask({
      type: 'open',
      buf: XLSX.write(wb, { type: 'array', bookType: 'xlsx' }),
    })
    const r = ask({ type: 'sheet', name: 'Long' })
    expect(r).toMatchObject({
      type: 'sheet',
      totalRows: SHEET_ROWS + 10,
      tsv: { truncated: true },
    })
  })

  it('reads an empty sheet', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, {}, 'Empty')
    ask({
      type: 'open',
      buf: XLSX.write(wb, { type: 'array', bookType: 'xlsx' }),
    })
    expect(ask({ type: 'sheet', name: 'Empty' })).toMatchObject({
      totalRows: 0,
      tsv: { text: '', rows: 0, truncated: false },
    })
  })

  it('fails a sheet asked for before a file, or not in it', () => {
    expect(ask({ type: 'sheet', name: 'Cases' })).toEqual({
      type: 'error',
      code: 'failed',
    })
    ask({ type: 'open', buf: workbook() })
    expect(ask({ type: 'sheet', name: 'Nope' })).toEqual({
      type: 'error',
      code: 'failed',
    })
  })

  it('refuses what the zip guard refuses, before SheetJS reads it', () => {
    expect(ask({ type: 'open', buf: new ArrayBuffer(10) })).toEqual({
      type: 'error',
      code: 'corrupt',
    })
  })

  it('fails a zip that is no workbook, without its error', () => {
    // A well-formed zip SheetJS cannot read as a workbook
    const cfb = XLSX.CFB.utils.cfb_new({ fileType: 'zip' } as never)
    XLSX.CFB.utils.cfb_add(cfb, 'readme.txt', new TextEncoder().encode('hi'))
    // CFB writes a plain array of bytes
    const zip = new Uint8Array(
      XLSX.CFB.write(cfb, { type: 'array', fileType: 'zip' }),
    ).buffer
    const r = ask({ type: 'open', buf: zip })
    expect(r).toEqual({ type: 'error', code: 'failed' })
  })

  it('lays a sheet out from A1, empty where no cell is', () => {
    expect([
      ...sheetRows({
        '!ref': 'B2:C3',
        '!data': [
          [],
          [undefined, { t: 'n', v: 5 }, { t: 's', v: 'x', w: 'x' }],
          undefined as never,
        ],
      } as XLSX.WorkSheet),
    ]).toEqual([
      ['', '', ''],
      ['', '5', 'x'],
      ['', '', ''],
    ])
    expect([...sheetRows({ '!ref': 'A1' } as XLSX.WorkSheet)]).toEqual([])
    expect([...sheetRows({} as XLSX.WorkSheet)]).toEqual([])
  })

  it('reads a sheet by its cells, not by the range it declares', () => {
    // A small file can declare every cell of Excel's grid
    const ws = {
      '!ref': 'A1:XFD1048576',
      '!data': [[{ t: 's', v: 'a', w: 'a' }]],
    } as unknown as XLSX.WorkSheet
    const rows = [...sheetRows(ws)]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveLength(SHEET_MAX_COLUMNS + 1)
    // Many rows with data: made only while they fit
    const tall = {
      '!ref': 'A1:XFD100000',
      '!data': Array.from({ length: 100_000 }, () => [
        { t: 's', v: 'x', w: 'x' },
      ]),
    } as unknown as XLSX.WorkSheet
    const started = Date.now()
    const tsv = toTsv(sheetRows(tall))
    expect(tsv).toMatchObject({ truncated: true, columnsCut: true })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('takes a workbook without sheet states as all shown', () => {
    expect(
      sheetInfos({ SheetNames: ['a', 'b'], Sheets: {} } as XLSX.WorkBook),
    ).toEqual([
      { name: 'a', hidden: false },
      { name: 'b', hidden: false },
    ])
    expect(
      sheetInfos({
        SheetNames: ['a', 'b'],
        Sheets: {},
        Workbook: { Sheets: [{ Hidden: 2 }] },
      } as XLSX.WorkBook),
    ).toEqual([
      { name: 'a', hidden: true },
      { name: 'b', hidden: false },
    ])
  })
})
