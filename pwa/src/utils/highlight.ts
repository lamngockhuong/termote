// Syntax highlighting for Files, run by highlight-worker.ts. Shiki and its
// grammars stay out of the main bundle: the worker and each grammar are
// fetched the first time a file needs them.
import { type LanguageId, languageFor } from './highlight-langs'
import type {
  HighlightReply,
  HighlightRequest,
  HighlightStarted,
  Token,
} from './highlight-worker'

export type { Token }

// Beyond these a file is shown plain: tokenizing it would take too long, and
// one huge line is where a grammar's backtracking shows.
export const HIGHLIGHT_MAX_BYTES = 256 * 1024
export const HIGHLIGHT_MAX_LINES = 5000
export const HIGHLIGHT_MAX_LINE = 2000
// A file the worker has not finished this long after it started tokenizing
// is shown plain (a grammar stuck on the text).
export const HIGHLIGHT_TIMEOUT = 3000
// Loading the worker, its themes and the grammar on a slow network: past
// this the file is shown plain too.
export const HIGHLIGHT_LOAD_TIMEOUT = 30000

export function canHighlight(text: string): boolean {
  // UTF-16 length is a lower bound of the UTF-8 size; close enough here
  if (text.length > HIGHLIGHT_MAX_BYTES) return false
  const lines = text.split('\n')
  return (
    lines.length <= HIGHLIGHT_MAX_LINES &&
    lines.every((l) => l.length <= HIGHLIGHT_MAX_LINE)
  )
}

// Files in the worker at once. Up to this many grammars download in
// parallel; the rest wait here, so a code block gone meanwhile (its signal
// aborted) is dropped before the worker ever sees it. A cancel posted to the
// worker could not do that: while it tokenizes, its messages wait their turn.
export const HIGHLIGHT_CONCURRENCY = 4

let worker: Worker | undefined
let nextId = 0
interface Job {
  req: HighlightRequest
  done: (lines: Token[][] | null) => void
  timer?: ReturnType<typeof setTimeout>
}
const queue: Job[] = []
// In the worker, by request id
const running = new Map<number, Job>()

function finish(job: Job, lines: Token[][] | null) {
  clearTimeout(job.timer)
  job.done(lines)
}

// Ends the worker (stuck in a grammar, or broken): every pending file is
// shown plain, and the next one starts a new worker.
function resetWorker() {
  worker?.terminate()
  worker = undefined
  const jobs = [...running.values(), ...queue]
  running.clear()
  queue.length = 0
  for (const job of jobs) finish(job, null)
}

function getWorker(): Worker | undefined {
  if (typeof Worker === 'undefined') return undefined
  if (!worker) {
    worker = new Worker(new URL('./highlight-worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (e: MessageEvent<HighlightReply | HighlightStarted>) => {
      const job = running.get(e.data.id)
      if (!job) return
      if ('started' in e.data) {
        clearTimeout(job.timer)
        job.timer = setTimeout(resetWorker, HIGHLIGHT_TIMEOUT)
        return
      }
      running.delete(e.data.id)
      finish(job, e.data.lines)
      runNext()
    }
    worker.onerror = resetWorker
  }
  return worker
}

// Hands waiting files to the worker while it has room
function runNext() {
  while (running.size < HIGHLIGHT_CONCURRENCY && queue.length) {
    const job = queue.shift() as Job
    running.set(job.req.id, job)
    job.timer = setTimeout(resetWorker, HIGHLIGHT_LOAD_TIMEOUT)
    // A file is queued only where workers exist
    const w = getWorker() as Worker
    w.postMessage(job.req)
  }
}

// The tokens of text, one array per line, or null to show it plain (unknown
// language, too big, failed or too slow).
export function highlight(
  text: string,
  path: string,
  theme: 'light' | 'dark',
): Promise<Token[][] | null> {
  return highlightLang(text, languageFor(path), theme)
}

// The same for text in a known language (a fenced code block). Once signal
// aborts the answer is null, and a file still waiting is never tokenized.
export function highlightLang(
  text: string,
  lang: LanguageId | undefined,
  theme: 'light' | 'dark',
  signal?: AbortSignal,
): Promise<Token[][] | null> {
  const w = lang && canHighlight(text) ? getWorker() : undefined
  if (!lang || !w || signal?.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const onAbort = () => {
      const i = queue.indexOf(job)
      if (i >= 0) queue.splice(i, 1)
      // One already in the worker runs to its end; its answer is ignored
      resolve(null)
    }
    const job: Job = {
      req: { id: ++nextId, text, lang, theme },
      done: (lines) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(lines)
      },
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    queue.push(job)
    runNext()
  })
}

// For tests: drop the worker and anything pending.
export function resetHighlighter() {
  resetWorker()
  nextId = 0
}
