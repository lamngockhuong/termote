// The worker of one open document (an .xlsx or .docx parser), never run on
// the main thread: the file can be 30 MiB and its parse unbounded. A worker
// that fails to load, breaks or takes too long is terminated and every
// request waiting on it fails; the caller opens a new client from the bytes
// it still holds.

// Loading the worker (its chunks can be large) on a slow network
export const DOC_LOAD_TIMEOUT = 30000
// One request, counted from when the worker gets it
export const DOC_TIMEOUT = 20000

// timeout: a request took too long (the worker was ended); dead: the worker
// failed to load, broke or was terminated; failed: the request threw in the
// worker; aborted: its caller stopped waiting
export type DocumentWorkerFailure = 'timeout' | 'dead' | 'failed' | 'aborted'

export class DocumentWorkerError extends Error {
  constructor(readonly code: DocumentWorkerFailure) {
    super(`document worker: ${code}`)
  }
}

// What goes over the port: the worker says it is ready once, then answers
// each request by its id
type ToWorker<Req> = { id: number; req: Req }
type FromWorker<Reply> =
  | { ready: true }
  | { id: number; reply: Reply }
  | { id: number; failed: true }

interface Job<Req, Reply> {
  msg: ToWorker<Req>
  transfer: Transferable[]
  resolve: (reply: Reply) => void
  reject: (err: DocumentWorkerError) => void
}

// One request in the worker at a time, in the order asked: a request whose
// caller gave up while it waited is never sent, and the timeout of the one
// sent counts only its own work.
export class DocumentWorkerClient<Req, Reply> {
  private worker?: Worker
  private ready = false
  private broken = false
  private nextId = 0
  private queue: Job<Req, Reply>[] = []
  private running?: Job<Req, Reply>
  private timer?: ReturnType<typeof setTimeout>

  constructor(private readonly make: () => Worker) {}

  // The worker is gone: every request fails, open a new client
  get dead(): boolean {
    return this.broken
  }

  // The worker's reply to req. transfer moves those buffers to the worker
  // (they are detached here once sent).
  request(
    req: Req,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
  ): Promise<Reply> {
    if (signal?.aborted)
      return Promise.reject(new DocumentWorkerError('aborted'))
    if (!this.start()) return Promise.reject(new DocumentWorkerError('dead'))
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = this.queue.indexOf(job)
        if (i >= 0) this.queue.splice(i, 1)
        reject(new DocumentWorkerError('aborted'))
      }
      const job: Job<Req, Reply> = {
        msg: { id: ++this.nextId, req },
        transfer,
        resolve: (reply) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(reply)
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(job)
      this.runNext()
    })
  }

  terminate() {
    this.fail('dead')
  }

  private start(): boolean {
    if (this.broken) return false
    if (!this.worker) {
      let w: Worker
      try {
        w = this.make()
      } catch {
        this.broken = true
        return false
      }
      w.onmessage = (e: MessageEvent<FromWorker<Reply>>) =>
        this.onMessage(e.data)
      w.onerror = () => this.fail('dead')
      w.onmessageerror = () => this.fail('dead')
      this.worker = w
      this.timer = setTimeout(() => this.fail('timeout'), DOC_LOAD_TIMEOUT)
    }
    return true
  }

  private runNext() {
    if (!this.ready || this.running) return
    const job = this.queue.shift()
    if (!job) return
    this.running = job
    this.timer = setTimeout(() => this.fail('timeout'), DOC_TIMEOUT)
    this.worker?.postMessage(job.msg, job.transfer)
  }

  private onMessage(msg: FromWorker<Reply>) {
    if ('ready' in msg) {
      if (this.ready) return
      this.ready = true
      clearTimeout(this.timer)
      this.runNext()
      return
    }
    const job = this.running
    if (job?.msg.id !== msg.id) return
    clearTimeout(this.timer)
    this.running = undefined
    if ('failed' in msg) job.reject(new DocumentWorkerError('failed'))
    else job.resolve(msg.reply)
    this.runNext()
  }

  // Ends the worker for good: what is pending fails with why
  private fail(code: 'timeout' | 'dead') {
    this.broken = true
    clearTimeout(this.timer)
    this.worker?.terminate()
    this.worker = undefined
    const jobs = this.queue.splice(0)
    if (this.running) jobs.unshift(this.running)
    this.running = undefined
    for (const job of jobs) job.reject(new DocumentWorkerError(code))
  }
}

// The worker's side: says it is ready, then answers each request with
// handle's reply (and the buffers it moves back); a request that throws is
// answered failed, its error never sent (it may quote the file).
export function serveDocumentRequests<Req, Reply>(
  scope: {
    postMessage: (
      msg: FromWorker<Reply>,
      options?: { transfer: Transferable[] },
    ) => void
    onmessage: ((e: MessageEvent<ToWorker<Req>>) => void) | null
  },
  handle: (
    req: Req,
  ) =>
    | { reply: Reply; transfer?: Transferable[] }
    | Promise<{ reply: Reply; transfer?: Transferable[] }>,
) {
  // One at a time, in order: the client sends the next only after an answer
  scope.onmessage = async (e) => {
    // Only requests: never what this side posted (a page that loads the
    // module, as tests do, gets its own messages back)
    if (!e.data || !('req' in e.data)) return
    const { id, req } = e.data
    try {
      const { reply, transfer } = await handle(req)
      scope.postMessage({ id, reply }, { transfer: transfer ?? [] })
    } catch {
      scope.postMessage({ id, failed: true })
    }
  }
  scope.postMessage({ ready: true })
}
