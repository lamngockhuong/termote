// Mermaid diagrams of the Markdown preview, drawn by Pele in
// mermaid-worker.ts and shown as images. The worker and Pele stay out of the
// main bundle and the precache: they are fetched the first time a diagram
// scrolls into view. What Pele draws never reaches the page: the SVG string
// becomes a data: URL shown in an <img>, where no script runs, no link
// navigates and nothing loads.
import type {
  DrawFailure,
  DrawReply,
  DrawRequest,
  DrawStarted,
} from './mermaid-worker'

export type MermaidTheme = 'light' | 'dark'

export type MermaidFailure = DrawFailure | 'timeout'

export interface MermaidImage {
  url: string
  width: number
  height: number
}

export type MermaidResult =
  | ({ ok: true } & MermaidImage)
  | { ok: false; reason: MermaidFailure }

// UTF-8 bytes of a diagram's source; past this the worker is never asked
export const MERMAID_MAX_BYTES = 50_000
// From the moment the worker starts drawing a diagram (its type loaded):
// past this the worker is ended, and the next diagram starts a new one.
export const MERMAID_TIMEOUT = 10_000
// Loading the worker and the diagram's type on a slow network
export const MERMAID_LOAD_TIMEOUT = 30_000
const CACHE_SIZE = 50

// Pele's colors are CSS variables with its light palette as fallbacks; an
// <img> sees no CSS of the page, so the dark one goes into the SVG itself.
// The default style's dark tokens (index.css), the border a step lighter
// than --tm-border so node outlines stay visible.
const DARK_PALETTE = [
  '--pele-bg:#1a1a1d',
  '--pele-fg:#d4d4d8',
  '--pele-muted:#a1a1aa',
  '--pele-line:#d4d4d8',
  '--pele-surface:#29292e',
  '--pele-surface-alt:#2f2f34',
  '--pele-border:#71717a',
  '--pele-accent:#818cf8',
].join(';')

// Successful renders by theme and source, least recently used first: a
// preview mounted again (a tab switched back to) shows them at once.
const cache = new Map<string, MermaidImage>()

function cacheKey(source: string, theme: MermaidTheme): string {
  return `${theme}\0${source}`
}

export function peekMermaid(
  source: string,
  theme: MermaidTheme,
): ({ ok: true } & MermaidImage) | undefined {
  const key = cacheKey(source, theme)
  const hit = cache.get(key)
  if (!hit) return undefined
  cache.delete(key)
  cache.set(key, hit)
  return { ok: true, ...hit }
}

function remember(key: string, image: MermaidImage) {
  cache.delete(key)
  cache.set(key, image)
  if (cache.size > CACHE_SIZE) {
    cache.delete(cache.keys().next().value as string)
  }
}

function fail(reason: MermaidFailure): MermaidResult {
  return { ok: false, reason }
}

// One diagram in the worker at a time; the rest wait here, so a block gone
// meanwhile (its signal aborted) is dropped before the worker sees it.
interface Job {
  source: string
  theme: MermaidTheme
  done: (result: MermaidResult) => void
  timer?: ReturnType<typeof setTimeout>
}
let worker: Worker | undefined
let nextId = 0
let running: { id: number; job: Job } | undefined
const queue: Job[] = []

function finish(job: Job, result: MermaidResult) {
  clearTimeout(job.timer)
  job.done(result)
}

// Ends the worker (stuck in a diagram, or broken): the diagram it held
// fails with reason, and the next one starts a new worker.
function endWorker(reason: MermaidFailure) {
  worker?.terminate()
  worker = undefined
  const current = running
  running = undefined
  if (current) finish(current.job, fail(reason))
  runNext()
}

function getWorker(): Worker {
  if (!worker) {
    const w = new Worker(new URL('./mermaid-worker.ts', import.meta.url), {
      type: 'module',
    })
    w.onmessage = (e: MessageEvent<DrawReply | DrawStarted>) => {
      if (!running || e.data.id !== running.id) return
      const { job } = running
      if ('started' in e.data) {
        clearTimeout(job.timer)
        job.timer = setTimeout(() => endWorker('timeout'), MERMAID_TIMEOUT)
        return
      }
      // A chunk that failed to load may stay failed in this worker: the
      // next diagram gets a new one
      if ('error' in e.data && e.data.error === 'load_failed') {
        endWorker('load_failed')
        return
      }
      running = undefined
      finish(job, settle(e.data, job))
      runNext()
    }
    // The worker or a chunk it imports could not load (offline, or gone
    // after an update); a late error of a worker already ended is ignored
    w.onerror = () => {
      if (worker === w) endWorker('load_failed')
    }
    worker = w
  }
  return worker
}

// The worker's answer as a result, cached when it is an image
function settle(reply: DrawReply, job: Job): MermaidResult {
  if ('error' in reply) return fail(reply.error)
  const image = svgToDataUrl(reply.svg, job.theme)
  if (!image) return fail('render_failed')
  remember(cacheKey(job.source, job.theme), image)
  return { ok: true, ...image }
}

function runNext() {
  while (!running && queue.length) {
    const job = queue.shift() as Job
    // Drawn meanwhile by a diagram with the same source
    const hit = peekMermaid(job.source, job.theme)
    if (hit) {
      job.done(hit)
      continue
    }
    const id = ++nextId
    running = { id, job }
    job.timer = setTimeout(() => endWorker('load_failed'), MERMAID_LOAD_TIMEOUT)
    const req: DrawRequest = {
      id,
      source: job.source,
      fontFamily: getComputedStyle(document.body).fontFamily,
    }
    getWorker().postMessage(req)
  }
}

// The diagram of source as an image, or why it is shown as code. Aborting
// signal before its turn comes drops it (rejects with the signal's reason);
// once started it runs to the end and its result is cached.
export function renderMermaid(
  source: string,
  theme: MermaidTheme,
  signal: AbortSignal,
): Promise<MermaidResult> {
  const hit = peekMermaid(source, theme)
  if (hit) return Promise.resolve(hit)
  if (new TextEncoder().encode(source).length > MERMAID_MAX_BYTES) {
    return Promise.resolve(fail('too_large'))
  }
  if (typeof Worker === 'undefined') return Promise.resolve(fail('load_failed'))
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const i = queue.indexOf(job)
      if (i < 0) return
      queue.splice(i, 1)
      reject(signal.reason)
    }
    const job: Job = {
      source,
      theme,
      done: (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
    }
    signal.addEventListener('abort', onAbort, { once: true })
    queue.push(job)
    runNext()
  })
}

const SVG_OPEN = /<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/i
const VIEW_BOX =
  /\sviewBox\s*=\s*(["'])\s*[-+\d.eE]+[\s,]+[-+\d.eE]+[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)\s*\1/i
const SIZE_ATTR = /\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi
const STYLE_ATTR = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i
// What makes the SVG follow its container: an <img> has a fixed size
const FLUID = /(?:^|;)\s*(?:max-width\s*:\s*100%|height\s*:\s*auto)\s*(?=;|$)/gi
const VOID_TAG =
  /<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\b((?:[^>"'/]|"[^"]*"|'[^']*')*)\/?>/gi

// Pele's SVG string as a data: URL sized by its viewBox in theme's colors,
// or null without a viewBox. Fixed up as text rather than parsed: an <img>
// parses SVG as XML, where &nbsp; is no entity and a void element must close
// itself.
export function svgToDataUrl(
  svg: string,
  theme: MermaidTheme = 'light',
): MermaidImage | null {
  const open = SVG_OPEN.exec(svg)
  if (!open) return null
  const box = VIEW_BOX.exec(open[0])
  if (!box) return null
  const width = Math.ceil(Number(box[2]))
  const height = Math.ceil(Number(box[3]))
  if (!(width > 0 && height > 0)) return null
  let tag = open[0].replace(SIZE_ATTR, '').replace(/\s*>$/, '')
  // The palette before Pele's own variables, which read it
  const palette = theme === 'dark' ? DARK_PALETTE : ''
  const style = STYLE_ATTR.exec(tag)
  const rest = (style?.[1] ?? style?.[2] ?? '')
    .replace(FLUID, '')
    .replace(/^;+/, '')
  const css = [palette, rest].filter(Boolean).join(';')
  tag = tag.replace(STYLE_ATTR, '')
  if (css) tag += ` style="${css.replaceAll('"', '&quot;')}"`
  if (!/\sxmlns\s*=/.test(tag)) tag += ' xmlns="http://www.w3.org/2000/svg"'
  if (!/\sxmlns:xlink\s*=/.test(tag) && svg.includes('xlink:')) {
    tag += ' xmlns:xlink="http://www.w3.org/1999/xlink"'
  }
  tag += ` width="${width}" height="${height}">`
  const xml = (
    svg.slice(0, open.index) +
    tag +
    svg.slice(open.index + open[0].length)
  )
    .replaceAll('&nbsp;', '&#160;')
    .replace(VOID_TAG, '<$1$2/>')
  return {
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`,
    width,
    height,
  }
}

// For tests: end the worker, forget the cache and anything pending.
export function resetMermaid() {
  worker?.terminate()
  worker = undefined
  // Only the diagram in the worker has a timer
  clearTimeout(running?.job.timer)
  running = undefined
  queue.length = 0
  cache.clear()
  nextId = 0
}
