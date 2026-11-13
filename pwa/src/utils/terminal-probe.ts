// A way for Playwright to read what a terminal shows without the DOM: the
// WebGL renderer draws on a canvas, so .xterm-rows is gone while it runs.
// Nothing is attached unless the page was loaded with the test flag
// (window.__termoteE2E, set by an init script before the app runs).

export interface TerminalProbe {
  // The pane the terminal streams, when it has one
  paneId: () => string | undefined
  // The rows on screen, trailing blanks trimmed
  lines: () => string[]
  // Whether the WebGL renderer draws it
  webgl: () => boolean
  // Writes to the terminal (not to the pane) and resolves once parsed:
  // renderer measurements write straight to xterm.js
  write: (data: string) => Promise<void>
}

interface ProbeWindow {
  __termoteE2E?: boolean
  __termoteTerms?: TerminalProbe[]
}

// Adds probe to window.__termoteTerms when the test flag is set; returns
// what removes it.
export function registerTerminalProbe(probe: TerminalProbe): () => void {
  const w = window as unknown as ProbeWindow
  if (w.__termoteE2E !== true) return () => {}
  w.__termoteTerms ??= []
  w.__termoteTerms.push(probe)
  return () => {
    const list = w.__termoteTerms
    /* v8 ignore next */
    if (!list) return
    const at = list.indexOf(probe)
    if (at >= 0) list.splice(at, 1)
  }
}

interface BufferLike {
  buffer: {
    active: {
      viewportY: number
      getLine: (
        y: number,
      ) => { translateToString: (trim: boolean) => string } | undefined
    }
  }
  rows: number
}

// The rows a terminal shows now, read from its buffer
export function visibleLines(term: BufferLike): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < term.rows; y++) {
    out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
  }
  return out
}
