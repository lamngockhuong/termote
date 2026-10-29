// The script of mermaid-sandbox.html, the page mermaid-render.ts frames with
// sandbox="allow-scripts": an opaque origin, so whatever runs there sends no
// cookie of the server's and reads nothing of the app. It starts the Pele
// worker (mermaid-worker.ts) from a blob: URL of its own origin, then passes
// the page's requests to it and its replies back.
import type { DrawRequest } from './mermaid-worker'

// Told to the page once the worker started, or when it failed to
export type SandboxStatus = { ready: true } | { broken: true }

export function relay(win: Window, startWorker: () => Worker) {
  const page = win.parent
  if (page === win) return
  // The page's origin is not ours to know (ours is opaque): only the window
  // that framed this one is ever written to or listened to.
  const tell = (data: unknown) => page.postMessage(data, '*')
  let worker: Worker
  try {
    worker = startWorker()
  } catch {
    tell({ broken: true } satisfies SandboxStatus)
    return
  }
  worker.onmessage = (e) => tell(e.data)
  worker.onerror = () => tell({ broken: true } satisfies SandboxStatus)
  win.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== page) return
    const req = e.data as Partial<DrawRequest> | null
    if (
      typeof req?.id !== 'number' ||
      typeof req.source !== 'string' ||
      typeof req.fontFamily !== 'string'
    )
      return
    worker.postMessage({
      id: req.id,
      source: req.source,
      fontFamily: req.fontFamily,
    } satisfies DrawRequest)
  })
  tell({ ready: true } satisfies SandboxStatus)
}

// A classic worker running source, from a blob: URL of this document's origin
export function workerFromSource(source: string): Worker {
  const url = URL.createObjectURL(
    new Blob([source], { type: 'text/javascript' }),
  )
  return new Worker(url)
}
