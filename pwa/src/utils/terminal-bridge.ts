/**
 * Utilities that drive the in-page xterm.js terminal (TerminalView) through
 * its public API. Input goes straight to the terminal stream.
 */
import type { TerminalHandle } from '../components/terminal-view'

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

// True while the stream is down (dropped, backing off, or stopped); Enter
// then asks for a reconnect instead of being sent.
export function isTerminalDisconnected(handle: TerminalHandle | null): boolean {
  const state = handle?.connectionState
  return state === 'disconnected' || state === 'error'
}

// Send a key to the terminal with modifier support
// Uses xterm CSI encoding: ESC[1;{mod}{code} for special keys with modifiers
export function sendKeyToTerminal(
  handle: TerminalHandle | null,
  key: string,
  modifiers: { ctrl?: boolean; shift?: boolean } = {},
) {
  if (!handle?.term) return

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

  handle.send(data)
}

// Focus the terminal
export function focusTerminal(handle: TerminalHandle | null) {
  handle?.term?.focus()
}

// Blur the terminal (hide keyboard)
export function blurTerminal(handle: TerminalHandle | null) {
  handle?.term?.blur()
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
  handle: TerminalHandle | null,
): Promise<PasteResult> {
  if (!handle?.term) return { ok: false, reason: 'no-terminal' }

  // Check if clipboard API is supported
  if (!navigator.clipboard?.readText) {
    return { ok: false, reason: 'not-supported' }
  }

  try {
    const text = await navigator.clipboard.readText()
    if (text) {
      handle.paste(text)
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
  handle: TerminalHandle | null,
  command: string,
) {
  if (!handle?.term) return
  handle.send(command + '\r')
}

// Send text to terminal (without Enter/newline) - for IME input
export function sendTextToTerminal(
  handle: TerminalHandle | null,
  text: string,
) {
  if (!handle?.term || !text) return
  handle.send(text)
}

// Scroll the xterm.js scrollback (for non-tmux terminals)
export function scrollTerminal(
  handle: TerminalHandle | null,
  direction: 'up' | 'down',
  pages = false,
) {
  const term = handle?.term
  if (!term) {
    console.warn('[terminal-bridge] scrollTerminal: term not found')
    return
  }
  const amount = direction === 'up' ? -1 : 1
  if (pages) term.scrollPages(amount)
  else term.scrollLines(amount * 5)
}

// Scroll a pane wider than the screen sideways by most of a screen width.
// Returns false when nothing overflows, so the caller can use the gesture
// for something else.
export function scrollTerminalHorizontal(
  handle: TerminalHandle | null,
  direction: 'left' | 'right',
): boolean {
  const el = handle?.scroller
  if (!el || el.scrollWidth <= el.clientWidth) return false
  const step = el.clientWidth * 0.8
  el.scrollBy({ left: direction === 'left' ? -step : step, behavior: 'smooth' })
  return true
}

// Get copy mode state of this terminal
export function isInCopyMode(handle: TerminalHandle | null): boolean {
  return handle?.copyMode ?? false
}

// Toggle tmux copy mode; returns the new state
export function toggleTmuxCopyMode(handle: TerminalHandle | null): boolean {
  if (handle?.copyMode) {
    exitTmuxCopyMode(handle)
    return false
  }
  enterTmuxCopyMode(handle)
  return handle?.copyMode ?? false
}

// Enter tmux copy mode (Ctrl+b [); no-op on backends without copy mode
export function enterTmuxCopyMode(handle: TerminalHandle | null) {
  if (!handle?.term || !handle.copyModeSupported) return
  handle.send('\x02')
  setTimeout(() => handle.send('['), 50)
  handle.copyMode = true
}

// Scroll the xterm.js viewport (not tmux history)
export function scrollTerminalViewport(
  handle: TerminalHandle | null,
  direction: 'up' | 'down',
) {
  handle?.term?.scrollLines(direction === 'up' ? -5 : 5)
}

// Scroll in tmux copy mode (PageUp/PageDown)
// Sends PageUp/PageDown - only effective when in tmux copy mode
export function scrollTmux(
  handle: TerminalHandle | null,
  direction: 'up' | 'down',
) {
  if (!handle?.term) return
  handle.send(direction === 'up' ? '\x1b[5~' : '\x1b[6~')
}

// Exit tmux copy mode
export function exitTmuxCopyMode(handle: TerminalHandle | null) {
  if (!handle?.term) return
  handle.send('q')
  handle.copyMode = false
}

// Paste from tmux buffer (Ctrl+b ]); no-op on backends without tmux buffers
export function pasteTmuxBuffer(handle: TerminalHandle | null) {
  if (!handle?.term || !handle.copyModeSupported) return
  handle.send('\x02')
  setTimeout(() => handle.send(']'), 50)
}

// Reset copy mode state (call when switching windows, etc.)
export function resetCopyModeState(handle: TerminalHandle | null) {
  if (handle) handle.copyMode = false
}

// Set terminal font size
export function setTerminalFontSize(
  handle: TerminalHandle | null,
  size: number,
) {
  const term = handle?.term
  if (term) term.options.fontSize = size
}

// Set terminal theme; returns whether a terminal was there to apply it to
export function setTerminalTheme(
  handle: TerminalHandle | null,
  theme: Record<string, unknown>,
): boolean {
  const term = handle?.term
  if (!term) return false
  term.options.theme = theme
  return true
}

// Check if terminal is ready
export function isTerminalReady(handle: TerminalHandle | null): boolean {
  return !!handle?.term
}

// WeakMap keyed on the terminal element so the handler is GC'd with it
const contextMenuHandlers = new WeakMap<HTMLElement, (e: Event) => void>()

export function blockContextMenu(handle: TerminalHandle | null): boolean {
  const el = handle?.element
  if (!el) return false
  if (contextMenuHandlers.has(el)) return true

  const handler = (e: Event) => e.preventDefault()
  contextMenuHandlers.set(el, handler)
  el.addEventListener('contextmenu', handler)
  return true
}

export function unblockContextMenu(handle: TerminalHandle | null): boolean {
  const el = handle?.element
  if (!el) return false

  const handler = contextMenuHandlers.get(el)
  if (!handler) return true

  el.removeEventListener('contextmenu', handler)
  contextMenuHandlers.delete(el)
  return true
}
