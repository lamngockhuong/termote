/**
 * Utilities for sending keystrokes to ttyd iframe terminal
 * ttyd exposes window.term globally which we can access from same-origin iframe
 * Uses xterm.js internal _core API to bypass isTrusted check
 */

// Key mappings for special keys (xterm escape sequences)
// Format: { base: unmodified sequence, code: CSI code for modifiers }
const KEY_MAP: Record<string, { base: string; code?: string }> = {
  Tab: { base: '\t' }, // Shift+Tab handled specially as \x1b[Z
  Escape: { base: '\x1b' },
  Enter: { base: '\r' },
  ArrowUp: { base: '\x1b[A', code: 'A' },
  ArrowDown: { base: '\x1b[B', code: 'B' },
  ArrowRight: { base: '\x1b[C', code: 'C' },
  ArrowLeft: { base: '\x1b[D', code: 'D' },
  Backspace: { base: '\x7f' },
  Delete: { base: '\x1b[3~', code: '3~' },
  Home: { base: '\x1b[H', code: 'H' },
  End: { base: '\x1b[F', code: 'F' },
  PageUp: { base: '\x1b[5~', code: '5~' },
  PageDown: { base: '\x1b[6~', code: '6~' },
  Insert: { base: '\x1b[2~', code: '2~' },
}

// Calculate xterm modifier value: 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0)
function getModifierValue(shift: boolean, ctrl: boolean, alt = false): number {
  /* v8 ignore next */
  return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)
}

// xterm.js Terminal with internal API
interface XtermInternal {
  _core?: {
    // onData event emitter inside _core
    _onData?: { fire(data: string): void }
    coreService?: {
      triggerDataEvent(data: string, wasUserInput?: boolean): void
    }
    _renderService?: {
      _renderer?: { clearTextureAtlas?: () => void }
      refreshRows?: (start: number, end: number) => void
    }
  }
  focus(): void
  // Newer xterm.js API
  options?: { theme?: unknown; fontSize?: number }
  // Older xterm.js API
  setOption?: (key: string, value: unknown) => void
  getOption?: (key: string) => unknown
  scrollLines(amount: number): void
  scrollPages(amount: number): void
  // Refresh/redraw methods
  refresh?: (start: number, end: number) => void
  rows?: number
  cols?: number
  // Force re-render
  clearTextureAtlas?: () => void
}

// Get xterm terminal instance from iframe
function getTerm(iframe: HTMLIFrameElement | null): XtermInternal | null {
  if (!iframe) return null
  try {
    return (iframe.contentWindow as { term?: XtermInternal })?.term ?? null
  } catch {
    /* v8 ignore next */
    return null
  }
}

// Send data directly to terminal using internal xterm.js API
function sendData(term: XtermInternal, data: string): boolean {
  if (term._core?._onData?.fire) {
    term._core._onData.fire(data)
    return true
  }
  if (term._core?.coreService?.triggerDataEvent) {
    term._core.coreService.triggerDataEvent(data, true)
    return true
  }
  /* v8 ignore next */
  return false
}

// Check if ttyd terminal is disconnected by looking for the reconnect overlay.
// ttyd appends an overlay div with "Reconnect" text to .xterm when disconnected.
export function isTerminalDisconnected(
  iframe: HTMLIFrameElement | null,
): boolean {
  try {
    const xtermEl = iframe?.contentDocument?.querySelector('.xterm')
    if (!xtermEl) return false
    return Array.from(xtermEl.children).some((el) =>
      el.textContent?.includes('Reconnect'),
    )
  } catch {
    /* v8 ignore next */
    return false
  }
}

// Send a key to the terminal with modifier support
// Uses xterm CSI encoding: ESC[1;{mod}{code} for special keys with modifiers
export function sendKeyToTerminal(
  iframe: HTMLIFrameElement | null,
  key: string,
  modifiers: { ctrl?: boolean; shift?: boolean } = {},
) {
  const term = getTerm(iframe)
  if (!term) return

  const { ctrl = false, shift = false } = modifiers
  const hasModifier = ctrl || shift
  const mapped = KEY_MAP[key]

  let data: string

  // Special case: Shift+Tab = backtab
  if (shift && !ctrl && key === 'Tab') {
    data = '\x1b[Z'
  }
  // Special keys with modifiers: use CSI encoding
  else if (hasModifier && mapped?.code) {
    const mod = getModifierValue(shift, ctrl)
    // Format: ESC[1;{mod}{code} (e.g., Shift+Up = ESC[1;2A)
    data = `\x1b[1;${mod}${mapped.code}`
  }
  // Ctrl+letter: control character
  else if (ctrl && /^[a-z]$/i.test(key)) {
    const code = key.toLowerCase().charCodeAt(0) - 96
    if (code >= 1 && code <= 26) {
      data = String.fromCharCode(code)
    /* v8 ignore start */
    } else {
      return
    /* v8 ignore stop */
    }
  }
  // Shift+letter: uppercase
  else if (shift && /^[a-z]$/i.test(key)) {
    data = key.toUpperCase()
  }
  // No modifier or unhandled: use base mapping
  else {
    data = mapped?.base ?? key
  }

  sendData(term, data)
}

// Focus the terminal
export function focusTerminal(iframe: HTMLIFrameElement | null) {
  const term = getTerm(iframe)
  term?.focus()
}

// Blur the terminal (hide keyboard)
export function blurTerminal(iframe: HTMLIFrameElement | null) {
  try {
    const activeEl = iframe?.contentDocument?.activeElement as HTMLElement
    activeEl?.blur()
  } catch {
    // Cross-origin or not available
  }
}

export type PasteErrorReason =
  | 'no-terminal'
  | 'empty'
  | 'not-allowed' // User denied or not a valid user gesture
  | 'not-secure' // Not HTTPS
  | 'not-supported' // Browser doesn't support clipboard API
  | 'unknown'

export type PasteResult = { ok: true } | { ok: false; reason: PasteErrorReason }

// Paste text into terminal - returns result with specific error reason
export async function pasteToTerminal(
  iframe: HTMLIFrameElement | null,
): Promise<PasteResult> {
  const term = getTerm(iframe)
  if (!term) return { ok: false, reason: 'no-terminal' }

  // Check if clipboard API is supported
  if (!navigator.clipboard?.readText) {
    return { ok: false, reason: 'not-supported' }
  }

  try {
    const text = await navigator.clipboard.readText()
    if (text) {
      sendData(term, text)
      return { ok: true }
    }
    return { ok: false, reason: 'empty' }
  } catch (err) {
    const error = err as Error
    console.warn('Clipboard access failed:', error.name, error.message)

    // Detect specific error types
    if (error.name === 'NotAllowedError') {
      return { ok: false, reason: 'not-allowed' }
    }
    if (error.name === 'SecurityError' || !window.isSecureContext) {
      return { ok: false, reason: 'not-secure' }
    }
    if (error.name === 'TypeError') {
      return { ok: false, reason: 'not-supported' }
    }
    return { ok: false, reason: 'unknown' }
  }
}

// Send a command string to terminal
export function sendCommandToTerminal(
  iframe: HTMLIFrameElement | null,
  command: string,
) {
  const term = getTerm(iframe)
  if (!term) return
  sendData(term, command + '\r')
}

// Send text to terminal (without Enter/newline) - for IME input
export function sendTextToTerminal(
  iframe: HTMLIFrameElement | null,
  text: string,
) {
  const term = getTerm(iframe)
  if (!term || !text) return
  sendData(term, text)
}

// Scroll terminal viewport (for non-tmux terminals)
export function scrollTerminal(
  iframe: HTMLIFrameElement | null,
  direction: 'up' | 'down',
  pages = false,
) {
  const term = getTerm(iframe)
  if (!term) {
    console.warn('[terminal-bridge] scrollTerminal: term not found')
    return
  }

  const amount = direction === 'up' ? -1 : 1

  // Try xterm.js public API first
  if (typeof term.scrollPages === 'function' && pages) {
    term.scrollPages(amount)
    return
  }
  if (typeof term.scrollLines === 'function') {
    term.scrollLines(amount * (pages ? 10 : 5))
    return
  }

  // Fallback: scroll viewport element directly
  try {
    const doc = iframe?.contentDocument
    const viewport = doc?.querySelector('.xterm-viewport') as HTMLElement
    if (viewport) {
      const scrollAmount = pages
        ? viewport.clientHeight
        : viewport.clientHeight / 3
      viewport.scrollTop += direction === 'up' ? -scrollAmount : scrollAmount
    }
  } catch (e) {
    console.warn('[terminal-bridge] scrollTerminal fallback failed:', e)
  }
}

// Track if we're in copy mode
let inCopyMode = false

// Get copy mode state
export function isInCopyMode(): boolean {
  return inCopyMode
}

// Toggle tmux copy mode
export function toggleTmuxCopyMode(iframe: HTMLIFrameElement | null): boolean {
  if (inCopyMode) {
    exitTmuxCopyMode(iframe)
    return false
  } else {
    enterTmuxCopyMode(iframe)
    return true
  }
}

// Enter tmux copy mode (Ctrl+b [)
export function enterTmuxCopyMode(iframe: HTMLIFrameElement | null) {
  const term = getTerm(iframe)
  if (!term) return
  // Send Ctrl+b
  sendData(term, '\x02')
  // Then send [
  setTimeout(() => sendData(term, '['), 50)
  inCopyMode = true
}

// Scroll terminal viewport (xterm.js viewport, not tmux history)
export function scrollTerminalViewport(
  iframe: HTMLIFrameElement | null,
  direction: 'up' | 'down',
) {
  try {
    const doc = iframe?.contentDocument
    const viewport = doc?.querySelector('.xterm-viewport') as HTMLElement
    if (viewport) {
      const amount = direction === 'up' ? -100 : 100
      viewport.scrollBy({ top: amount, behavior: 'smooth' })
    }
  } catch {
    // Cross-origin or not available
  }
}

// Scroll in tmux copy mode (PageUp/PageDown)
// Sends PageUp/PageDown - only effective when in tmux copy mode
export function scrollTmux(
  iframe: HTMLIFrameElement | null,
  direction: 'up' | 'down',
) {
  const term = getTerm(iframe)
  if (!term) return

  const seq = direction === 'up' ? '\x1b[5~' : '\x1b[6~'
  sendData(term, seq)
}

// Exit tmux copy mode
export function exitTmuxCopyMode(iframe: HTMLIFrameElement | null) {
  const term = getTerm(iframe)
  if (!term) return
  sendData(term, 'q')
  inCopyMode = false
}

// Paste from tmux buffer (Ctrl+b ])
export function pasteTmuxBuffer(iframe: HTMLIFrameElement | null) {
  const term = getTerm(iframe)
  if (!term) return
  // Send Ctrl+b
  sendData(term, '\x02')
  // Then send ]
  setTimeout(() => sendData(term, ']'), 50)
}

// Reset copy mode state (call when switching windows, etc.)
export function resetCopyModeState() {
  inCopyMode = false
}

// Set terminal font size
export function setTerminalFontSize(
  iframe: HTMLIFrameElement | null,
  size: number,
) {
  const term = getTerm(iframe)
  if (!term) return

  // Try newer API first, then older API
  if (term.options) {
    term.options.fontSize = size
  } else if (term.setOption) {
    term.setOption('fontSize', size)
  }
}

// Set terminal theme and apply background to all elements
export function setTerminalTheme(
  iframe: HTMLIFrameElement | null,
  theme: Record<string, unknown>,
): boolean {
  const term = getTerm(iframe)
  if (!term) return false

  // Apply theme to xterm.js - try newer API first, then older API
  let themeApplied = false
  if (term.options) {
    term.options.theme = theme
    themeApplied = true
  } else if (term.setOption) {
    term.setOption('theme', theme)
    themeApplied = true
  }

  // Force redraw to apply theme immediately
  if (themeApplied) {
    // Clear texture atlas to force re-render with new colors
    if (term.clearTextureAtlas) {
      term.clearTextureAtlas()
    }
    if (term._core?._renderService?._renderer?.clearTextureAtlas) {
      term._core._renderService._renderer.clearTextureAtlas()
    }
    // Refresh all rows
    if (term.refresh && term.rows) {
      term.refresh(0, term.rows - 1)
    }
    // Also try internal refresh
    if (term._core?._renderService?.refreshRows && term.rows) {
      term._core._renderService.refreshRows(0, term.rows - 1)
    }
  }

  // Apply background via CSS (fallback for elements not covered by xterm API)
  try {
    const doc = iframe?.contentDocument
    if (!doc) return themeApplied

    const bg = theme.background as string

    // Inject/update CSS for background
    const styleId = 'termote-theme-override'
    let style = doc.getElementById(styleId) as HTMLStyleElement
    if (!style) {
      style = doc.createElement('style')
      style.id = styleId
      doc.head.appendChild(style)
    }
    style.textContent = `
      body, .xterm, .xterm-viewport, .xterm-screen {
        background-color: ${bg} !important;
      }
    `
  } catch {
    // Cross-origin or not available
  }

  return themeApplied
}

// Check if terminal is ready (has options or setOption API)
export function isTerminalReady(iframe: HTMLIFrameElement | null): boolean {
  const term = getTerm(iframe)
  return term !== null && (!!term.options || !!term.setOption)
}

// WeakMap keyed on Document so handler ref survives remounts but is GC'd with the iframe
const contextMenuHandlers = new WeakMap<Document, (e: Event) => void>()

export function blockContextMenu(iframe: HTMLIFrameElement | null): boolean {
  try {
    const doc = iframe?.contentDocument
    if (!doc) return false
    if (contextMenuHandlers.has(doc)) return true

    const handler = (e: Event) => e.preventDefault()
    contextMenuHandlers.set(doc, handler)
    doc.addEventListener('contextmenu', handler)
    return true
  } catch {
    return false
  }
}

export function unblockContextMenu(iframe: HTMLIFrameElement | null): boolean {
  try {
    const doc = iframe?.contentDocument
    if (!doc) return false

    const handler = contextMenuHandlers.get(doc)
    if (!handler) return true

    doc.removeEventListener('contextmenu', handler)
    contextMenuHandlers.delete(doc)
    return true
  } catch {
    return false
  }
}
