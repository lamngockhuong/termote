import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  blockContextMenu,
  blurTerminal,
  enterTmuxCopyMode,
  exitTmuxCopyMode,
  focusTerminal,
  isInCopyMode,
  isTerminalDisconnected,
  isTerminalReady,
  pasteTmuxBuffer,
  pasteToTerminal,
  resetCopyModeState,
  scrollTerminal,
  scrollTerminalViewport,
  scrollTmux,
  sendCommandToTerminal,
  sendKeyToTerminal,
  sendTextToTerminal,
  setTerminalFontSize,
  setTerminalTheme,
  toggleTmuxCopyMode,
  unblockContextMenu,
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

  it('does nothing when term has neither options nor setOption', () => {
    const term = createMockTerm({ options: undefined, setOption: undefined })
    const iframe = createMockIframe(term)
    expect(() => setTerminalFontSize(iframe, 18)).not.toThrow()
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

  it('returns false when term has neither options nor setOption', () => {
    const term = createMockTerm({ options: undefined, setOption: undefined })
    const iframe = createMockIframe(term)
    const result = setTerminalTheme(iframe, { background: '#000' })
    expect(result).toBe(false)
  })

  it('returns themeApplied early when contentDocument is null (line 412 true branch)', () => {
    const term = createMockTerm()
    const iframe = document.createElement('iframe')
    Object.defineProperty(iframe, 'contentWindow', {
      value: { term },
      writable: true,
      configurable: true,
    })
    Object.defineProperty(iframe, 'contentDocument', {
      value: null,
      writable: true,
      configurable: true,
    })
    const result = setTerminalTheme(iframe, { background: '#abc' })
    expect(result).toBe(true)
  })

  it('skips CSS injection when contentDocument throws', () => {
    const term = createMockTerm()
    // Create a raw iframe where contentDocument is a native getter (configurable)
    const iframe = document.createElement('iframe')
    Object.defineProperty(iframe, 'contentWindow', {
      value: { term },
      writable: true,
      configurable: true,
    })
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        throw new Error('cross-origin')
      },
      configurable: true,
    })
    // Should not throw; CSS injection is in a try/catch
    expect(() => setTerminalTheme(iframe, { background: '#fff' })).not.toThrow()
  })

  it('updates existing style element when termote-theme-override already exists', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    // Apply theme twice — second call should update existing style, not create new one
    setTerminalTheme(iframe, { background: '#111' })
    setTerminalTheme(iframe, { background: '#222' })
    const styles = iframe.contentDocument!.querySelectorAll(
      '#termote-theme-override',
    )
    expect(styles.length).toBe(1)
    expect(styles[0].textContent).toContain('#222')
  })
})

describe('isTerminalReady', () => {
  it('returns true when term has options', () => {
    const iframe = createMockIframe(createMockTerm())
    expect(isTerminalReady(iframe)).toBe(true)
  })

  it('returns true when term has setOption but no options', () => {
    const term = createMockTerm({ options: undefined, setOption: vi.fn() })
    const iframe = createMockIframe(term)
    expect(isTerminalReady(iframe)).toBe(true)
  })

  it('returns false when term has neither options nor setOption', () => {
    const term = createMockTerm({ options: undefined, setOption: undefined })
    const iframe = createMockIframe(term)
    expect(isTerminalReady(iframe)).toBe(false)
  })

  it('returns false when iframe is null', () => {
    expect(isTerminalReady(null)).toBe(false)
  })

  it('returns false when term is not available', () => {
    const iframe = createMockIframe(null)
    expect(isTerminalReady(iframe)).toBe(false)
  })
})

describe('blockContextMenu', () => {
  it('blocks context menu on iframe document', () => {
    const iframe = createMockIframe(createMockTerm())
    const result = blockContextMenu(iframe)
    expect(result).toBe(true)

    const event = new Event('contextmenu', { cancelable: true })
    iframe.contentDocument!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('is idempotent — second call returns true without re-adding', () => {
    const iframe = createMockIframe(createMockTerm())
    expect(blockContextMenu(iframe)).toBe(true)
    expect(blockContextMenu(iframe)).toBe(true)
  })

  it('returns false when iframe is null', () => {
    expect(blockContextMenu(null)).toBe(false)
  })
})

describe('unblockContextMenu', () => {
  it('removes context menu block', () => {
    const iframe = createMockIframe(createMockTerm())
    blockContextMenu(iframe)

    const result = unblockContextMenu(iframe)
    expect(result).toBe(true)

    const event = new Event('contextmenu', { cancelable: true })
    iframe.contentDocument!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('returns true when not blocked (no-op)', () => {
    const iframe = createMockIframe(createMockTerm())
    expect(unblockContextMenu(iframe)).toBe(true)
  })

  it('returns false when iframe is null', () => {
    expect(unblockContextMenu(null)).toBe(false)
  })

  it('allows re-blocking after unblock', () => {
    const iframe = createMockIframe(createMockTerm())
    blockContextMenu(iframe)
    unblockContextMenu(iframe)
    blockContextMenu(iframe)

    const event = new Event('contextmenu', { cancelable: true })
    iframe.contentDocument!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
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

  it('scrolls lines*10 when pages=true but scrollPages unavailable', () => {
    const term = createMockTerm({ scrollPages: undefined })
    const iframe = createMockIframe(term)
    scrollTerminal(iframe, 'up', true)
    expect(term.scrollLines).toHaveBeenCalledWith(-10)
  })

  it('falls back to viewport scrollTop when neither scrollLines nor scrollPages available', () => {
    const term = createMockTerm({
      scrollLines: undefined,
      scrollPages: undefined,
    })
    const iframe = createMockIframe(term)
    // contentDocument has an .xterm-viewport element
    const doc = iframe.contentDocument!
    const viewport = doc.createElement('div')
    viewport.className = 'xterm-viewport'
    Object.defineProperty(viewport, 'clientHeight', {
      value: 300,
      configurable: true,
    })
    viewport.scrollTop = 0
    doc.body.appendChild(viewport)
    scrollTerminal(iframe, 'down')
    expect(viewport.scrollTop).toBeGreaterThan(0)
  })

  it('falls back viewport scrollTop upward when pages=true and no scrollPages/scrollLines', () => {
    const term = createMockTerm({
      scrollLines: undefined,
      scrollPages: undefined,
    })
    const iframe = createMockIframe(term)
    const doc = iframe.contentDocument!
    const viewport = doc.createElement('div')
    viewport.className = 'xterm-viewport'
    Object.defineProperty(viewport, 'clientHeight', {
      value: 300,
      configurable: true,
    })
    viewport.scrollTop = 500
    doc.body.appendChild(viewport)
    scrollTerminal(iframe, 'up', true)
    expect(viewport.scrollTop).toBeLessThan(500)
  })

  it('does nothing when iframe is null', () => {
    scrollTerminal(null, 'down') // should not throw
  })
})

describe('sendCommandToTerminal', () => {
  it('sends command with carriage return', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendCommandToTerminal(iframe, 'ls -la')
    expect(term._core._onData.fire).toHaveBeenCalledWith('ls -la\r')
  })

  it('does nothing when iframe is null', () => {
    sendCommandToTerminal(null, 'ls') // should not throw
  })
})

describe('sendTextToTerminal', () => {
  it('sends text to terminal', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendTextToTerminal(iframe, 'hello')
    expect(term._core._onData.fire).toHaveBeenCalledWith('hello')
  })

  it('does nothing when iframe is null', () => {
    sendTextToTerminal(null, 'hello') // should not throw
  })

  it('does nothing when text is empty string', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendTextToTerminal(iframe, '')
    expect(term._core._onData.fire).not.toHaveBeenCalled()
  })
})

describe('scrollTerminalViewport', () => {
  it('scrolls viewport up', () => {
    const iframe = createMockIframe(createMockTerm())
    const doc = iframe.contentDocument!
    const viewport = doc.createElement('div')
    viewport.className = 'xterm-viewport'
    const scrollBySpy = vi.fn()
    viewport.scrollBy = scrollBySpy
    doc.body.appendChild(viewport)
    scrollTerminalViewport(iframe, 'up')
    expect(scrollBySpy).toHaveBeenCalledWith({ top: -100, behavior: 'smooth' })
  })

  it('scrolls viewport down', () => {
    const iframe = createMockIframe(createMockTerm())
    const doc = iframe.contentDocument!
    const viewport = doc.createElement('div')
    viewport.className = 'xterm-viewport'
    const scrollBySpy = vi.fn()
    viewport.scrollBy = scrollBySpy
    doc.body.appendChild(viewport)
    scrollTerminalViewport(iframe, 'down')
    expect(scrollBySpy).toHaveBeenCalledWith({ top: 100, behavior: 'smooth' })
  })

  it('does nothing when no viewport element found', () => {
    const iframe = createMockIframe(createMockTerm())
    // No .xterm-viewport in doc — should not throw
    expect(() => scrollTerminalViewport(iframe, 'up')).not.toThrow()
  })

  it('silently catches cross-origin errors', () => {
    const iframe = document.createElement('iframe')
    // contentDocument throws for cross-origin
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        throw new Error('cross-origin')
      },
      configurable: true,
    })
    expect(() => scrollTerminalViewport(iframe, 'down')).not.toThrow()
  })
})

describe('scrollTmux', () => {
  it('sends PageUp sequence when scrolling up', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    scrollTmux(iframe, 'up')
    expect(term._core._onData.fire).toHaveBeenCalledWith('\x1b[5~')
  })

  it('sends PageDown sequence when scrolling down', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    scrollTmux(iframe, 'down')
    expect(term._core._onData.fire).toHaveBeenCalledWith('\x1b[6~')
  })

  it('does nothing when iframe is null', () => {
    scrollTmux(null, 'up') // should not throw
  })
})

describe('enterTmuxCopyMode', () => {
  beforeEach(() => {
    resetCopyModeState()
    vi.useFakeTimers()
  })

  it('sends Ctrl+b then [ after timeout', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    enterTmuxCopyMode(iframe)
    expect(term._core._onData.fire).toHaveBeenCalledWith('\x02')
    vi.runAllTimers()
    expect(term._core._onData.fire).toHaveBeenCalledWith('[')
    expect(isInCopyMode()).toBe(true)
  })

  it('does nothing when iframe is null', () => {
    enterTmuxCopyMode(null) // should not throw
    vi.runAllTimers()
  })
})

describe('exitTmuxCopyMode', () => {
  beforeEach(() => {
    resetCopyModeState()
  })

  it('sends q and clears copy mode state', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    exitTmuxCopyMode(iframe)
    expect(term._core._onData.fire).toHaveBeenCalledWith('q')
    expect(isInCopyMode()).toBe(false)
  })

  it('does nothing when iframe is null', () => {
    exitTmuxCopyMode(null) // should not throw
  })
})

describe('pasteTmuxBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('sends Ctrl+b then ] after timeout', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    pasteTmuxBuffer(iframe)
    expect(term._core._onData.fire).toHaveBeenCalledWith('\x02')
    vi.runAllTimers()
    expect(term._core._onData.fire).toHaveBeenCalledWith(']')
  })

  it('does nothing when iframe is null', () => {
    pasteTmuxBuffer(null) // should not throw
    vi.runAllTimers()
  })
})

describe('focusTerminal', () => {
  it('calls term.focus()', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    focusTerminal(iframe)
    expect(term.focus).toHaveBeenCalled()
  })

  it('does nothing when iframe is null', () => {
    focusTerminal(null) // should not throw
  })
})

describe('blurTerminal', () => {
  it('blurs the active element in iframe document', () => {
    const iframe = createMockIframe(createMockTerm())
    const doc = iframe.contentDocument!
    const input = doc.createElement('input')
    doc.body.appendChild(input)
    input.focus()
    const blurSpy = vi.spyOn(input, 'blur')
    // Override activeElement to return input
    Object.defineProperty(doc, 'activeElement', {
      get: () => input,
      configurable: true,
    })
    blurTerminal(iframe)
    expect(blurSpy).toHaveBeenCalled()
  })

  it('does nothing when iframe is null', () => {
    blurTerminal(null) // should not throw
  })

  it('silently catches cross-origin errors', () => {
    const iframe = document.createElement('iframe')
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        throw new Error('cross-origin')
      },
      configurable: true,
    })
    expect(() => blurTerminal(iframe)).not.toThrow()
  })
})

describe('pasteToTerminal', () => {
  beforeEach(() => {
    // Reset clipboard mock
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn() },
      writable: true,
      configurable: true,
    })
  })

  it('returns no-terminal when iframe is null', async () => {
    const result = await pasteToTerminal(null)
    expect(result).toEqual({ ok: false, reason: 'no-terminal' })
  })

  it('returns no-terminal when term is null', async () => {
    const iframe = createMockIframe(null)
    const result = await pasteToTerminal(iframe)
    expect(result).toEqual({ ok: false, reason: 'no-terminal' })
  })

  it('returns not-supported when clipboard API is absent', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    const iframe = createMockIframe(createMockTerm())
    const result = await pasteToTerminal(iframe)
    expect(result).toEqual({ ok: false, reason: 'not-supported' })
  })

  it('returns not-supported when clipboard.readText is absent', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {},
      writable: true,
      configurable: true,
    })
    const iframe = createMockIframe(createMockTerm())
    const result = await pasteToTerminal(iframe)
    expect(result).toEqual({ ok: false, reason: 'not-supported' })
  })

  it('sends text and returns ok on success', async () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    ;(
      navigator.clipboard.readText as ReturnType<typeof vi.fn>
    ).mockResolvedValue('hello')
    const result = await pasteToTerminal(iframe)
    expect(result).toEqual({ ok: true })
    expect(term._core._onData.fire).toHaveBeenCalledWith('hello')
  })

  it('returns empty when clipboard text is empty', async () => {
    const iframe = createMockIframe(createMockTerm())
    ;(
      navigator.clipboard.readText as ReturnType<typeof vi.fn>
    ).mockResolvedValue('')
    const result = await pasteToTerminal(iframe)
    expect(result).toEqual({ ok: false, reason: 'empty' })
  })

  it('returns not-allowed on NotAllowedError', async () => {
    const iframe = createMockIframe(createMockTerm())
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    ;(
      navigator.clipboard.readText as ReturnType<typeof vi.fn>
    ).mockRejectedValue(err)
    const result = await pasteToTerminal(iframe)
    expect(result).toEqual({ ok: false, reason: 'not-allowed' })
  })

  it('returns not-secure on SecurityError', async () => {
    const iframe = createMockIframe(createMockTerm())
    const err = Object.assign(new Error('security'), { name: 'SecurityError' })
    ;(
      navigator.clipboard.readText as ReturnType<typeof vi.fn>
    ).mockRejectedValue(err)
    const result = await pasteToTerminal(iframe)
    expect(result).toEqual({ ok: false, reason: 'not-secure' })
  })

  it('returns not-supported on TypeError (with isSecureContext=true)', async () => {
    const iframe = createMockIframe(createMockTerm())
    const err = Object.assign(new Error('type'), { name: 'TypeError' })
    ;(
      navigator.clipboard.readText as ReturnType<typeof vi.fn>
    ).mockRejectedValue(err)
    // jsdom defaults isSecureContext=false which triggers not-secure; override to true
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      configurable: true,
    })
    const result = await pasteToTerminal(iframe)
    Object.defineProperty(window, 'isSecureContext', {
      value: false,
      configurable: true,
    })
    expect(result).toEqual({ ok: false, reason: 'not-supported' })
  })

  it('returns unknown for unrecognised errors (with isSecureContext=true)', async () => {
    const iframe = createMockIframe(createMockTerm())
    const err = Object.assign(new Error('something'), { name: 'UnknownError' })
    ;(
      navigator.clipboard.readText as ReturnType<typeof vi.fn>
    ).mockRejectedValue(err)
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      configurable: true,
    })
    const result = await pasteToTerminal(iframe)
    Object.defineProperty(window, 'isSecureContext', {
      value: false,
      configurable: true,
    })
    expect(result).toEqual({ ok: false, reason: 'unknown' })
  })
})

describe('sendData via coreService fallback', () => {
  it('uses coreService.triggerDataEvent when _onData.fire is absent', () => {
    const triggerDataEvent = vi.fn()
    const term = createMockTerm({
      _core: {
        _onData: undefined,
        coreService: { triggerDataEvent },
        _renderService: {
          _renderer: { clearTextureAtlas: vi.fn() },
          refreshRows: vi.fn(),
        },
      },
    })
    const iframe = createMockIframe(term)
    sendKeyToTerminal(iframe, 'a')
    expect(triggerDataEvent).toHaveBeenCalledWith('a', true)
  })

  it('does nothing when neither _onData nor coreService is available (false branch of line 77)', () => {
    const term = createMockTerm({
      _core: {
        _onData: undefined,
        coreService: undefined,
        _renderService: {
          _renderer: { clearTextureAtlas: vi.fn() },
          refreshRows: vi.fn(),
        },
      },
    })
    const iframe = createMockIframe(term)
    expect(() => sendKeyToTerminal(iframe, 'a')).not.toThrow()
  })
})

describe('sendKeyToTerminal — additional branches', () => {
  it('sends plain key with no modifier using mapped base', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendKeyToTerminal(iframe, 'Tab')
    expect(term._core._onData.fire).toHaveBeenCalledWith('\t')
  })

  it('sends plain key with no mapping as literal', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    sendKeyToTerminal(iframe, 'z')
    expect(term._core._onData.fire).toHaveBeenCalledWith('z')
  })

  it('sends Ctrl+ArrowUp using CSI modifier encoding', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    // ctrl=true → modifier = 1+4 = 5
    sendKeyToTerminal(iframe, 'ArrowUp', { ctrl: true })
    expect(term._core._onData.fire).toHaveBeenCalledWith('\x1b[1;5A')
  })
})

describe('setTerminalTheme — additional branches', () => {
  it('uses setOption API when options is absent', () => {
    const setOption = vi.fn()
    const term = createMockTerm({ options: undefined, setOption })
    const iframe = createMockIframe(term)
    const result = setTerminalTheme(iframe, { background: '#111' })
    expect(result).toBe(true)
    expect(setOption).toHaveBeenCalledWith('theme', { background: '#111' })
  })

  it('calls _renderService.refreshRows after applying theme', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    setTerminalTheme(iframe, { background: '#222' })
    expect(term._core._renderService.refreshRows).toHaveBeenCalledWith(0, 23)
  })

  it('calls _core._renderService._renderer.clearTextureAtlas after applying theme', () => {
    const term = createMockTerm()
    const iframe = createMockIframe(term)
    setTerminalTheme(iframe, { background: '#333' })
    expect(
      term._core._renderService._renderer.clearTextureAtlas,
    ).toHaveBeenCalled()
  })

  it('skips clearTextureAtlas when term does not have it', () => {
    const term = createMockTerm({ clearTextureAtlas: undefined })
    const iframe = createMockIframe(term)
    expect(() => setTerminalTheme(iframe, { background: '#444' })).not.toThrow()
  })

  it('skips refresh when term.refresh is absent', () => {
    const term = createMockTerm({ refresh: undefined })
    const iframe = createMockIframe(term)
    expect(() => setTerminalTheme(iframe, { background: '#555' })).not.toThrow()
  })

  it('skips refresh when term.rows is 0 (falsy)', () => {
    const term = createMockTerm({ rows: 0 })
    const iframe = createMockIframe(term)
    expect(() => setTerminalTheme(iframe, { background: '#666' })).not.toThrow()
  })

  it('skips _renderService.refreshRows when _renderService absent', () => {
    const term = createMockTerm({
      _core: {
        _onData: { fire: vi.fn() },
        _renderService: undefined,
      },
    })
    const iframe = createMockIframe(term)
    expect(() => setTerminalTheme(iframe, { background: '#777' })).not.toThrow()
  })

  it('handles theme applied=false path (no options, no setOption): skips redraw block', () => {
    const term = createMockTerm({ options: undefined, setOption: undefined })
    const iframe = createMockIframe(term)
    const result = setTerminalTheme(iframe, { background: '#888' })
    expect(result).toBe(false)
  })
})

describe('scrollTerminal — catch block coverage', () => {
  it('silently catches cross-origin errors in viewport fallback', () => {
    // term with no scrollLines/scrollPages to force the viewport fallback
    const term = createMockTerm({
      scrollLines: undefined,
      scrollPages: undefined,
    })
    const iframe = document.createElement('iframe')
    Object.defineProperty(iframe, 'contentWindow', {
      value: { term },
      writable: true,
    })
    // Make contentDocument throw to hit the catch block (line 264)
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        throw new Error('cross-origin')
      },
      configurable: true,
    })
    expect(() => scrollTerminal(iframe, 'down')).not.toThrow()
  })
})

describe('blockContextMenu — catch block coverage', () => {
  it('returns false when contentDocument throws', () => {
    const iframe = document.createElement('iframe')
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        throw new Error('cross-origin')
      },
      configurable: true,
    })
    expect(blockContextMenu(iframe)).toBe(false)
  })
})

describe('unblockContextMenu — catch block coverage', () => {
  it('returns false when contentDocument throws', () => {
    const iframe = document.createElement('iframe')
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        throw new Error('cross-origin')
      },
      configurable: true,
    })
    expect(unblockContextMenu(iframe)).toBe(false)
  })
})
