import { describe, expect, it, vi } from 'vitest'
import type { TerminalHandle } from '../components/terminal-view'
import {
  bracketPaste,
  fitFontSize,
  stripTerminalReplies,
} from '../components/terminal-view'
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
  scrollTerminalHorizontal,
  scrollTerminalViewport,
  scrollTmux,
  sendCommandToTerminal,
  sendKeyToTerminal,
  sendTextToTerminal,
  setTerminalFontFamily,
  setTerminalFontSize,
  setTerminalTheme,
  toggleTmuxCopyMode,
  unblockContextMenu,
} from './terminal-bridge'

function createMockTerminal() {
  return {
    focus: vi.fn(),
    blur: vi.fn(),
    write: vi.fn(),
    paste: vi.fn(),
    scrollLines: vi.fn(),
    scrollPages: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
    resize: vi.fn(),
    rows: 24,
    options: { fontSize: 14, theme: {} },
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onBinary: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
  } as any
}

function createMockHandle(
  overrides: Partial<TerminalHandle> = {},
): TerminalHandle {
  return {
    term: createMockTerminal(),
    element: document.createElement('div'),
    scroller: null,
    connectionState: 'connected',
    copyModeSupported: true,
    copyMode: false,
    scrollHistory: vi.fn(() => false),
    send: vi.fn(() => true),
    paste: vi.fn(),
    reconnect: vi.fn(),
    ...overrides,
  }
}

describe('stripTerminalReplies', () => {
  it('strips device attributes (CSI ? … c)', () => {
    const data = 'hello\x1b[?1;2creply\x1b[?1;2cmore'
    const stripped = stripTerminalReplies(data)
    expect(stripped).toBe('helloreplymore')
  })

  it('strips cursor position reports (CSI row;col R)', () => {
    const data = 'text\x1b[10;20Rmore'
    const stripped = stripTerminalReplies(data)
    expect(stripped).toBe('textmore')
  })

  it('strips focus reports (CSI I and CSI O)', () => {
    const data = 'start\x1b[Imiddle\x1b[Oend'
    const stripped = stripTerminalReplies(data)
    expect(stripped).toBe('startmiddleend')
  })

  it('preserves normal text', () => {
    const data = 'hello world'
    expect(stripTerminalReplies(data)).toBe('hello world')
  })

  it('handles CSI > code variant', () => {
    const data = 'a\x1b[>0;276;0cb'
    expect(stripTerminalReplies(data)).toBe('ab')
  })
})

describe('bracketPaste', () => {
  it('wraps text with paste markers', () => {
    const result = bracketPaste('hello')
    expect(result).toBe('\x1b[200~hello\x1b[201~')
  })

  it('removes embedded paste end markers', () => {
    const result = bracketPaste('hello\x1b[201~world')
    expect(result).toBe('\x1b[200~helloworld\x1b[201~')
  })

  it('handles empty string', () => {
    expect(bracketPaste('')).toBe('\x1b[200~\x1b[201~')
  })
})

describe('fitFontSize', () => {
  it('returns original fontSize when no size constraint', () => {
    const result = fitFontSize(14, undefined, { cols: 80, rows: 24 })
    expect(result).toBe(14)
  })

  it('scales down to fit available space', () => {
    const result = fitFontSize(
      14,
      { cols: 40, rows: 12 },
      { cols: 80, rows: 24 },
    )
    expect(result).toBeLessThan(14)
  })

  it('never scales below minimum font size', () => {
    const result = fitFontSize(14, { cols: 5, rows: 5 }, { cols: 80, rows: 24 })
    expect(result).toBeGreaterThanOrEqual(6)
  })

  it('respects the minimum when severely constrained', () => {
    const result = fitFontSize(14, { cols: 1, rows: 1 }, { cols: 80, rows: 24 })
    expect(result).toBe(6)
  })
})

describe('sendKeyToTerminal', () => {
  it('sends plain character', () => {
    const handle = createMockHandle()
    sendKeyToTerminal(handle, 'a')
    expect(handle.send).toHaveBeenCalledWith('a')
  })

  it('sends Enter as carriage return', () => {
    const handle = createMockHandle()
    sendKeyToTerminal(handle, 'Enter')
    expect(handle.send).toHaveBeenCalledWith('\r')
  })

  it('sends Escape sequence', () => {
    const handle = createMockHandle()
    sendKeyToTerminal(handle, 'Escape')
    expect(handle.send).toHaveBeenCalledWith('\x1b')
  })

  it('sends Ctrl+C as control character', () => {
    const handle = createMockHandle()
    sendKeyToTerminal(handle, 'c', { ctrl: true })
    expect(handle.send).toHaveBeenCalledWith('\x03')
  })

  it('sends Ctrl+U as control character', () => {
    const handle = createMockHandle()
    sendKeyToTerminal(handle, 'u', { ctrl: true })
    expect(handle.send).toHaveBeenCalledWith('\x15')
  })

  it('sends Shift+Tab as backtab', () => {
    const handle = createMockHandle()
    sendKeyToTerminal(handle, 'Tab', { shift: true })
    expect(handle.send).toHaveBeenCalledWith('\x1b[Z')
  })

  it('sends ArrowUp with modifiers using CSI encoding', () => {
    const handle = createMockHandle()
    sendKeyToTerminal(handle, 'ArrowUp', { shift: true })
    expect(handle.send).toHaveBeenCalledWith('\x1b[1;2A')
  })

  it('sends ArrowDown with Ctrl modifier', () => {
    const handle = createMockHandle()
    sendKeyToTerminal(handle, 'ArrowDown', { ctrl: true })
    expect(handle.send).toHaveBeenCalledWith('\x1b[1;5B')
  })

  it('sends Shift+letter as uppercase', () => {
    const handle = createMockHandle()
    sendKeyToTerminal(handle, 'a', { shift: true })
    expect(handle.send).toHaveBeenCalledWith('A')
  })

  it('sends unmodified Tab as tab character', () => {
    const handle = createMockHandle()
    sendKeyToTerminal(handle, 'Tab')
    expect(handle.send).toHaveBeenCalledWith('\t')
  })

  it('does nothing when handle is null', () => {
    const mockSend = vi.fn()
    sendKeyToTerminal(null, 'a')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('does nothing when handle has no term', () => {
    const handle = createMockHandle({ term: null })
    sendKeyToTerminal(handle, 'a')
    expect(handle.send).not.toHaveBeenCalled()
  })
})

describe('focusTerminal', () => {
  it('calls focus on terminal', () => {
    const handle = createMockHandle()
    focusTerminal(handle)
    expect(handle.term?.focus).toHaveBeenCalled()
  })

  it('handles null handle gracefully', () => {
    expect(() => focusTerminal(null)).not.toThrow()
  })

  it('handles null term gracefully', () => {
    const handle = createMockHandle({ term: null })
    expect(() => focusTerminal(handle)).not.toThrow()
  })
})

describe('blurTerminal', () => {
  it('calls blur on terminal', () => {
    const handle = createMockHandle()
    blurTerminal(handle)
    expect(handle.term?.blur).toHaveBeenCalled()
  })

  it('handles null handle gracefully', () => {
    expect(() => blurTerminal(null)).not.toThrow()
  })

  it('handles null term gracefully', () => {
    const handle = createMockHandle({ term: null })
    expect(() => blurTerminal(handle)).not.toThrow()
  })
})

describe('isTerminalDisconnected', () => {
  it('returns false for connected state', () => {
    const handle = createMockHandle({ connectionState: 'connected' })
    expect(isTerminalDisconnected(handle)).toBe(false)
  })

  it('returns true for disconnected state', () => {
    const handle = createMockHandle({ connectionState: 'disconnected' })
    expect(isTerminalDisconnected(handle)).toBe(true)
  })

  it('returns true for error state', () => {
    const handle = createMockHandle({ connectionState: 'error' })
    expect(isTerminalDisconnected(handle)).toBe(true)
  })

  it('returns false for connecting state', () => {
    const handle = createMockHandle({ connectionState: 'connecting' })
    expect(isTerminalDisconnected(handle)).toBe(false)
  })

  it('returns false when handle is null', () => {
    expect(isTerminalDisconnected(null)).toBe(false)
  })
})

describe('scrollTerminal', () => {
  it('scrolls lines down', () => {
    const handle = createMockHandle()
    scrollTerminal(handle, 'down')
    expect(handle.term?.scrollLines).toHaveBeenCalledWith(5)
  })

  it('scrolls lines up', () => {
    const handle = createMockHandle()
    scrollTerminal(handle, 'up')
    expect(handle.term?.scrollLines).toHaveBeenCalledWith(-5)
  })

  it('scrolls pages when pages=true', () => {
    const handle = createMockHandle()
    scrollTerminal(handle, 'down', true)
    expect(handle.term?.scrollPages).toHaveBeenCalledWith(1)
  })

  it('scrolls pages up when pages=true', () => {
    const handle = createMockHandle()
    scrollTerminal(handle, 'up', true)
    expect(handle.term?.scrollPages).toHaveBeenCalledWith(-1)
  })

  it('scrolls the backend history instead when it offers it', () => {
    const scrollHistory = vi.fn(() => true)
    const handle = createMockHandle({ scrollHistory })
    scrollTerminal(handle, 'up')
    expect(scrollHistory).toHaveBeenLastCalledWith(5)
    scrollTerminal(handle, 'down', true)
    expect(scrollHistory).toHaveBeenLastCalledWith(-24)
    expect(handle.term?.scrollLines).not.toHaveBeenCalled()
    expect(handle.term?.scrollPages).not.toHaveBeenCalled()
  })

  it('handles null handle gracefully with warning', () => {
    const warnSpy = vi.spyOn(console, 'warn')
    scrollTerminal(null, 'down')
    expect(warnSpy).toHaveBeenCalledWith(
      '[terminal-bridge] scrollTerminal: term not found',
    )
    warnSpy.mockRestore()
  })

  it('handles null term gracefully', () => {
    const handle = createMockHandle({ term: null })
    const warnSpy = vi.spyOn(console, 'warn')
    scrollTerminal(handle, 'down')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('isInCopyMode', () => {
  it('returns true when in copy mode', () => {
    const handle = createMockHandle({ copyMode: true })
    expect(isInCopyMode(handle)).toBe(true)
  })

  it('returns false when not in copy mode', () => {
    const handle = createMockHandle({ copyMode: false })
    expect(isInCopyMode(handle)).toBe(false)
  })

  it('returns false when handle is null', () => {
    expect(isInCopyMode(null)).toBe(false)
  })
})

describe('toggleTmuxCopyMode', () => {
  it('enters copy mode when not in it', () => {
    const handle = createMockHandle({ copyMode: false })
    vi.useFakeTimers()

    const result = toggleTmuxCopyMode(handle)

    expect(handle.send).toHaveBeenCalledWith('\x02')
    vi.advanceTimersByTime(50)
    expect(handle.send).toHaveBeenCalledWith('[')
    expect(handle.copyMode).toBe(true)
    expect(result).toBe(true)

    vi.useRealTimers()
  })

  it('exits copy mode when in it', () => {
    const handle = createMockHandle({ copyMode: true })
    const result = toggleTmuxCopyMode(handle)

    expect(handle.send).toHaveBeenCalledWith('q')
    expect(handle.copyMode).toBe(false)
    expect(result).toBe(false)
  })

  it('handles null handle gracefully', () => {
    const result = toggleTmuxCopyMode(null)
    expect(result).toBe(false)
  })
})

describe('enterTmuxCopyMode', () => {
  it('sends copy mode sequence with delay', () => {
    const handle = createMockHandle({ copyModeSupported: true })
    vi.useFakeTimers()

    enterTmuxCopyMode(handle)

    expect(handle.send).toHaveBeenCalledWith('\x02')
    expect(handle.copyMode).toBe(true)

    vi.advanceTimersByTime(50)
    expect(handle.send).toHaveBeenNthCalledWith(2, '[')

    vi.useRealTimers()
  })

  it('is a no-op when copyModeSupported is false', () => {
    const handle = createMockHandle({ copyModeSupported: false })
    enterTmuxCopyMode(handle)

    expect(handle.send).not.toHaveBeenCalled()
  })

  it('handles null handle gracefully', () => {
    expect(() => enterTmuxCopyMode(null)).not.toThrow()
  })
})

describe('exitTmuxCopyMode', () => {
  it('sends exit sequence', () => {
    const handle = createMockHandle()
    exitTmuxCopyMode(handle)

    expect(handle.send).toHaveBeenCalledWith('q')
    expect(handle.copyMode).toBe(false)
  })

  it('handles null handle gracefully', () => {
    expect(() => exitTmuxCopyMode(null)).not.toThrow()
  })

  it('handles null term gracefully', () => {
    const handle = createMockHandle({ term: null })
    expect(() => exitTmuxCopyMode(handle)).not.toThrow()
  })
})

describe('scrollTerminalViewport', () => {
  it('scrolls up', () => {
    const handle = createMockHandle()
    scrollTerminalViewport(handle, 'up')
    expect(handle.term?.scrollLines).toHaveBeenCalledWith(-5)
  })

  it('scrolls down', () => {
    const handle = createMockHandle()
    scrollTerminalViewport(handle, 'down')
    expect(handle.term?.scrollLines).toHaveBeenCalledWith(5)
  })

  it('handles null handle gracefully', () => {
    expect(() => scrollTerminalViewport(null, 'up')).not.toThrow()
  })
})

describe('scrollTmux', () => {
  it('sends PageUp key for up direction', () => {
    const handle = createMockHandle()
    scrollTmux(handle, 'up')
    expect(handle.send).toHaveBeenCalledWith('\x1b[5~')
  })

  it('sends PageDown key for down direction', () => {
    const handle = createMockHandle()
    scrollTmux(handle, 'down')
    expect(handle.send).toHaveBeenCalledWith('\x1b[6~')
  })

  it('handles null handle gracefully', () => {
    expect(() => scrollTmux(null, 'up')).not.toThrow()
  })

  it('handles null term gracefully', () => {
    const handle = createMockHandle({ term: null })
    expect(() => scrollTmux(handle, 'up')).not.toThrow()
  })
})

describe('pasteTmuxBuffer', () => {
  it('sends paste sequence with delay', () => {
    const handle = createMockHandle({ copyModeSupported: true })
    vi.useFakeTimers()

    pasteTmuxBuffer(handle)

    expect(handle.send).toHaveBeenCalledWith('\x02')
    vi.advanceTimersByTime(50)
    expect(handle.send).toHaveBeenNthCalledWith(2, ']')

    vi.useRealTimers()
  })

  it('is a no-op when copyModeSupported is false', () => {
    const handle = createMockHandle({ copyModeSupported: false })
    pasteTmuxBuffer(handle)

    expect(handle.send).not.toHaveBeenCalled()
  })

  it('handles null handle gracefully', () => {
    expect(() => pasteTmuxBuffer(null)).not.toThrow()
  })
})

describe('resetCopyModeState', () => {
  it('resets copy mode flag', () => {
    const handle = createMockHandle({ copyMode: true })
    resetCopyModeState(handle)
    expect(handle.copyMode).toBe(false)
  })

  it('handles null gracefully', () => {
    expect(() => resetCopyModeState(null)).not.toThrow()
  })
})

describe('sendCommandToTerminal', () => {
  it('sends command followed by Enter', () => {
    const handle = createMockHandle()
    sendCommandToTerminal(handle, 'ls')
    expect(handle.send).toHaveBeenCalledWith('ls\r')
  })

  it('handles null handle gracefully', () => {
    expect(() => sendCommandToTerminal(null, 'ls')).not.toThrow()
  })

  it('handles null term gracefully', () => {
    const handle = createMockHandle({ term: null })
    expect(() => sendCommandToTerminal(handle, 'ls')).not.toThrow()
  })
})

describe('sendTextToTerminal', () => {
  it('sends text without newline', () => {
    const handle = createMockHandle()
    sendTextToTerminal(handle, 'hello')
    expect(handle.send).toHaveBeenCalledWith('hello')
  })

  it('does nothing for empty text', () => {
    const handle = createMockHandle()
    sendTextToTerminal(handle, '')
    expect(handle.send).not.toHaveBeenCalled()
  })

  it('handles null handle gracefully', () => {
    expect(() => sendTextToTerminal(null, 'text')).not.toThrow()
  })

  it('handles null term gracefully', () => {
    const handle = createMockHandle({ term: null })
    expect(() => sendTextToTerminal(handle, 'text')).not.toThrow()
  })
})

describe('pasteToTerminal', () => {
  it('returns error when no terminal', async () => {
    const result = await pasteToTerminal(null)
    expect(result).toEqual({ ok: false, reason: 'no-terminal' })
  })

  it('returns error when term is null', async () => {
    const handle = createMockHandle({ term: null })
    const result = await pasteToTerminal(handle)
    expect(result).toEqual({ ok: false, reason: 'no-terminal' })
  })

  it('returns error when clipboard API not supported', async () => {
    const handle = createMockHandle()
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
    })

    const result = await pasteToTerminal(handle)
    expect(result).toEqual({ ok: false, reason: 'not-supported' })
  })

  it('succeeds with clipboard text', async () => {
    const handle = createMockHandle()
    const mockReadText = vi.fn().mockResolvedValue('hello')
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: mockReadText },
      writable: true,
    })

    const result = await pasteToTerminal(handle)
    expect(result).toEqual({ ok: true })
    expect(handle.paste).toHaveBeenCalledWith('hello')
  })

  it('returns error when clipboard is empty', async () => {
    const handle = createMockHandle()
    const mockReadText = vi.fn().mockResolvedValue('')
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: mockReadText },
      writable: true,
    })

    const result = await pasteToTerminal(handle)
    expect(result).toEqual({ ok: false, reason: 'empty' })
  })

  it('returns not-allowed error', async () => {
    const handle = createMockHandle()
    const mockReadText = vi
      .fn()
      .mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: mockReadText },
      writable: true,
    })

    const result = await pasteToTerminal(handle)
    expect(result).toEqual({ ok: false, reason: 'not-allowed' })
  })

  it('returns not-secure error', async () => {
    const handle = createMockHandle()
    const mockReadText = vi
      .fn()
      .mockRejectedValue(new DOMException('security', 'SecurityError'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: mockReadText },
      writable: true,
    })

    const result = await pasteToTerminal(handle)
    expect(result).toEqual({ ok: false, reason: 'not-secure' })
  })

  it('returns not-supported error for TypeError', async () => {
    const handle = createMockHandle()
    const mockReadText = vi
      .fn()
      .mockRejectedValue(new TypeError('not supported'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: mockReadText },
      writable: true,
    })
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      writable: true,
    })

    const result = await pasteToTerminal(handle)
    expect(result).toEqual({ ok: false, reason: 'not-supported' })
  })

  it('returns unknown error for unexpected errors', async () => {
    const handle = createMockHandle()
    const mockReadText = vi.fn().mockRejectedValue(new Error('unexpected'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: mockReadText },
      writable: true,
    })
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      writable: true,
    })

    const result = await pasteToTerminal(handle)
    expect(result).toEqual({ ok: false, reason: 'unknown' })
  })
})

describe('setTerminalFontSize', () => {
  it('sets font size on terminal', () => {
    const handle = createMockHandle()
    setTerminalFontSize(handle, 16)
    expect(handle.term?.options.fontSize).toBe(16)
  })

  it('handles null handle gracefully', () => {
    expect(() => setTerminalFontSize(null, 16)).not.toThrow()
  })

  it('handles null term gracefully', () => {
    const handle = createMockHandle({ term: null })
    expect(() => setTerminalFontSize(handle, 16)).not.toThrow()
  })
})

describe('setTerminalFontFamily', () => {
  it('sets font family on terminal', () => {
    const handle = createMockHandle()
    setTerminalFontFamily(handle, 'Hack, monospace')
    expect(handle.term?.options.fontFamily).toBe('Hack, monospace')
  })

  it('handles null handle gracefully', () => {
    expect(() => setTerminalFontFamily(null, 'Hack')).not.toThrow()
  })
})

describe('setTerminalTheme', () => {
  it('sets theme on terminal', () => {
    const handle = createMockHandle()
    const theme = { background: '#000', foreground: '#fff' }
    const result = setTerminalTheme(handle, theme)
    expect(handle.term?.options.theme).toEqual(theme)
    expect(result).toBe(true)
  })

  it('returns false when no terminal', () => {
    const handle = createMockHandle({ term: null })
    const result = setTerminalTheme(handle, {})
    expect(result).toBe(false)
  })

  it('returns false when handle is null', () => {
    const result = setTerminalTheme(null, {})
    expect(result).toBe(false)
  })
})

describe('isTerminalReady', () => {
  it('returns true when terminal exists', () => {
    const handle = createMockHandle()
    expect(isTerminalReady(handle)).toBe(true)
  })

  it('returns false when term is null', () => {
    const handle = createMockHandle({ term: null })
    expect(isTerminalReady(handle)).toBe(false)
  })

  it('returns false when handle is null', () => {
    expect(isTerminalReady(null)).toBe(false)
  })
})

describe('blockContextMenu', () => {
  it('adds context menu handler to element', () => {
    const el = document.createElement('div')
    const handle = createMockHandle({ element: el })

    const result = blockContextMenu(handle)

    expect(result).toBe(true)
    const event = new Event('contextmenu')
    const preventSpy = vi.spyOn(event, 'preventDefault')
    el.dispatchEvent(event)
    expect(preventSpy).toHaveBeenCalled()
  })

  it('returns false when no element', () => {
    const handle = createMockHandle({ element: null })
    const result = blockContextMenu(handle)
    expect(result).toBe(false)
  })

  it('returns false when handle is null', () => {
    const result = blockContextMenu(null)
    expect(result).toBe(false)
  })

  it('returns true if already blocked', () => {
    const el = document.createElement('div')
    const handle = createMockHandle({ element: el })

    blockContextMenu(handle)
    const result = blockContextMenu(handle)

    expect(result).toBe(true)
  })
})

describe('unblockContextMenu', () => {
  it('removes context menu handler from element', () => {
    const el = document.createElement('div')
    const handle = createMockHandle({ element: el })

    blockContextMenu(handle)
    const result = unblockContextMenu(handle)

    expect(result).toBe(true)
    const event = new Event('contextmenu')
    const preventSpy = vi.spyOn(event, 'preventDefault')
    el.dispatchEvent(event)
    expect(preventSpy).not.toHaveBeenCalled()
  })

  it('returns true if not previously blocked', () => {
    const el = document.createElement('div')
    const handle = createMockHandle({ element: el })
    const result = unblockContextMenu(handle)
    expect(result).toBe(true)
  })

  it('returns false when no element', () => {
    const handle = createMockHandle({ element: null })
    const result = unblockContextMenu(handle)
    expect(result).toBe(false)
  })

  it('returns false when handle is null', () => {
    const result = unblockContextMenu(null)
    expect(result).toBe(false)
  })
})

describe('scrollTerminalHorizontal', () => {
  function scroller(scrollWidth: number, clientWidth: number) {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollWidth', { value: scrollWidth })
    Object.defineProperty(el, 'clientWidth', { value: clientWidth })
    el.scrollBy = vi.fn()
    return el
  }

  it('scrolls a wider pane by 80% of the screen width', () => {
    const el = scroller(550, 360)
    const handle = createMockHandle({ scroller: el })
    expect(scrollTerminalHorizontal(handle, 'right')).toBe(true)
    expect(el.scrollBy).toHaveBeenLastCalledWith({
      left: 288,
      behavior: 'smooth',
    })
    expect(scrollTerminalHorizontal(handle, 'left')).toBe(true)
    expect(el.scrollBy).toHaveBeenLastCalledWith({
      left: -288,
      behavior: 'smooth',
    })
  })

  it('reports false when nothing overflows or there is no terminal', () => {
    const el = scroller(360, 360)
    expect(
      scrollTerminalHorizontal(createMockHandle({ scroller: el }), 'right'),
    ).toBe(false)
    expect(el.scrollBy).not.toHaveBeenCalled()
    expect(scrollTerminalHorizontal(createMockHandle(), 'left')).toBe(false)
    expect(scrollTerminalHorizontal(null, 'left')).toBe(false)
  })
})
