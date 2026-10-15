import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { resetFilesPersist } from './utils/files-persist'
import { resetPaneKeys } from './utils/pane-remap'

// What a test kept on the device (tabs, drafts, pane views) and the pane
// keys it set are never seen by the next one.
afterEach(() => {
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
