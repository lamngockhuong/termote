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

let worker: Worker | undefined
let nextId = 0
interface Pending {
  done: (lines: Token[][] | null) => void
  started: () => void
}
const pending = new Map<number, Pending>()

// Ends the worker (stuck in a grammar, or broken): every pending file is
// shown plain, and the next one starts a new worker.
function resetWorker() {
  worker?.terminate()
  worker = undefined
  for (const p of pending.values()) p.done(null)
  pending.clear()
}

function getWorker(): Worker | undefined {
  if (typeof Worker === 'undefined') return undefined
  if (!worker) {
    worker = new Worker(new URL('./highlight-worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (e: MessageEvent<HighlightReply | HighlightStarted>) => {
      const p = pending.get(e.data.id)
      if ('started' in e.data) {
        p?.started()
        return
      }
      p?.done(e.data.lines)
      pending.delete(e.data.id)
    }
    worker.onerror = resetWorker
  }
  return worker
}

// The tokens of text, one array per line, or null to show it plain (unknown
// language, too big, failed or too slow).
export function highlight(
  text: string,
  path: string,
  theme: 'light' | 'dark',
): Promise<Token[][] | null> {
  const lang: LanguageId | undefined = languageFor(path)
  const w = lang && canHighlight(text) ? getWorker() : undefined
  if (!lang || !w) return Promise.resolve(null)
  const id = ++nextId
  return new Promise((resolve) => {
    let timer = setTimeout(resetWorker, HIGHLIGHT_LOAD_TIMEOUT)
    pending.set(id, {
      done: (lines) => {
        clearTimeout(timer)
        resolve(lines)
      },
      started: () => {
        clearTimeout(timer)
        timer = setTimeout(resetWorker, HIGHLIGHT_TIMEOUT)
      },
    })
    const req: HighlightRequest = { id, text, lang, theme }
    w.postMessage(req)
  })
}

// For tests: drop the worker and anything pending.
export function resetHighlighter() {
  resetWorker()
  nextId = 0
}
