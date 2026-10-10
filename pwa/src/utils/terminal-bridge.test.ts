import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalHandle } from '../components/terminal-view'
import {
  bracketPaste,
  fitFontSize,
  stripTerminalReplies,
} from '../components/terminal-view'
import {
  attachImageToTerminal,
  blockContextMenu,
  blurTerminal,
  copyTerminalSelection,
  dragTerminal,
  enterTmuxCopyMode,
  exitTmuxCopyMode,
  focusTerminal,
  isApplePlatform,
  isCopyShortcut,
  isInCopyMode,
  isTerminalDisconnected,
  isTerminalReady,
  overflowsHorizontally,
  pasteTmuxBuffer,
  pasteToTerminal,
  readTerminalBufferText,
  resetCopyModeState,
  scrollTerminal,
  scrollTerminalViewport,
  scrollTmux,
  sendCommandToTerminal,
  sendKeyToTerminal,
  sendTextToTerminal,
  setTerminalFontFamily,
  setTerminalFontSize,
  setTerminalTheme,
  terminalSelection,
  toggleTmuxCopyMode,
  unblockContextMenu,
} from './terminal-bridge'

const mockCopyText = vi.hoisted(() => vi.fn(async (_t: string) => 'ok'))
vi.mock('./copy-text', () => ({ copyText: mockCopyText }))

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

describe('pasteToTerminal with images', () => {
  const image = new Blob(['img'], { type: 'image/png' })
  const item = (parts: Record<string, Blob>) => ({
    types: Object.keys(parts),
    getType: vi.fn(async (t: string) => parts[t]),
  })
  function stubClipboard(clipboard: Partial<Clipboard>) {
    Object.defineProperty(navigator, 'clipboard', {
      value: clipboard,
      writable: true,
    })
  }

  it('returns an image-only clipboard instead of pasting it', async () => {
    const handle = createMockHandle()
    const readText = vi.fn()
    stubClipboard({
      readText,
      read: vi.fn(async () => [item({ 'image/png': image })]),
    } as unknown as Clipboard)
    expect(await pasteToTerminal(handle, { images: true })).toEqual({
      ok: true,
      image,
    })
    expect(handle.paste).not.toHaveBeenCalled()
    expect(readText).not.toHaveBeenCalled()
  })

  it('pastes the text when the clipboard holds an image and text', async () => {
    const handle = createMockHandle()
    stubClipboard({
      readText: vi.fn(),
      read: vi.fn(async () => [
        item({ 'image/png': image }),
        item({ 'text/plain': new Blob(['caption']) }),
      ]),
    } as unknown as Clipboard)
    expect(await pasteToTerminal(handle, { images: true })).toEqual({
      ok: true,
    })
    expect(handle.paste).toHaveBeenCalledWith('caption')
  })

  it('reports an empty clipboard read through read()', async () => {
    const handle = createMockHandle()
    stubClipboard({
      readText: vi.fn(),
      read: vi.fn(async () => [item({ 'text/html': new Blob(['<b>']) })]),
    } as unknown as Clipboard)
    expect(await pasteToTerminal(handle, { images: true })).toEqual({
      ok: false,
      reason: 'empty',
    })
  })

  it('falls back to readText when read() fails or is missing', async () => {
    const handle = createMockHandle()
    stubClipboard({
      readText: vi.fn(async () => 'text'),
      read: vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError')
      }),
    } as unknown as Clipboard)
    expect(await pasteToTerminal(handle, { images: true })).toEqual({
      ok: true,
    })
    expect(handle.paste).toHaveBeenCalledWith('text')

    stubClipboard({ readText: vi.fn(async () => 'plain') })
    await pasteToTerminal(handle, { images: true })
    expect(handle.paste).toHaveBeenLastCalledWith('plain')
  })

  it('never calls read() without images', async () => {
    const handle = createMockHandle()
    const read = vi.fn()
    stubClipboard({
      readText: vi.fn(async () => 'text'),
      read,
    } as unknown as Clipboard)
    await pasteToTerminal(handle)
    expect(read).not.toHaveBeenCalled()
  })
})

describe('attachImageToTerminal', () => {
  const image = new Blob(['img'], { type: 'image/png' })
  const upload = {
    id: 'a'.repeat(32),
    path: '/c/a b.png',
    insert: '"/c/a b.png"',
  }
  function stubUpload(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    )
  }
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('types the path and a space into the pane it was picked for', async () => {
    stubUpload(200, upload)
    const handle = createMockHandle({ paste: vi.fn(() => true) })
    expect(
      await attachImageToTerminal(handle, image, '%1', () => '%1'),
    ).toEqual({ status: 'inserted' })
    expect(handle.paste).toHaveBeenCalledWith('"/c/a b.png" ')
  })

  it('pastes nothing when the active pane changed during the upload', async () => {
    stubUpload(200, upload)
    const handle = createMockHandle({ paste: vi.fn(() => true) })
    expect(
      await attachImageToTerminal(handle, image, '%1', () => '%2'),
    ).toEqual({ status: 'pane-changed', insert: upload.insert })
    expect(handle.paste).not.toHaveBeenCalled()
  })

  it('reports a paste that did not go out', async () => {
    stubUpload(200, upload)
    const handle = createMockHandle({ paste: vi.fn(() => false) })
    expect(
      await attachImageToTerminal(handle, image, '%1', () => '%1'),
    ).toEqual({ status: 'not-inserted', insert: upload.insert })
    expect(await attachImageToTerminal(null, image, '%1', () => '%1')).toEqual({
      status: 'not-inserted',
      insert: upload.insert,
    })
  })

  it('reports a failed upload', async () => {
    stubUpload(413, { error: 'x', code: 'too_large' })
    const handle = createMockHandle()
    expect(
      await attachImageToTerminal(handle, image, '%1', () => '%1'),
    ).toEqual({ status: 'failed', reason: 'too_large' })
    expect(handle.paste).not.toHaveBeenCalled()
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

describe('overflowsHorizontally', () => {
  it('tells a pane wider than the screen', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollWidth', { value: 550 })
    Object.defineProperty(el, 'clientWidth', { value: 360 })
    expect(overflowsHorizontally(createMockHandle({ scroller: el }))).toBe(true)
    const fits = document.createElement('div')
    expect(overflowsHorizontally(createMockHandle({ scroller: fits }))).toBe(
      false,
    )
    expect(overflowsHorizontally(createMockHandle())).toBe(false)
    expect(overflowsHorizontally(null)).toBe(false)
  })
})

describe('dragTerminal', () => {
  // A scroller whose scrollTop/scrollLeft clamp to its content, as a
  // browser's do: a 1000x1000 grid in a 500x500 view.
  function scroller(top: number, left = 0) {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollHeight', { value: 1000 })
    Object.defineProperty(el, 'clientHeight', { value: 500 })
    let t = top
    let l = left
    Object.defineProperty(el, 'scrollTop', {
      get: () => t,
      set: (v: number) => {
        t = Math.max(0, Math.min(500, v))
      },
    })
    Object.defineProperty(el, 'scrollLeft', {
      get: () => l,
      set: (v: number) => {
        l = Math.max(0, Math.min(500, v))
      },
    })
    return el
  }

  it('moves a larger pane with the finger, up to its edges', () => {
    const el = scroller(500, 200)
    const handle = createMockHandle({ scroller: el })
    // Finger right and down: the view goes left and up
    dragTerminal(handle, 30, 40, true)
    expect(el.scrollLeft).toBe(170)
    expect(el.scrollTop).toBe(460)
    expect(handle.scrollHistory).not.toHaveBeenCalled()
    expect(handle.term!.scrollLines).not.toHaveBeenCalled()
  })

  it('scrolls the history with what the pane could not take', () => {
    // At the top; 14px font: 16.8px rows
    const el = scroller(10)
    const handle = createMockHandle({
      scroller: el,
      scrollHistory: vi.fn(() => true),
    })
    // 10px moves the pane, 33.6px is two rows back
    dragTerminal(handle, 0, 43.6, true)
    expect(el.scrollTop).toBe(0)
    expect(handle.scrollHistory).toHaveBeenLastCalledWith(2)
    // Under a row is kept for the next drag
    dragTerminal(handle, 0, 10, true)
    expect(handle.scrollHistory).toHaveBeenCalledTimes(1)
    dragTerminal(handle, 0, 10, true)
    expect(handle.scrollHistory).toHaveBeenLastCalledWith(1)
    // Up at the bottom: toward the live screen
    const bottom = scroller(500)
    const h2 = createMockHandle({
      scroller: bottom,
      scrollHistory: vi.fn(() => true),
    })
    dragTerminal(h2, 0, -16.8, true)
    expect(h2.scrollHistory).toHaveBeenLastCalledWith(-1)
  })

  it('keeps the history still while the pane is between its edges', () => {
    // A browser rounding scrollTop leaves a fraction of the drag over
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollHeight', { value: 1000 })
    Object.defineProperty(el, 'clientHeight', { value: 500 })
    let t = 200
    Object.defineProperty(el, 'scrollTop', {
      get: () => t,
      set: (v: number) => {
        t = Math.round(v)
      },
    })
    const handle = createMockHandle({
      scroller: el,
      scrollHistory: vi.fn(() => true),
    })
    for (let i = 0; i < 60; i++) dragTerminal(handle, 0, 0.4, true)
    expect(handle.scrollHistory).not.toHaveBeenCalled()
    // A drag up at the top edge does not scroll the history either
    const top = createMockHandle({
      scroller: scroller(0),
      scrollHistory: vi.fn(() => true),
    })
    dragTerminal(top, 0, -40, true)
    expect(top.scroller!.scrollTop).toBe(40)
    expect(top.scrollHistory).not.toHaveBeenCalled()
  })

  it('falls back to the xterm.js scrollback', () => {
    const handle = createMockHandle({ scroller: scroller(0) })
    dragTerminal(handle, 0, 33.6, true)
    expect(handle.term!.scrollLines).toHaveBeenLastCalledWith(-2)
    // No font set yet: rows of the default 14px
    const noFont = createMockHandle({ scroller: scroller(0) })
    noFont.term!.options.fontSize = undefined
    dragTerminal(noFont, 0, 16.8, true)
    expect(noFont.term!.scrollLines).toHaveBeenLastCalledWith(-1)
  })

  it('leaves the history alone when asked, and without a terminal', () => {
    const handle = createMockHandle({ scroller: scroller(0) })
    dragTerminal(handle, 0, 100, false)
    dragTerminal(handle, 5, 0, true)
    expect(handle.scrollHistory).not.toHaveBeenCalled()
    expect(handle.term!.scrollLines).not.toHaveBeenCalled()
    dragTerminal(
      createMockHandle({ term: null, scroller: scroller(0) }),
      0,
      50,
      true,
    )
    dragTerminal(createMockHandle(), 0, 50, true)
    dragTerminal(null, 0, 50, true)
  })
})

describe('terminal selection', () => {
  function withSelection(text: string) {
    const term = createMockTerminal()
    term.hasSelection = () => text !== ''
    term.getSelection = () => text
    return createMockHandle({ term })
  }

  it('reads the selection, or nothing', () => {
    expect(terminalSelection(withSelection('abc'))).toBe('abc')
    expect(terminalSelection(withSelection(''))).toBe('')
    expect(terminalSelection(null)).toBe('')
  })

  it('copies the selection, or reports there is none', async () => {
    expect(await copyTerminalSelection(withSelection('abc'))).toBe('ok')
    expect(mockCopyText).toHaveBeenCalledWith('abc')
    mockCopyText.mockClear()
    expect(await copyTerminalSelection(withSelection(''))).toBe('empty')
    expect(mockCopyText).not.toHaveBeenCalled()
  })
})

describe('readTerminalBufferText', () => {
  function withRows(rows: Array<[string, boolean]>) {
    const term = createMockTerminal()
    term.buffer = {
      active: {
        length: rows.length,
        getLine: (y: number) => ({
          isWrapped: rows[y][1],
          translateToString: (trim: boolean) =>
            trim ? rows[y][0].trimEnd() : rows[y][0],
        }),
      },
    }
    return createMockHandle({ term })
  }

  it('joins wrapped rows and drops the blank rows at the bottom', () => {
    const handle = withRows([
      ['$ echo aaaa', false],
      ['bbbb', true],
      ['out\x1b[31m\x07 ', false],
      ['\tx\u200e', false],
      ['', false],
      ['   ', false],
    ])
    expect(readTerminalBufferText(handle)).toBe(
      '$ echo aaaabbbb\nout[31m\n\tx\u200e',
    )
  })

  it('reads a wrapped first row as a line, and nothing without a terminal', () => {
    expect(readTerminalBufferText(withRows([['x', true]]))).toBe('x')
    expect(readTerminalBufferText(withRows([]))).toBe('')
    expect(readTerminalBufferText(null)).toBe('')
    expect(readTerminalBufferText(createMockHandle({ term: null }))).toBe('')
  })
})

describe('isCopyShortcut', () => {
  const ev = (o: Partial<KeyboardEvent>) =>
    ({
      type: 'keydown',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      code: 'KeyC',
      key: 'C',
      ...o,
    }) as KeyboardEvent

  it('matches Ctrl+Shift+C on keydown off Apple platforms', () => {
    expect(isCopyShortcut(ev({}), false)).toBe(true)
    // Another layout: the key is still C
    expect(isCopyShortcut(ev({ code: 'KeyI' }), false)).toBe(true)
    expect(isCopyShortcut(ev({ code: 'KeyX', key: 'X' }), false)).toBe(false)
    expect(isCopyShortcut(ev({ type: 'keyup' }), false)).toBe(false)
    expect(isCopyShortcut(ev({ shiftKey: false }), false)).toBe(false)
    expect(isCopyShortcut(ev({ ctrlKey: false }), false)).toBe(false)
    expect(isCopyShortcut(ev({ altKey: true }), false)).toBe(false)
    expect(isCopyShortcut(ev({ metaKey: true }), false)).toBe(false)
    expect(isCopyShortcut(ev({}), true)).toBe(false)
  })

  it('detects Apple platforms', () => {
    const nav = navigator as Navigator & { userAgentData?: unknown }
    const set = (platform: string, uaData?: unknown) => {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: platform,
      })
      Object.defineProperty(nav, 'userAgentData', {
        configurable: true,
        value: uaData,
      })
    }
    set('MacIntel')
    expect(isApplePlatform()).toBe(true)
    expect(isCopyShortcut(ev({}))).toBe(false)
    set('iPhone')
    expect(isApplePlatform()).toBe(true)
    set('Linux x86_64')
    expect(isApplePlatform()).toBe(false)
    set('', { platform: 'macOS' })
    expect(isApplePlatform()).toBe(true)
    set('', { platform: 'Windows' })
    expect(isApplePlatform()).toBe(false)
    set('')
    expect(isApplePlatform()).toBe(false)
  })
})
