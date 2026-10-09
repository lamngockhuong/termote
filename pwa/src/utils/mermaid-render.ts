// Mermaid diagrams of the Markdown preview, drawn as images. Mermaid stays
// out of the main bundle and the precache: it is fetched the first time a
// diagram scrolls into view. What it draws never reaches the page: the SVG
// string becomes a data: URL shown in an <img>, where no script runs, no link
// navigates and nothing loads.
import type { Mermaid, MermaidConfig } from 'mermaid'

export type MermaidTheme = 'light' | 'dark'

export type MermaidFailure =
  | 'too_large'
  | 'unsupported'
  | 'syntax'
  | 'render_failed'
  | 'timeout'
  | 'load_failed'

export interface MermaidImage {
  url: string
  width: number
  height: number
}

export type MermaidResult =
  | ({ ok: true } & MermaidImage)
  | { ok: false; reason: MermaidFailure }

// UTF-8 bytes of a diagram's source; past this Mermaid is never called (one
// large diagram can hold the main thread for seconds).
export const MERMAID_MAX_BYTES = 50_000
// From the moment a diagram's own render starts, Mermaid loaded (time spent
// waiting behind another diagram or for the download does not count). Mermaid cannot be stopped: past this the
// caller stops waiting, and the next diagram still waits for it to finish.
export const MERMAID_TIMEOUT = 10_000
export const MERMAID_MAX_EDGES = 500
const CACHE_SIZE = 50
// Wide enough for a Gantt chart, which takes its width from the parent
const STAGE_WIDTH = 1200

// Mermaid fetches the URL of an img: or icon: key of a shape (A@{ img: ... })
// itself, with this origin's cookies when it is this origin. The shape's
// body is YAML, where a quoted "}" or an escape (\x67) can hide the key from
// any pattern: a source with a shape is refused when img or icon, or any
// backslash, follows it anywhere. hasFetchingNode checks what was parsed.
const FETCHING_SHAPE = /@\{[\s\S]*(?:\b(?:img|icon)\b|\\)/

// Keys a %%{init}%% directive or a frontmatter config: of the file cannot
// change: Mermaid's own defaults, then what keeps labels as SVG text, the
// layout off elk and the theme (CSS, colors, font) the one set here.
const SECURE = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'htmlLabels',
  'flowchart',
  'theme',
  'themeVariables',
  'themeCSS',
  'darkMode',
  'fontFamily',
  'altFontFamily',
  'layout',
  'look',
  'dompurifyConfig',
  'deterministicIds',
]

export function mermaidConfig(theme: MermaidTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    layout: 'dagre',
    suppressErrorRendering: true,
    theme: theme === 'dark' ? 'dark' : 'default',
    maxTextSize: MERMAID_MAX_BYTES,
    maxEdges: MERMAID_MAX_EDGES,
    // The font list itself: a CSS variable means nothing inside an <img>
    fontFamily: getComputedStyle(document.body).fontFamily,
    secure: SECURE,
  }
}

let lib: Promise<Mermaid> | null = null

// Loaded once; a failed load is forgotten, so the next diagram tries again
function load(): Promise<Mermaid> {
  if (!lib) {
    lib = import('mermaid').then(
      (m) => m.default,
      (e) => {
        lib = null
        throw e
      },
    )
  }
  return lib
}

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

// A module that could not be fetched (offline, or a chunk gone after an
// update), as Chromium, Firefox and Safari word it. Mermaid imports the code
// of each diagram type itself, so this can come from parse or render too.
export function isLoadError(e: unknown): boolean {
  return (
    e instanceof Error &&
    /dynamically imported module|Importing a module script failed/i.test(
      e.message,
    )
  )
}

// One render at a time: Mermaid's configuration is global, so the next
// diagram initializes only once the one before has really finished.
let tail: Promise<void> = Promise.resolve()
let seq = 0

// What Mermaid adds to <body> on its own: the stage below, its wrappers
// (d/i + id), cytoscape's #cy, the tooltip and the bare <svg> it measures
// text in. Only these are removed, never a node the app added meanwhile.
function isMermaidNode(el: Element): boolean {
  return (
    /^[di]?termote-mmd/.test(el.id) ||
    el.id === 'cy' ||
    el.classList.contains('mermaidTooltip') ||
    el.tagName.toLowerCase() === 'svg'
  )
}

// Off screen, never painted nor focusable, but laid out: Mermaid measures
// text with getBBox, which needs a rendered box.
function makeStage(): HTMLDivElement {
  const stage = document.createElement('div')
  stage.id = `termote-mmd-stage-${seq}`
  stage.setAttribute('aria-hidden', 'true')
  stage.inert = true
  stage.style.cssText = [
    `width:${STAGE_WIDTH}px`,
    'position:fixed',
    'left:0',
    'top:0',
    'transform:translateX(-20000px)',
    'opacity:0',
    'pointer-events:none',
    'contain:strict',
    'overflow:hidden',
  ].join(';')
  return stage
}

function fail(reason: MermaidFailure): MermaidResult {
  return { ok: false, reason }
}

interface ShapeNode {
  img?: string
  icon?: string
}

// A parsed flowchart node with an image or an icon, whatever the source
// looked like
function hasFetchingNode(db: unknown): boolean {
  const nodes = (db as { getVertices?: () => unknown }).getVertices?.()
  const list = (
    nodes instanceof Map ? [...nodes.values()] : Object.values(nodes ?? {})
  ) as ShapeNode[]
  return list.some((n) => n.img || n.icon)
}

async function draw(
  mermaid: Mermaid,
  source: string,
  theme: MermaidTheme,
): Promise<MermaidResult> {
  mermaid.initialize(mermaidConfig(theme))
  try {
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source)
    if (hasFetchingNode(diagram.db)) return fail('unsupported')
  } catch (e) {
    return fail(isLoadError(e) ? 'load_failed' : 'syntax')
  }
  seq++
  const before = new Set(Array.from(document.body.children))
  const stage = makeStage()
  document.body.append(stage)
  let svg: string
  try {
    ;({ svg } = await mermaid.render(`termote-mmd-${seq}`, source, stage))
  } catch (e) {
    return fail(isLoadError(e) ? 'load_failed' : 'render_failed')
  } finally {
    stage.remove()
    for (const el of Array.from(document.body.children)) {
      if (!before.has(el) && isMermaidNode(el)) el.remove()
    }
  }
  const image = svgToDataUrl(svg)
  if (!image) return fail('render_failed')
  remember(cacheKey(source, theme), image)
  return { ok: true, ...image }
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
  if (FETCHING_SHAPE.test(source)) return Promise.resolve(fail('unsupported'))
  return new Promise((resolve, reject) => {
    tail = tail.then(async () => {
      if (signal.aborted) return reject(signal.reason)
      // Drawn meanwhile by a diagram with the same source
      const again = peekMermaid(source, theme)
      if (again) return resolve(again)
      let mermaid: Mermaid
      try {
        mermaid = await load()
      } catch {
        return resolve(fail('load_failed'))
      }
      // Counted once Mermaid is here: a slow network is not a slow diagram
      const timer = setTimeout(() => resolve(fail('timeout')), MERMAID_TIMEOUT)
      try {
        resolve(await draw(mermaid, source, theme))
      } catch {
        // Mermaid failing outside parse and render (its initialize)
        resolve(fail('render_failed'))
      } finally {
        clearTimeout(timer)
      }
    })
  })
}

const SVG_OPEN = /<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/i
const VIEW_BOX =
  /\sviewBox\s*=\s*(["'])\s*[-+\d.eE]+[\s,]+[-+\d.eE]+[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)\s*\1/i
const SIZE_ATTR = /\s(?:width|height|style)\s*=\s*(?:"[^"]*"|'[^']*')/gi
const VOID_TAG =
  /<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\b((?:[^>"'/]|"[^"]*"|'[^']*')*)\/?>/gi

// Mermaid's SVG string as a data: URL sized by its viewBox, or null without
// one. The string is serialized as HTML (by DOMPurify), so it is fixed up
// as text rather than parsed: an <img> parses SVG as XML, where &nbsp; is no
// entity and a void element must close itself.
export function svgToDataUrl(svg: string): MermaidImage | null {
  const open = SVG_OPEN.exec(svg)
  if (!open) return null
  const box = VIEW_BOX.exec(open[0])
  if (!box) return null
  const width = Math.ceil(Number(box[2]))
  const height = Math.ceil(Number(box[3]))
  if (!(width > 0 && height > 0)) return null
  let tag = open[0].replace(SIZE_ATTR, '').replace(/\s*>$/, '')
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

// For tests: forget the cache, the loaded module and the queue.
export function resetMermaid() {
  cache.clear()
  lib = null
  tail = Promise.resolve()
  seq = 0
}
