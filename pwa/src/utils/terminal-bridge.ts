/**
 * Utilities that drive the in-page xterm.js terminal (TerminalView) through
 * its public API. Input goes straight to the terminal stream.
 */
import type { Terminal } from '@xterm/xterm'
import type { TerminalHandle } from '../components/terminal-view'
import { copyText } from './copy-text'
import { type UploadErrorReason, uploadImage } from './upload-image'

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

// image: the clipboard held an image and no text; nothing was pasted, the
// caller uploads it (attachImageToTerminal).
export type PasteResult =
  | { ok: true; image?: Blob }
  | { ok: false; reason: PasteErrorReason }

// What clipboard.read() found: an image only when no item has text (the same
// rule as a paste event), else the text. null when read() is missing or
// fails, so the caller falls back to readText().
async function readClipboardItems(): Promise<
  { image: Blob } | { text: string } | null
> {
  if (!navigator.clipboard.read) return null
  try {
    const items = await navigator.clipboard.read()
    const textItem = items.find((i) => i.types.includes('text/plain'))
    if (textItem) {
      return { text: await (await textItem.getType('text/plain')).text() }
    }
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (type) return { image: await item.getType(type) }
    }
    return { text: '' }
  } catch (err) {
    const error = err as Error
    console.warn('Clipboard read failed:', error.name, error.message)
    return null
  }
}

// Paste text into terminal - returns result with specific error reason.
// With images, an image-only clipboard is returned instead of pasted.
export async function pasteToTerminal(
  handle: TerminalHandle | null,
  { images = false }: { images?: boolean } = {},
): Promise<PasteResult> {
  if (!handle?.term) return { ok: false, reason: 'no-terminal' }

  // Check if clipboard API is supported
  if (!navigator.clipboard?.readText) {
    return { ok: false, reason: 'not-supported' }
  }

  const items = images ? await readClipboardItems() : null
  if (items && 'image' in items) return { ok: true, image: items.image }

  try {
    const text = items ? items.text : await navigator.clipboard.readText()
    if (!text) return { ok: false, reason: 'empty' }
    handle.paste(text)
    return { ok: true }
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

export type AttachResult =
  | { status: 'inserted' }
  // The user moved to another pane while it uploaded; nothing was pasted.
  | { status: 'pane-changed'; insert: string }
  // The stream was not open (or the terminal is view-only).
  | { status: 'not-inserted'; insert: string }
  | { status: 'failed'; reason: UploadErrorReason }

// Uploads an image and types its path, plus a space, into the pane it was
// picked for: paneId is the pane active when the upload started, compared
// with the active one once it ends (a slow upload must not land elsewhere).
export async function attachImageToTerminal(
  handle: TerminalHandle | null,
  image: Blob,
  paneId: string,
  getActivePaneId: () => string,
): Promise<AttachResult> {
  const result = await uploadImage(image)
  if (!result.ok) return { status: 'failed', reason: result.reason }
  const { insert } = result.upload
  if (getActivePaneId() !== paneId) return { status: 'pane-changed', insert }
  if (!handle?.paste(`${insert} `)) return { status: 'not-inserted', insert }
  return { status: 'inserted' }
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

// Scroll the pane's history (for non-tmux terminals): through the backend
// when it scrolls the pane itself, else the xterm.js scrollback.
export function scrollTerminal(
  handle: TerminalHandle | null,
  direction: 'up' | 'down',
  pages = false,
) {
  const term = handle?.term
  if (!handle || !term) {
    console.warn('[terminal-bridge] scrollTerminal: term not found')
    return
  }
  const amount = direction === 'up' ? -1 : 1
  if (handle.scrollHistory(-amount * (pages ? term.rows : 5))) return
  if (pages) term.scrollPages(amount)
  else term.scrollLines(amount * 5)
}

// A pane wider than the screen (herdr, sized by the desktop) is dragged
// sideways rather than taking swipes as keys.
export function overflowsHorizontally(handle: TerminalHandle | null): boolean {
  const el = handle?.scroller
  return !!el && el.scrollWidth > el.clientWidth
}

// Height of a terminal row in pixels, at its font size.
export function terminalRowHeight(term: Pick<Terminal, 'options'>): number {
  return (term.options.fontSize ?? 14) * 1.2
}

// Rows of a vertical drag not scrolled yet, per terminal.
const dragRest = new WeakMap<TerminalHandle, number>()

// Move the terminal with the finger (dx, dy in pixels, as in
// GestureHandlers.onPan). A pane larger than the screen moves first, to its
// edges; what is left of a vertical drag scrolls the history when history is
// set, one row per row height dragged (down shows older rows).
export function dragTerminal(
  handle: TerminalHandle | null,
  dx: number,
  dy: number,
  history: boolean,
) {
  const el = handle?.scroller
  const term = handle?.term
  if (!handle || !el || !term) return
  if (dx) el.scrollLeft -= dx
  if (!dy) return
  const before = el.scrollTop
  el.scrollTop = before - dy
  // The part of the drag the pane could not take. Only at an edge: the
  // browser rounds scrollTop, which would leak fractions mid-pane.
  const rest = dy - (before - el.scrollTop)
  const top = el.scrollTop <= 0
  const bottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 1
  if (!history || !rest || !(rest > 0 ? top : bottom)) return
  const rows = (dragRest.get(handle) ?? 0) + rest / terminalRowHeight(term)
  const whole = Math.trunc(rows)
  dragRest.set(handle, rows - whole)
  if (whole && !handle.scrollHistory(whole)) term.scrollLines(-whole)
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

// Set the terminal font family (a full CSS font-family list)
export function setTerminalFontFamily(
  handle: TerminalHandle | null,
  family: string,
) {
  const term = handle?.term
  if (term) term.options.fontFamily = family
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

// Text selected in the terminal (mouse drag), or '' without a selection
export function terminalSelection(handle: TerminalHandle | null): string {
  const term = handle?.term
  if (!term?.hasSelection()) return ''
  return term.getSelection()
}

// Copies the terminal's selection: 'empty' when nothing is selected
export async function copyTerminalSelection(
  handle: TerminalHandle | null,
): Promise<'ok' | 'failed' | 'empty'> {
  const text = terminalSelection(handle)
  if (!text) return 'empty'
  return copyText(text)
}

// Control characters other than tab and line feed (the stream's text, so an
// escape sequence never reaches the clipboard)
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches control characters
const BUFFER_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

// The terminal's buffer as plain text: what it holds of the pane (its
// scrollback and screen; Herdr's stream carries the screen only), rows that
// wrapped joined into one line, trailing spaces and the blank rows at the
// bottom dropped.
export function readTerminalBufferText(handle: TerminalHandle | null): string {
  const buffer = handle?.term?.buffer.active
  if (!buffer) return ''
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    const row = buffer.getLine(y)
    /* v8 ignore next */
    if (!row) continue
    const text = row.translateToString(true)
    if (row.isWrapped && lines.length) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.map((l) => l.replace(BUFFER_CONTROLS, '').trimEnd()).join('\n')
}

// Apple keyboards copy with Cmd+C, which xterm leaves to the browser; there
// Ctrl+Shift+C stays a terminal key.
export function isApplePlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform || navigator.platform || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

// Ctrl+Shift+C pressed (not on an Apple platform)
export function isCopyShortcut(
  e: Pick<
    KeyboardEvent,
    'type' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code' | 'key'
  >,
  apple = isApplePlatform(),
): boolean {
  return (
    !apple &&
    e.type === 'keydown' &&
    e.ctrlKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === 'KeyC' || e.key.toLowerCase() === 'c')
  )
}
