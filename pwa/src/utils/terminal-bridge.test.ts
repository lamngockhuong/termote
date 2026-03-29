import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isInCopyMode,
  isTerminalDisconnected,
  isTerminalReady,
  resetCopyModeState,
  scrollTerminal,
  sendKeyToTerminal,
  setTerminalFontSize,
  setTerminalTheme,
  toggleTmuxCopyMode,
} from './terminal-bridge'

// Mock xterm terminal instance
function createMockTerm(overrides = {}) {
  return {
    _core: {
      _onData: { fire: vi.fn() },
      _renderService: {
        _renderer: { clearTextureAtlas: vi.fn() },
        refreshRows: vi.fn(),
      },
    },
    focus: vi.fn(),
    options: { theme: null as unknown, fontSize: 14 },
    scrollLines: vi.fn(),
    scrollPages: vi.fn(),
    refresh: vi.fn(),
    rows: 24,
    cols: 80,
    clearTextureAtlas: vi.fn(),
    ...overrides,
  }
}

function createMockIframe(
  term: ReturnType<typeof createMockTerm> | null = null,
) {
  const iframe = document.createElement('iframe')
  // Override contentWindow to expose mock term
  Object.defineProperty(iframe, 'contentWindow', {
    value: { term },
    writable: true,
  })
  Object.defineProperty(iframe, 'contentDocument', {
    value: document.implementation.createHTMLDocument(),
    writable: true,
  })
  return iframe
}

describe('sendKeyToTerminal', () => {
  it('sends plain character', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendKeyToTerminal(iframe, 'a')
    expect(term._core._onData.fire).toHaveBeenCalledWith('a')
  })

  it('sends Enter as carriage return', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendKeyToTerminal(iframe, 'Enter')
    expect(term._core._onData.fire).toHaveBeenCalledWith('\r')
  })

  it('sends Escape sequence', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendKeyToTerminal(iframe, 'Escape')
    expect(term._core._onData.fire).toHaveBeenCalledWith('\x1b')
  })

  it('sends Ctrl+C as control character', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendKeyToTerminal(iframe, 'c', { ctrl: true })
    expect(term._core._onData.fire).toHaveBeenCalledWith('\x03')
  })

  it('sends Ctrl+U as control character', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendKeyToTerminal(iframe, 'u', { ctrl: true })
    expect(term._core._onData.fire).toHaveBeenCalledWith('\x15')
  })

  it('sends Shift+Tab as backtab', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendKeyToTerminal(iframe, 'Tab', { shift: true })
    expect(term._core._onData.fire).toHaveBeenCalledWith('\x1b[Z')
  })

  it('sends Shift+letter as uppercase', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendKeyToTerminal(iframe, 'a', { shift: true })
    expect(term._core._onData.fire).toHaveBeenCalledWith('A')
  })

  it('sends arrow key with modifier using CSI encoding', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    // Shift+Up = ESC[1;2A
    sendKeyToTerminal(iframe, 'ArrowUp', { shift: true })
    expect(term._core._onData.fire).toHaveBeenCalledWith('\x1b[1;2A')
  })

  it('does nothing when iframe is null', () => {
    sendKeyToTerminal(null, 'a') // should not throw
  })
})

describe('isTerminalDisconnected', () => {
  it('returns false when no iframe', () => {
    expect(isTerminalDisconnected(null)).toBe(false)
  })

  it('returns false when no reconnect overlay', () => {
    const iframe = createMockIframe(createMockTerm())
    const doc = iframe.contentDocument!
    const xtermEl = doc.createElement('div')
    xtermEl.className = 'xterm'
    doc.body.appendChild(xtermEl)
    expect(isTerminalDisconnected(iframe)).toBe(false)
  })

  it('returns true when reconnect overlay present', () => {
    const iframe = createMockIframe(createMockTerm())
    const doc = iframe.contentDocument!
    const xtermEl = doc.createElement('div')
    xtermEl.className = 'xterm'
    const overlay = doc.createElement('div')
    overlay.textContent = 'Reconnect'
    xtermEl.appendChild(overlay)
    doc.body.appendChild(xtermEl)
    expect(isTerminalDisconnected(iframe)).toBe(true)
  })
})

describe('copy mode', () => {
  beforeEach(() => {
    resetCopyModeState()
  })

  it('starts not in copy mode', () => {
    expect(isInCopyMode()).toBe(false)
  })

  it('toggleTmuxCopyMode enters copy mode', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    const result = toggleTmuxCopyMode(iframe)
    expect(result).toBe(true)
    expect(isInCopyMode()).toBe(true)
  })

  it('toggleTmuxCopyMode exits copy mode on second call', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    toggleTmuxCopyMode(iframe) // enter
    const result = toggleTmuxCopyMode(iframe) // exit
    expect(result).toBe(false)
    expect(isInCopyMode()).toBe(false)
  })

  it('resetCopyModeState clears state', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    toggleTmuxCopyMode(iframe)
    expect(isInCopyMode()).toBe(true)
    resetCopyModeState()
    expect(isInCopyMode()).toBe(false)
  })
})

describe('setTerminalFontSize', () => {
  it('sets font size via options API', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    setTerminalFontSize(iframe, 20)
    expect(term.options.fontSize).toBe(20)
  })

  it('sets font size via setOption API', () => {
    const setOption = vi.fn()
    const term = createMockTerm({ options: undefined, setOption })
    const iframe = createMockIframe(term)
    setTerminalFontSize(iframe, 18)
    expect(setOption).toHaveBeenCalledWith('fontSize', 18)
  })

  it('does nothing when iframe is null', () => {
    setTerminalFontSize(null, 14) // should not throw
  })
})

describe('setTerminalTheme', () => {
  it('applies theme via options API and returns true', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    const theme = { background: '#fff', foreground: '#000' }
    const result = setTerminalTheme(iframe, theme)
    expect(result).toBe(true)
    expect(term.options.theme).toEqual(theme)
  })

  it('forces redraw after applying theme', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    setTerminalTheme(iframe, { background: '#fff' })
    expect(term.clearTextureAtlas).toHaveBeenCalled()
    expect(term.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('injects CSS override into iframe document', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    setTerminalTheme(iframe, { background: '#f6f8fa' })
    const style = iframe.contentDocument!.getElementById(
      'termote-theme-override',
    )
    expect(style).not.toBeNull()
    expect(style!.textContent).toContain('#f6f8fa')
  })

  it('returns false when iframe is null', () => {
    expect(setTerminalTheme(null, {})).toBe(false)
  })

  it('returns false when term is not available', () => {
    const iframe = createMockIframe(null)
    expect(setTerminalTheme(iframe, {})).toBe(false)
  })
})

describe('isTerminalReady', () => {
  it('returns true when term has options', () => {
    const iframe = createMockIframe(createMockTerm())
    expect(isTerminalReady(iframe)).toBe(true)
  })

  it('returns false when iframe is null', () => {
    expect(isTerminalReady(null)).toBe(false)
  })

  it('returns false when term is not available', () => {
    const iframe = createMockIframe(null)
    expect(isTerminalReady(iframe)).toBe(false)
  })
})

describe('scrollTerminal', () => {
  it('scrolls lines down', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    scrollTerminal(iframe, 'down')
    expect(term.scrollLines).toHaveBeenCalledWith(5)
  })

  it('scrolls lines up', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    scrollTerminal(iframe, 'up')
    expect(term.scrollLines).toHaveBeenCalledWith(-5)
  })

  it('scrolls pages when pages=true', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    scrollTerminal(iframe, 'down', true)
    expect(term.scrollPages).toHaveBeenCalledWith(1)
  })
})
