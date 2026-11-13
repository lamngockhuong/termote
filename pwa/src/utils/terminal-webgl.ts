import type { Terminal } from '@xterm/xterm'

// The terminal drawn by WebGL2 (@xterm/addon-webgl), else by xterm.js's own
// DOM renderer. The addon is its own chunk, fetched only when a terminal
// asks for it: until it is in, and whenever it cannot run, the DOM renderer
// draws. Disposing the addon gives the terminal back to the DOM renderer.

// Terminals drawn by WebGL on one page. Browsers keep about 16 WebGL contexts
// a page and drop the oldest past that; a large Herdr layout would lose
// contexts in a loop, so the terminals past this many use the DOM renderer.
export const MAX_WEBGL_TERMINALS = 8

let inUse = 0

export function resetWebglForTest(): void {
  inUse = 0
}

export function webglInUse(): number {
  return inUse
}

interface WebglAddonLike {
  onContextLoss: (listener: () => void) => { dispose: () => void }
  dispose: () => void
}

type AddonModule = {
  WebglAddon: new () => WebglAddonLike & Parameters<Terminal['loadAddon']>[0]
}

export interface WebglHandle {
  // Whether WebGL draws the terminal now
  active: () => boolean
  // Unloads the addon (back to the DOM renderer), or stops a load still in
  // flight; the terminal keeps working either way.
  dispose: () => void
}

// Loads the WebGL renderer into term, after term.open(). A failed import,
// no WebGL2, or no slot left keeps the DOM renderer and throws nothing.
// A context lost while the page is shown is given up by the addon after 3
// seconds; a context lost in the background, where that timer stands still,
// is seen when the page is shown again. Either way the page being shown again
// loads a new addon rather than giving up WebGL for good.
export function loadWebgl(
  term: Terminal,
  importAddon: () => Promise<AddonModule> = () =>
    import('@xterm/addon-webgl') as Promise<AddonModule>,
): WebglHandle {
  let disposed = false
  let addon: WebglAddonLike | null = null
  let slot = false
  // The context was lost and nothing restored it yet
  let lost = false
  let Addon: AddonModule['WebglAddon'] | null = null

  const give = () => {
    if (!slot) return
    slot = false
    inUse--
  }
  const unload = () => {
    const a = addon
    addon = null
    if (a) {
      try {
        a.dispose()
      } catch {
        // The terminal went first; nothing left to give back
      }
    }
    give()
  }
  const attach = () => {
    // Called with no addon loaded, so with no slot held
    if (disposed || !Addon || inUse >= MAX_WEBGL_TERMINALS) return
    inUse++
    slot = true
    lost = false
    let a: WebglAddonLike | null = null
    try {
      const made = new Addon()
      a = made
      made.onContextLoss(() => {
        if (addon !== made) return
        lost = true
        unload()
      })
      term.loadAddon(made)
      addon = made
    } catch {
      // No WebGL2 here, or the terminal is gone: an addon half started may
      // hold a canvas and a context
      try {
        a?.dispose()
      } catch {
        // Nothing more to free
      }
      give()
    }
  }

  const element = term.element
  // Not bubbling, but an ancestor's capture listener still sees them
  const onLost = () => {
    lost = true
  }
  const onRestored = () => {
    lost = false
  }
  element?.addEventListener('webglcontextlost', onLost, true)
  element?.addEventListener('webglcontextrestored', onRestored, true)
  const onVisibility = () => {
    if (document.visibilityState !== 'visible' || !lost) return
    unload()
    attach()
  }
  document.addEventListener('visibilitychange', onVisibility)

  importAddon().then(
    (mod) => {
      Addon = mod.WebglAddon
      attach()
    },
    () => {
      // Offline, or a chunk of an older build: the DOM renderer stays
    },
  )

  return {
    active: () => addon !== null,
    dispose: () => {
      if (disposed) return
      disposed = true
      element?.removeEventListener('webglcontextlost', onLost, true)
      element?.removeEventListener('webglcontextrestored', onRestored, true)
      document.removeEventListener('visibilitychange', onVisibility)
      unload()
    },
  }
}
