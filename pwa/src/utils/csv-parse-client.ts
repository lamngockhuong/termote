// The table view's worker (csv-parse-worker.ts), one per open table. Every
// answer comes back: a worker that fails to load, breaks or takes too long
// is ended, and the work is done on the main thread instead (the text is at
// most 1 MiB), so a table never stays at "parsing".
import { type CsvParse, type Delimiter, parseCsv } from './csv-parse'
import type { CsvReply, CsvRequest } from './csv-parse-worker'
import type { ViewOptions } from './csv-view'

// Text up to this many UTF-16 units (a lower bound of its UTF-8 size) is
// parsed, sorted and filtered on the main thread.
export const CSV_WORKER_MIN = 256 * 1024
// Loading the worker on a slow network, then its first answer
export const CSV_LOAD_TIMEOUT = 30000
// Any later answer, counted from when the worker gets the request
export const CSV_TIMEOUT = 10000

interface Job {
  req: CsvRequest
  resolve: (reply: CsvReply | null) => void
  // Its caller stopped waiting; the worker may still be busy with it
  dropped: boolean
}

// One request in the worker at a time: a request whose caller gave up while
// it waited is never sent, and the timeout of the one sent counts only its
// own work, never a queue the worker is still busy with.
export class CsvClient {
  private worker?: Worker
  private broken = false
  private loaded = false
  private nextId = 0
  private queue: Job[] = []
  private running?: { job: Job; timer: ReturnType<typeof setTimeout> }

  // The parse and its id (what view() names); null once signal aborts.
  // Small text, or no working worker: parsed here.
  async parse(
    text: string,
    delimiter: Delimiter,
    signal?: AbortSignal,
  ): Promise<{ id: number; result: CsvParse } | null> {
    const id = ++this.nextId
    const reply = await this.send(
      text.length > CSV_WORKER_MIN
        ? { type: 'parse', id, text, delimiter }
        : undefined,
      signal,
    )
    if (signal?.aborted) return null
    return {
      id,
      result:
        reply?.type === 'parse' ? reply.result : parseCsv(text, delimiter),
    }
  }

  // The rows of a view of the parse `parseId`; fallback computes them here
  // when the worker cannot. null once signal aborts.
  async view(
    parseId: number,
    opts: ViewOptions,
    fallback: () => Int32Array,
    signal?: AbortSignal,
  ): Promise<Int32Array | null> {
    const reply = await this.send(
      { type: 'view', id: ++this.nextId, parseId, opts },
      signal,
    )
    if (signal?.aborted) return null
    return (reply?.type === 'view' && reply.rows) || fallback()
  }

  terminate() {
    this.fail()
  }

  // The worker's reply, or null to do the work here
  private send(
    req: CsvRequest | undefined,
    signal?: AbortSignal,
  ): Promise<CsvReply | null> {
    if (!req || signal?.aborted || !this.getWorker()) {
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        job.dropped = true
        const i = this.queue.indexOf(job)
        if (i >= 0) this.queue.splice(i, 1)
        resolve(null)
      }
      const job: Job = {
        req,
        dropped: false,
        resolve: (reply) => {
          signal?.removeEventListener('abort', onAbort)
          if (!job.dropped) resolve(reply)
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(job)
      this.runNext()
    })
  }

  private runNext() {
    const w = this.worker
    if (this.running || !w) return
    const job = this.queue.shift()
    if (!job) return
    this.running = {
      job,
      timer: setTimeout(
        () => this.fail(),
        this.loaded ? CSV_TIMEOUT : CSV_LOAD_TIMEOUT,
      ),
    }
    w.postMessage(job.req)
  }

  private onReply(reply: CsvReply) {
    const run = this.running
    if (run?.job.req.id !== reply.id) return
    this.loaded = true
    clearTimeout(run.timer)
    this.running = undefined
    run.job.resolve(reply)
    this.runNext()
  }

  // Ends the worker for good: what is pending is done here
  private fail() {
    this.broken = true
    this.worker?.terminate()
    this.worker = undefined
    const jobs = this.queue.splice(0)
    if (this.running) {
      clearTimeout(this.running.timer)
      jobs.unshift(this.running.job)
      this.running = undefined
    }
    for (const job of jobs) job.resolve(null)
  }

  private getWorker(): Worker | undefined {
    if (this.broken || typeof Worker === 'undefined') return undefined
    if (!this.worker) {
      const w = new Worker(new URL('./csv-parse-worker.ts', import.meta.url), {
        type: 'module',
      })
      w.onmessage = (e: MessageEvent<CsvReply>) => this.onReply(e.data)
      w.onerror = () => this.fail()
      w.onmessageerror = () => this.fail()
      this.worker = w
    }
    return this.worker
  }
}
