import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCsv } from './csv-parse'
import { handleRequest, resetWorkerState } from './csv-parse-worker'

const opts = { sort: null, filter: '', header: true }

describe('csv parse worker', () => {
  afterEach(() => {
    resetWorkerState()
    vi.restoreAllMocks()
  })

  it('answers a parse like parseCsv and moves its arrays', () => {
    const text = 'a,b\n1,2\n'
    const [reply, transfer] = handleRequest({
      type: 'parse',
      id: 1,
      text,
      delimiter: ',',
    })
    expect(reply).toEqual({ type: 'parse', id: 1, result: parseCsv(text, ',') })
    expect(transfer).toHaveLength(5)
  })

  it('answers a view of its last parse, after the page took the arrays', () => {
    const text = 'h\nb\na\n'
    const [parsed, transfer] = handleRequest({
      type: 'parse',
      id: 1,
      text,
      delimiter: ',',
    })
    // What a transfer does to the page's copy: the worker kept its own
    structuredClone(parsed, { transfer })
    const [reply, moved] = handleRequest({
      type: 'view',
      id: 2,
      parseId: 1,
      opts: { ...opts, sort: { col: 0, dir: 'asc' } },
    })
    expect(reply.type === 'view' && Array.from(reply.rows ?? [])).toEqual([
      2, 1,
    ])
    expect(moved).toHaveLength(1)
  })

  it('answers null for a view of another parse', () => {
    handleRequest({ type: 'parse', id: 1, text: 'a', delimiter: ',' })
    const [reply] = handleRequest({ type: 'view', id: 2, parseId: 9, opts })
    expect(reply).toEqual({ type: 'view', id: 2, rows: null })
  })

  it('forgets its table after a parse error', () => {
    handleRequest({ type: 'parse', id: 1, text: 'a', delimiter: ',' })
    const [err, transfer] = handleRequest({
      type: 'parse',
      id: 2,
      text: '"open',
      delimiter: ',',
    })
    expect(err).toEqual({
      type: 'parse',
      id: 2,
      result: { ok: false, line: 1, offset: 0 },
    })
    expect(transfer).toEqual([])
    const [reply] = handleRequest({ type: 'view', id: 3, parseId: 2, opts })
    expect(reply).toEqual({ type: 'view', id: 3, rows: null })
  })

  it('replies to each message with its buffers', () => {
    const post = vi.spyOn(self, 'postMessage').mockImplementation(() => {})
    self.onmessage?.(
      new MessageEvent('message', {
        data: { type: 'parse', id: 4, text: '"x', delimiter: ',' },
      }),
    )
    expect(post).toHaveBeenCalledWith(
      { type: 'parse', id: 4, result: { ok: false, line: 1, offset: 0 } },
      { transfer: [] },
    )
  })
})
