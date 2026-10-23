/// <reference lib="webworker" />
// Draws a Mermaid diagram with Pele off the main thread. Pele has no time
// limit of its own: mermaid-render.ts gives up after a timeout and ends this
// worker. Each diagram type is a chunk of its own, fetched the first time a
// diagram of that type is drawn.
import {
  detectType,
  load,
  PeleError,
  type RenderOptions,
  renderAsync,
} from 'pele/lazy'

// Why a diagram is shown as code instead (MermaidFailure in mermaid-render.ts)
export type DrawFailure =
  | 'too_large'
  | 'unsupported'
  | 'syntax'
  | 'render_failed'
  | 'load_failed'

export interface DrawRequest {
  id: number
  source: string
  // The font list of the page: the image shows system fonts only, which is
  // what the worker measures with too
  fontFamily: string
}

export type DrawReply =
  | { id: number; svg: string }
  | { id: number; error: DrawFailure }

// Sent once the diagram's type is loaded, as drawing starts: the timeout
// counts from here, so a slow download is not taken for a stuck diagram.
export interface DrawStarted {
  id: number
  started: true
}

// The same limits as before Pele: past them a diagram is shown as code
export const MAX_CHARS = 50_000
export const MAX_EDGES = 500

// Fixed here, never taken from the file: no link, no image, no icon or math
// markup (Pele inserts those unfiltered), no config a directive could build on.
export function drawOptions(fontFamily: string): RenderOptions {
  return {
    fontFamily,
    links: false,
    images: false,
    limit: MAX_CHARS,
    maxEdges: MAX_EDGES,
  }
}

// A module that could not be fetched (offline, or a chunk gone after an
// update), as Chromium, Firefox and Safari word it
export function isLoadError(e: unknown): boolean {
  return (
    e instanceof Error &&
    /dynamically imported module|Importing a module script failed/i.test(
      e.message,
    )
  )
}

// Only a code leaves the worker: Pele's messages quote the diagram
export function failureOf(e: unknown): DrawFailure {
  if (e instanceof PeleError) {
    switch (e.code) {
      case 'syntax':
      case 'semantic':
        return 'syntax'
      case 'limit':
        return 'too_large'
      case 'unsupported-diagram':
        return 'unsupported'
    }
  }
  return isLoadError(e) ? 'load_failed' : 'render_failed'
}

export async function handleRequest(
  req: DrawRequest,
  onStart: () => void = () => {},
): Promise<DrawReply> {
  try {
    // The chunk of the diagram's type first (none for an unknown type:
    // renderAsync reports it), so the timeout covers drawing alone
    await load(detectType(req.source))
    onStart()
    const { svg } = await renderAsync(req.source, drawOptions(req.fontFamily))
    return { id: req.id, svg }
  } catch (e) {
    return { id: req.id, error: failureOf(e) }
  }
}

self.onmessage = async (e: MessageEvent<DrawRequest>) => {
  const started: DrawStarted = { id: e.data.id, started: true }
  self.postMessage(await handleRequest(e.data, () => self.postMessage(started)))
}
