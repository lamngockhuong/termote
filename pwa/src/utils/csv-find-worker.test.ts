import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FindOptions } from './csv-find'
import { handleFind, resetFindWorker } from './csv-find-worker'

const opts = (query: string, over: Partial<FindOptions> = {}): FindOptions => ({
  query,
  matchCase: false,
  wholeCell: false,
  regex: false,
  ...over,
})
const text = 'a,b\nbeta,x\ny,beta\n'
const rows = Int32Array.from([1, 2])

describe('csv find worker', () => {
  afterEach(() => {
    resetFindWorker()
    vi.restoreAllMocks()
  })

  it('finds in the text it loads, and moves the matches', () => {
    const [reply, transfer] = handleFind({
      id: 1,
      load: { text, delimiter: ',' },
      rows,
      cols: [0, 1],
      opts: opts('beta'),
    })
    expect(reply).toEqual({ id: 1, matches: Int32Array.from([0, 0, 1, 1]) })
    expect(transfer).toEqual([reply.matches.buffer])
  })

  it('keeps the parse for the next search, which sends no text', () => {
    handleFind({
      id: 1,
      load: { text, delimiter: ',' },
      rows,
      cols: [0, 1],
      opts: opts('beta'),
    })
    const [reply] = handleFind({
      id: 2,
      rows: Int32Array.from([2]),
      cols: [1],
      opts: opts('^B', { regex: true }),
    })
    expect(reply.matches).toEqual(Int32Array.from([0, 0]))
  })

  it('finds nothing with no text, a text that does not parse, or a bad regex', () => {
    const none = new Int32Array()
    const ask = (load?: { text: string; delimiter: ',' }, query = 'beta') =>
      handleFind({
        id: 1,
        load,
        rows,
        cols: [0],
        opts: opts(query, { regex: true }),
      })[0].matches
    expect(ask()).toEqual(none)
    expect(ask({ text: 'a\n"beta', delimiter: ',' })).toEqual(none)
    expect(ask({ text, delimiter: ',' }, '(')).toEqual(none)
  })

  it('says a search that throws failed, moving nothing', () => {
    // A row past the table has no value: matching it throws
    const [reply, transfer] = handleFind({
      id: 1,
      load: { text, delimiter: ',' },
      rows: Int32Array.from([99]),
      cols: [0],
      opts: opts('beta'),
    })
    expect(reply).toEqual({ id: 1, matches: new Int32Array(), failed: true })
    expect(transfer).toEqual([])
  })

  it('answers a message with a reply, moving the matches', () => {
    const post = vi.spyOn(self, 'postMessage').mockImplementation(() => {})
    const data = {
      id: 1,
      load: { text, delimiter: ',' },
      rows,
      cols: [0],
      opts: opts('beta'),
    }
    self.onmessage?.(new MessageEvent('message', { data }))
    const matches = Int32Array.from([0, 0])
    expect(post).toHaveBeenCalledWith(
      { id: 1, matches },
      { transfer: [expect.any(ArrayBuffer)] },
    )
  })
})
