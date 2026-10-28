// Mermaid diagrams of the Markdown preview, drawn by Pele in
// mermaid-worker.ts and shown as images. Pele runs in a worker started by a
// hidden iframe sandbox="allow-scripts" (mermaid-sandbox.ts): its origin is
// opaque, so a flaw in Pele that a file exploits runs where it can send no
// cookie of the server's and reach nothing of the app. The sandbox page, and
// Pele inside it, stay out of the main bundle and the precache: it is loaded
// the first time a diagram scrolls into view. What Pele draws never reaches
// the page: the SVG string becomes a data: URL shown in an <img>, where no
// script runs, no link navigates and nothing loads. Every message from the
// sandbox is checked as coming from that code.
import type { DrawFailure, DrawReply, DrawRequest } from './mermaid-worker'

export type MermaidTheme = 'light' | 'dark'

export type MermaidFailure = DrawFailure | 'timeout'

export interface MermaidImage {
  url: string
  width: number
  height: number
  // The color behind the diagram (the SVG paints none): an exported PNG is
  // filled with it, so it looks as it does on screen
  background: string
}

export type MermaidResult =
  | ({ ok: true } & MermaidImage)
  | { ok: false; reason: MermaidFailure }

// UTF-8 bytes of a diagram's source; past this the sandbox is never asked
export const MERMAID_MAX_BYTES = 50_000
// From the moment the worker starts drawing a diagram: past this the
// sandbox is removed, which ends the worker, and the next diagram starts a
// new one.
export const MERMAID_TIMEOUT = 10_000
// Loading the sandbox page, Pele with it, on a slow network
export const MERMAID_LOAD_TIMEOUT = 30_000
// The sandbox page loaded but did not say it is ready (an error page, a
// signed-out session): its ready message and the load event can come in
// either order, so it gets this long before the diagram falls back to code.
export const MERMAID_READY_WAIT = 2_000
declare const __MERMAID_SANDBOX_URL__: string
// Named by its content (vite.config.ts), served with a policy of its own
// (server/security_headers.go)
export const MERMAID_SANDBOX_URL = __MERMAID_SANDBOX_URL__

const FAILURES: ReadonlySet<string> = new Set<DrawFailure>([
  'too_large',
  'unsupported',
  'syntax',
  'render_failed',
  'load_failed',
])
const CACHE_SIZE = 50

// Pele's colors are CSS variables with its light palette as fallbacks; an
// <img> sees no CSS of the page, so the dark one goes into the SVG itself.
// The default style's dark tokens (index.css), the border a step lighter
// than --tm-border so node outlines stay visible.
const DARK_BG = '#1a1a1d'
// Pele's own fallback for --pele-bg
const LIGHT_BG = '#fff'
const DARK_PALETTE = [
  `--pele-bg:${DARK_BG}`,
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

// One diagram in the sandbox at a time; the rest wait here, so a block gone
// meanwhile (its signal aborted) is dropped before the sandbox sees it.
interface Job {
  source: string
  theme: MermaidTheme
  done: (result: MermaidResult) => void
  timer?: ReturnType<typeof setTimeout>
}
interface Sandbox {
  frame: HTMLIFrameElement
  ready: boolean
  onMessage: (e: MessageEvent) => void
  readyTimer?: ReturnType<typeof setTimeout>
}
let sandbox: Sandbox | undefined
let nextId = 0
let running:
  | { id: number; job: Job; req: DrawRequest; sent: boolean }
  | undefined
const queue: Job[] = []

function finish(job: Job, result: MermaidResult) {
  clearTimeout(job.timer)
  job.done(result)
}

function removeSandbox() {
  if (!sandbox) return
  window.removeEventListener('message', sandbox.onMessage)
  clearTimeout(sandbox.readyTimer)
  sandbox.frame.remove()
  sandbox = undefined
}

// Ends the sandbox and its worker (stuck in a diagram, or broken): the
// diagram it held fails with reason, and the next one starts a new sandbox.
function endSandbox(reason: MermaidFailure) {
  removeSandbox()
  const current = running
  running = undefined
  if (current) finish(current.job, fail(reason))
  runNext()
}

// Sends the running diagram once the sandbox is ready
function send() {
  if (!sandbox?.ready || !running || running.sent) return
  running.sent = true
  sandbox.frame.contentWindow?.postMessage(running.req, '*')
}

function isObject(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null
}

// A message of the sandbox: its state, or the worker's answer about the
// running diagram
function onSandboxMessage(data: unknown) {
  if (!isObject(data)) return
  if (data.ready === true) {
    const s = sandbox as Sandbox
    s.ready = true
    clearTimeout(s.readyTimer)
    send()
    return
  }
  if (data.broken === true) {
    endSandbox('load_failed')
    return
  }
  if (!running || data.id !== running.id) return
  const { job } = running
  if (data.started === true) {
    clearTimeout(job.timer)
    job.timer = setTimeout(() => endSandbox('timeout'), MERMAID_TIMEOUT)
    return
  }
  const reply = replyOf(data)
  if (!reply) return
  running = undefined
  finish(job, settle(reply, job))
  runNext()
}

// The sandbox's answer as a reply, or undefined when it is none
function replyOf(data: Record<string, unknown>): DrawReply | undefined {
  const id = data.id as number
  if (typeof data.svg === 'string') return { id, svg: data.svg }
  if (typeof data.error !== 'string') return undefined
  const error = FAILURES.has(data.error)
    ? (data.error as DrawFailure)
    : 'render_failed'
  return { id, error }
}

function getSandbox(): Sandbox {
  if (!sandbox) {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.hidden = true
    frame.title = 'Mermaid renderer'
    frame.src = MERMAID_SANDBOX_URL
    const s: Sandbox = {
      frame,
      ready: false,
      onMessage: (e: MessageEvent) => {
        if (sandbox === s && e.source === frame.contentWindow)
          onSandboxMessage(e.data)
      },
    }
    frame.addEventListener('load', () => {
      if (sandbox === s && !s.ready)
        s.readyTimer = setTimeout(
          () => endSandbox('load_failed'),
          MERMAID_READY_WAIT,
        )
    })
    window.addEventListener('message', s.onMessage)
    document.body.append(frame)
    sandbox = s
  }
  return sandbox
}

// The sandbox's answer as a result, cached when it is an image
function settle(reply: DrawReply, job: Job): MermaidResult {
  if ('error' in reply) {
    // A worker that failed to load stays failed: the next diagram gets a
    // new sandbox
    if (reply.error === 'load_failed') removeSandbox()
    return fail(reply.error)
  }
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
    const req: DrawRequest = {
      id,
      source: job.source,
      fontFamily: getComputedStyle(document.body).fontFamily,
    }
    running = { id, job, req, sent: false }
    job.timer = setTimeout(
      () => endSandbox('load_failed'),
      MERMAID_LOAD_TIMEOUT,
    )
    getSandbox()
    send()
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
    background: theme === 'dark' ? DARK_BG : LIGHT_BG,
  }
}

// For tests: remove the sandbox, forget the cache and anything pending.
export function resetMermaid() {
  removeSandbox()
  // Only the diagram in the sandbox has a timer
  clearTimeout(running?.job.timer)
  running = undefined
  queue.length = 0
  cache.clear()
  nextId = 0
}
