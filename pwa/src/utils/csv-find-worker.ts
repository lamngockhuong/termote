/// <reference lib="webworker" />
// Finds values of a large table, or with a regex, off the main thread
// (csv-find-client.ts sends them here). Apart from the table's own worker:
// a search that runs too long ends this one only. It keeps the parse of the
// last text sent, so a new search does not send the text again.
import { compileFind, type FindOptions, findMatches } from './csv-find'
import { type Delimiter, parseCsv } from './csv-parse'
import { type ViewCache, viewCache } from './csv-view'

export interface FindRequest {
  id: number
  // A text to search from now on, parsed here; unset, the last one
  load?: { text: string; delimiter: Delimiter }
  rows: Int32Array
  cols: number[]
  opts: FindOptions
}

// Pairs (place in rows, place in cols), as findMatches gives them; failed:
// the search threw (a regex too deep for the engine's stack)
export interface FindReply {
  id: number
  matches: Int32Array
  failed?: boolean
}

let last: ViewCache | undefined

// The reply and the buffer moved (not copied) with it
export function handleFind(req: FindRequest): [FindReply, Transferable[]] {
  if (req.load) {
    const { text, delimiter } = req.load
    const res = parseCsv(text, delimiter)
    last = res.ok ? viewCache(text, res.table) : undefined
  }
  const match = compileFind(req.opts)
  let matches: Int32Array = new Int32Array()
  try {
    if (last && typeof match === 'function') {
      matches = findMatches(last, req.rows, req.cols, match)
    }
  } catch {
    return [{ id: req.id, matches, failed: true }, []]
  }
  return [{ id: req.id, matches }, [matches.buffer]]
}

// For tests: forget the last parse
export function resetFindWorker() {
  last = undefined
}

self.onmessage = (e: MessageEvent<FindRequest>) => {
  const [reply, transfer] = handleFind(e.data)
  self.postMessage(reply, { transfer })
}
