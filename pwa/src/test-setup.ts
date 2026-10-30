import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { resetFilesPersist } from './utils/files-persist'
import { setFocusWindowForTest } from './utils/focus-mode'
import { resetPaneKeys } from './utils/pane-remap'

// What a test kept on the device (tabs, drafts, pane views) and the pane
// keys it set are never seen by the next one, nor its focus window.
afterEach(() => {
  setFocusWindowForTest(false)
  localStorage.clear()
  resetFilesPersist()
  resetPaneKeys()
})

// Mock window.matchMedia (not available in jsdom)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

// jsdom lays nothing out and has no Range rects: CodeMirror measures text
// ranges (the cursor, the selection, scrolling to it) in a later frame, and
// logs the TypeError to stderr in whichever test that frame lands in
Range.prototype.getClientRects ??= () =>
  Object.assign([], { item: () => null }) as unknown as DOMRectList
Range.prototype.getBoundingClientRect ??= () => new DOMRect()
