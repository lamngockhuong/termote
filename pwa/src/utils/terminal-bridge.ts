/**
 * Utilities for sending keystrokes to ttyd iframe terminal
 */

// Send a key event to the terminal iframe
export function sendKeyToTerminal(
  iframe: HTMLIFrameElement | null,
  key: string,
  ctrl = false
) {
  if (!iframe) return

  const event = new KeyboardEvent('keydown', {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey: ctrl,
    bubbles: true,
    cancelable: true,
  })

  try {
    // Same-origin iframe - direct access
    const activeElement = iframe.contentWindow?.document.activeElement
    if (activeElement) {
      activeElement.dispatchEvent(event)
    } else {
      iframe.contentWindow?.document.dispatchEvent(event)
    }
  } catch {
    // Cross-origin fallback - use same origin (via nginx proxy)
    iframe.contentWindow?.postMessage({ type: 'keydown', key, ctrl }, window.location.origin)
  }
}

// Focus the terminal iframe for native keyboard input
export function focusTerminal(iframe: HTMLIFrameElement | null) {
  if (!iframe) return
  iframe.focus()
  iframe.contentWindow?.focus()
}

// Paste text into terminal
export async function pasteToTerminal(iframe: HTMLIFrameElement | null) {
  if (!iframe) return

  try {
    const text = await navigator.clipboard.readText()
    // Send each character as a keypress
    for (const char of text) {
      sendKeyToTerminal(iframe, char)
    }
  } catch (err) {
    console.warn('Clipboard access denied:', err)
  }
}

// Send a command string to terminal (types it and presses Enter)
export function sendCommandToTerminal(iframe: HTMLIFrameElement | null, command: string) {
  if (!iframe) return

  for (const char of command) {
    sendKeyToTerminal(iframe, char)
  }
  sendKeyToTerminal(iframe, 'Enter')
}
