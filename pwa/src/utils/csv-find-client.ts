// The table's search worker (csv-find-worker.ts), apart from the one that
// parses it (csv-parse-client.ts). A search that takes too long, or that a
// newer one replaces while it runs, ends the worker: a regex can run for
// ever. It is never done on the main thread instead, where it would hang
// the page; the next search starts a new worker.
import type { FindOptions } from './csv-find'
import type { FindReply, FindRequest } from './csv-find-worker'
import type { Delimiter } from './csv-parse'
import { CSV_LOAD_TIMEOUT, CSV_TIMEOUT } from './csv-parse-client'

// The matches, or why there are none to show
export type FindResult = Int32Array | 'timeout' | 'failed' | 'unavailable'

interface Run {
  id: number
  // Ends the wait with result (null: the caller no longer wants it)
  done: (result: FindResult | null) => void
}

export class FindClient {
  private worker?: Worker
  private broken = false
  // The worker answered once: it loaded, a later answer has CSV_TIMEOUT
  private loaded = false
  // The text the worker holds the parse of
  private holds?: { text: string; delimiter: Delimiter }
  private nextId = 0
  private running?: Run

  // The cells of rows and cols that match (csv-find.ts findMatches); null
  // once signal aborts or a newer search replaced this one
  find(
    text: string,
    delimiter: Delimiter,
    rows: Int32Array,
    cols: number[],
    opts: FindOptions,
    signal?: AbortSignal,
  ): Promise<FindResult | null> {
    // One search at a time: the one running is no longer wanted
    this.stop(null)
    if (signal?.aborted) return Promise.resolve(null)
    const w = this.getWorker()
    if (!w) return Promise.resolve('unavailable')
    const same = this.holds?.text === text && this.holds.delimiter === delimiter
    this.holds = { text, delimiter }
    const id = ++this.nextId
    return new Promise((resolve) => {
      // Listened to only while this search runs
      const onAbort = () => this.stop(null)
      const timer = setTimeout(
        () => this.stop('timeout'),
        this.loaded ? CSV_TIMEOUT : CSV_LOAD_TIMEOUT,
      )
      this.running = {
        id,
        done: (result) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          this.running = undefined
          resolve(result)
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const req: FindRequest = {
        id,
        load: same ? undefined : { text, delimiter },
        rows,
        cols,
        opts,
      }
      w.postMessage(req)
    })
  }

  terminate() {
    this.stop(null)
    this.end()
  }

  // Ends the search running with result, and the worker busy with it
  private stop(result: FindResult | null) {
    const run = this.running
    if (!run) return
    this.end()
    run.done(result)
  }

  private end() {
    this.worker?.terminate()
    this.worker = undefined
    this.holds = undefined
    this.loaded = false
  }

  private onReply(reply: FindReply) {
    const run = this.running
    if (run?.id !== reply.id) return
    this.loaded = true
    run.done(reply.failed ? 'failed' : reply.matches)
  }

  // A worker that never answered cannot load: it is not tried again. One
  // that did broke on that search only; the next starts a new one.
  private fail() {
    if (!this.loaded) this.broken = true
    this.stop(this.broken ? 'unavailable' : 'failed')
    this.end()
  }

  private getWorker(): Worker | undefined {
    if (this.broken || typeof Worker === 'undefined') return undefined
    if (!this.worker) {
      const w = new Worker(new URL('./csv-find-worker.ts', import.meta.url), {
        type: 'module',
      })
      w.onmessage = (e: MessageEvent<FindReply>) => this.onReply(e.data)
      w.onerror = () => this.fail()
      w.onmessageerror = () => this.fail()
      this.worker = w
    }
    return this.worker
  }
}
