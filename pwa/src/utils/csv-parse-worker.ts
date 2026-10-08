/// <reference lib="webworker" />
// Parses, sorts and filters a large CSV off the main thread (csv-client.ts
// sends only text past CSV_WORKER_MIN here). It keeps its last parse, so a
// sort or a filter does not send the text again. It also applies the table
// view's edits again to a file that changed on the host.
import { type Reapplied, reapply, type TableOp } from './csv-edits'
import {
  type CsvParse,
  type CsvTable,
  type Delimiter,
  parseCsv,
} from './csv-parse'
import {
  computeView,
  type ViewCache,
  type ViewOptions,
  viewCache,
} from './csv-view'

export type CsvRequest =
  | { type: 'parse'; id: number; text: string; delimiter: Delimiter }
  | { type: 'view'; id: number; parseId: number; opts: ViewOptions }
  | {
      type: 'reapply'
      id: number
      text: string
      delimiter: Delimiter
      ops: TableOp[]
    }

export type CsvReply =
  | { type: 'parse'; id: number; result: CsvParse }
  // null: this worker no longer holds that parse; the caller sorts itself
  | { type: 'view'; id: number; rows: Int32Array | null }
  | { type: 'reapply'; id: number; result: Reapplied }

let last: { id: number; cache: ViewCache } | undefined

function copy(t: CsvTable): CsvTable {
  return {
    ...t,
    rowCells: t.rowCells.slice(),
    rowEnd: t.rowEnd.slice(),
    cellStart: t.cellStart.slice(),
    cellEnd: t.cellEnd.slice(),
    cellQuoted: t.cellQuoted.slice(),
  }
}

// The reply and the buffers moved (not copied) with it
export function handleRequest(req: CsvRequest): [CsvReply, Transferable[]] {
  if (req.type === 'parse') {
    const result = parseCsv(req.text, req.delimiter)
    if (!result.ok) {
      last = undefined
      return [{ type: 'parse', id: req.id, result }, []]
    }
    // The worker keeps a copy for views; the original goes to the page
    last = { id: req.id, cache: viewCache(req.text, copy(result.table)) }
    const t = result.table
    return [
      { type: 'parse', id: req.id, result },
      [
        t.rowCells.buffer,
        t.rowEnd.buffer,
        t.cellStart.buffer,
        t.cellEnd.buffer,
        t.cellQuoted.buffer,
      ],
    ]
  }
  if (req.type === 'reapply') {
    const result = reapply(req.text, req.delimiter, req.ops)
    return [{ type: 'reapply', id: req.id, result }, []]
  }
  if (last?.id !== req.parseId) {
    return [{ type: 'view', id: req.id, rows: null }, []]
  }
  const rows = computeView(last.cache, req.opts)
  return [{ type: 'view', id: req.id, rows }, [rows.buffer]]
}

// For tests: forget the last parse
export function resetWorkerState() {
  last = undefined
}

self.onmessage = (e: MessageEvent<CsvRequest>) => {
  const [reply, transfer] = handleRequest(e.data)
  self.postMessage(reply, { transfer })
}
