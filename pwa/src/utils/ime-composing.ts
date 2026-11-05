import type { KeyboardEvent } from 'react'

// A key that belongs to an IME composition: while composing, or, in Safari,
// the Enter that confirms it arriving after compositionend (keyCode 229)
export const imeComposing = (e: KeyboardEvent) =>
  e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
