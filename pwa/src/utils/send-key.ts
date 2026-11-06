import type { KeyboardEvent } from 'react'

// Whether a key pressed in a message box sends it: Ctrl/Cmd+Enter always,
// Enter alone when enterSends (Shift+Enter and Alt+Enter stay a new line).
// An Enter that ends an IME composition only commits the text.
export function isSendKey(e: KeyboardEvent, enterSends: boolean): boolean {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return false
  return e.ctrlKey || e.metaKey || (enterSends && !e.shiftKey && !e.altKey)
}
