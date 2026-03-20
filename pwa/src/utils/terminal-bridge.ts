/**
 * Utilities for sending keystrokes to ttyd iframe terminal
 * ttyd exposes window.term globally which we can access from same-origin iframe
 * Uses xterm.js internal _core API to bypass isTrusted check
 */

// Key mappings for special keys (xterm escape sequences)
const KEY_MAP: Record<string, string> = {
  Tab: '\t',
  Escape: '\x1b',
  Enter: '\r',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Backspace: '\x7f',
  Delete: '\x1b[3~',
}

// xterm.js Terminal with internal API
interface XtermInternal {
  _core?: {
    // onData event emitter inside _core
    _onData?: { fire(data: string): void }
    coreService?: {
      triggerDataEvent(data: string, wasUserInput?: boolean): void
    }
  }
  focus(): void
  options: { theme: unknown; fontSize: number }
  scrollLines(amount: number): void
  scrollPages(amount: number): void
}

// Get xterm terminal instance from iframe
function getTerm(iframe: HTMLIFrameElement | null): XtermInternal | null {
  if (!iframe) return null
  try {
    return (iframe.contentWindow as { term?: XtermInternal })?.term ?? null
  } catch {
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
  return false
}

// Send a key to the terminal
export function sendKeyToTerminal(
  iframe: HTMLIFrameElement | null,
  key: string,
  ctrl = false,
) {
  const term = getTerm(iframe)
  if (!term) return

  let data: string
  if (ctrl) {
    // Convert to control character (Ctrl+C = \x03, etc.)
    const code = key.toLowerCase().charCodeAt(0) - 96
    if (code >= 1 && code <= 26) {
      data = String.fromCharCode(code)
    } else {
      return
    }
  } else {
    data = KEY_MAP[key] ?? key
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

// Paste text into terminal
export async function pasteToTerminal(iframe: HTMLIFrameElement | null) {
  const term = getTerm(iframe)
  if (!term) return
  try {
    const text = await navigator.clipboard.readText()
    sendData(term, text)
  } catch (err) {
    console.warn('Clipboard access denied:', err)
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
  term.options.fontSize = size
}
