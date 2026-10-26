import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetAllShortcuts,
  resetShortcut,
  SHORTCUTS_KEY,
  type ShortcutCommand,
  setShortcut,
  terminalShortcut,
  useKeymap,
  useSavedShortcuts,
  useShortcutDispatcher,
  useShortcutKey,
} from './use-shortcuts'

const platform = vi.hoisted(() => ({ apple: false }))
vi.mock('../utils/platform', () => ({
  isApplePlatform: () => platform.apple,
}))

function storageChanged(key: string | null = SHORTCUTS_KEY) {
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key }))
  })
}

function key(
  code: string,
  mods: KeyboardEventInit = {},
  target: EventTarget = document.body,
) {
  const e = new KeyboardEvent('keydown', {
    code,
    bubbles: true,
    cancelable: true,
    ...mods,
  })
  target.dispatchEvent(e)
  return e
}

function commands(overrides: Partial<ShortcutCommand>[] = []) {
  const base: ShortcutCommand[] = [
    { id: 'palette.quickOpen', defaultKey: 'Mod+P', run: vi.fn() },
    {
      id: 'palette.commands',
      defaultKey: 'Mod+Shift+P',
      inTerminal: true,
      run: vi.fn(),
    },
    { id: 'app.help', defaultKey: 'F1', run: vi.fn() },
  ]
  return base.map((c, i) => ({ ...c, ...overrides[i] }))
}

beforeEach(() => {
  platform.apple = false
  localStorage.clear()
  resetAllShortcuts()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('saved shortcuts', () => {
  it('are written as one versioned value, and removed when empty', () => {
    const { result } = renderHook(() => useSavedShortcuts())
    act(() => setShortcut('app.help', { key: 'Mod+Alt+H' }))
    act(() => setShortcut('app.help', { inTerminal: false }))
    expect(result.current).toEqual({
      'app.help': { key: 'Mod+Alt+H', inTerminal: false },
    })
    expect(JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? '')).toEqual({
      v: 1,
      keys: { 'app.help': { key: 'Mod+Alt+H', inTerminal: false } },
    })
    act(() => resetShortcut('app.help'))
    expect(result.current).toEqual({})
    expect(localStorage.getItem(SHORTCUTS_KEY)).toBeNull()
  })

  it('follow another tab through the storage event', () => {
    const { result } = renderHook(() => useSavedShortcuts())
    localStorage.setItem(
      SHORTCUTS_KEY,
      JSON.stringify({ v: 1, keys: { 'app.about': { key: null } } }),
    )
    storageChanged('other-key')
    expect(result.current).toEqual({})
    storageChanged()
    expect(result.current).toEqual({ 'app.about': { key: null } })
    localStorage.clear()
    storageChanged(null)
    expect(result.current).toEqual({})
  })

  it('keep listening while any reader is mounted', () => {
    const first = renderHook(() => useSavedShortcuts())
    const second = renderHook(() => useSavedShortcuts())
    first.unmount()
    localStorage.setItem(
      SHORTCUTS_KEY,
      JSON.stringify({ v: 1, keys: { 'app.about': { key: null } } }),
    )
    storageChanged()
    expect(second.result.current).toEqual({ 'app.about': { key: null } })
  })

  it('read corrupt data as the defaults, without writing it back', () => {
    const { result } = renderHook(() => useSavedShortcuts())
    localStorage.setItem(SHORTCUTS_KEY, '{not json')
    storageChanged()
    expect(result.current).toEqual({})
    expect(localStorage.getItem(SHORTCUTS_KEY)).toBe('{not json')
  })

  it('still change in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    const { result } = renderHook(() => useSavedShortcuts())
    act(() => setShortcut('app.help', { key: null }))
    expect(result.current).toEqual({ 'app.help': { key: null } })
  })

  it('keep the key of a command not shown now, when another one changes', () => {
    act(() => setShortcut('settings.devices', { key: 'Mod+Alt+D' }))
    // The keymap of a view-only device has no Devices command
    const cmds = commands()
    const { result } = renderHook(() => useKeymap(cmds))
    expect(result.current.byId['settings.devices']).toBeUndefined()
    act(() => setShortcut('app.help', { key: 'F2' }))
    expect(JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? '').keys).toEqual({
      'settings.devices': { key: 'Mod+Alt+D' },
      'app.help': { key: 'F2' },
    })
  })

  it('resolve into a keymap', () => {
    const cmds = commands()
    const { result } = renderHook(() => useKeymap(cmds))
    expect(result.current.byId['palette.quickOpen']?.key).toBe('Mod+P')
    act(() => setShortcut('palette.quickOpen', { key: 'Mod+Alt+O' }))
    expect(result.current.byId['palette.quickOpen']?.key).toBe('Mod+Alt+O')
  })
})

describe('useShortcutKey', () => {
  it('is the default until the user changes it or gives it away', () => {
    const { result } = renderHook(() =>
      useShortcutKey('files.searchContent', 'Mod+Shift+F'),
    )
    expect(result.current).toBe('Mod+Shift+F')
    act(() => setShortcut('files.searchContent', { key: 'Mod+Alt+F' }))
    expect(result.current).toBe('Mod+Alt+F')
    act(() => {
      resetShortcut('files.searchContent')
      setShortcut('app.help', { key: 'Mod+Shift+F' })
    })
    expect(result.current).toBeUndefined()
  })
})

describe('useShortcutDispatcher', () => {
  it('runs the command of a chord and keeps the key from the browser', () => {
    const cmds = commands()
    renderHook(() => useShortcutDispatcher(cmds, true))
    const e = key('KeyP', { ctrlKey: true })
    expect(cmds[0].run).toHaveBeenCalledOnce()
    expect(e.defaultPrevented).toBe(true)
    key('F1')
    expect(cmds[2].run).toHaveBeenCalledOnce()
  })

  it('uses Cmd on Apple', () => {
    platform.apple = true
    const cmds = commands()
    renderHook(() => useShortcutDispatcher(cmds, true))
    key('KeyP', { ctrlKey: true })
    expect(cmds[0].run).not.toHaveBeenCalled()
    key('KeyP', { metaKey: true })
    expect(cmds[0].run).toHaveBeenCalledOnce()
  })

  it('leaves alone a key handled already, held, composing or unbound', () => {
    const cmds = commands()
    renderHook(() => useShortcutDispatcher(cmds, true))
    const handled = new KeyboardEvent('keydown', {
      code: 'KeyP',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    handled.preventDefault()
    document.body.dispatchEvent(handled)
    key('KeyP', { ctrlKey: true, repeat: true })
    key('KeyP', { ctrlKey: true, isComposing: true })
    const unbound = key('KeyJ', { ctrlKey: true })
    const typing = key('KeyP')
    expect(cmds[0].run).not.toHaveBeenCalled()
    expect(unbound.defaultPrevented).toBe(false)
    expect(typing.defaultPrevented).toBe(false)
  })

  it('does not run in a dialog or menu, but keeps the chord from the browser', () => {
    const cmds = commands()
    renderHook(() => useShortcutDispatcher(cmds, true))
    for (const html of [
      '<dialog open><input></dialog>',
      '<div role="menu"><button></button></div>',
      '<div inert><button></button></div>',
      '<div role="alertdialog"><button></button></div>',
    ]) {
      document.body.innerHTML = html
      const target = document.body.querySelector('input,button') as Element
      const e = key('KeyP', { ctrlKey: true }, target)
      expect(e.defaultPrevented).toBe(true)
      const other = key('KeyJ', { ctrlKey: true }, target)
      expect(other.defaultPrevented).toBe(false)
    }
    expect(cmds[0].run).not.toHaveBeenCalled()
  })

  it('runs only terminal commands from the terminal', () => {
    const cmds = commands()
    renderHook(() => useShortcutDispatcher(cmds, true))
    document.body.innerHTML = '<div class="xterm"><textarea></textarea></div>'
    const ta = document.body.querySelector('textarea') as Element
    const e = key('KeyP', { ctrlKey: true }, ta)
    expect(cmds[0].run).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    key('KeyP', { ctrlKey: true, shiftKey: true }, ta)
    expect(cmds[1].run).toHaveBeenCalledOnce()
  })

  it('does not run, nor take the key of, a disabled command', () => {
    const cmds = commands([{ disabledReason: 'Not now' }])
    renderHook(() => useShortcutDispatcher(cmds, true))
    const e = key('KeyP', { ctrlKey: true })
    expect(cmds[0].run).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('runs nothing for a shared chord, but the palette', () => {
    const cmds = commands()
    renderHook(() => useShortcutDispatcher(cmds, true))
    act(() => {
      setShortcut('app.help', { key: 'Mod+K' })
      setShortcut('palette.quickOpen', { key: 'Mod+K' })
    })
    key('KeyK', { ctrlKey: true })
    expect(cmds[0].run).not.toHaveBeenCalled()
    expect(cmds[2].run).not.toHaveBeenCalled()
    act(() => setShortcut('palette.commands', { key: 'Mod+K' }))
    key('KeyK', { ctrlKey: true })
    expect(cmds[1].run).toHaveBeenCalledOnce()
  })

  it('listens only when enabled (desktop)', () => {
    const cmds = commands()
    const { rerender, unmount } = renderHook(
      ({ on }) => useShortcutDispatcher(cmds, on),
      { initialProps: { on: false } },
    )
    key('KeyP', { ctrlKey: true })
    expect(cmds[0].run).not.toHaveBeenCalled()
    rerender({ on: true })
    key('KeyP', { ctrlKey: true })
    expect(cmds[0].run).toHaveBeenCalledOnce()
    unmount()
    key('KeyP', { ctrlKey: true })
    expect(cmds[0].run).toHaveBeenCalledOnce()
  })

  it('handles an event whose target is not an element', () => {
    const cmds = commands()
    renderHook(() => useShortcutDispatcher(cmds, true))
    key('KeyP', { ctrlKey: true }, window)
    expect(cmds[0].run).toHaveBeenCalledOnce()
  })
})

describe('terminalShortcut', () => {
  const ev = (init: KeyboardEventInit, type = 'keydown') =>
    new KeyboardEvent(type, init)

  it('is false while no dispatcher runs', () => {
    expect(
      terminalShortcut(ev({ code: 'KeyP', ctrlKey: true, shiftKey: true })),
    ).toBe(false)
  })

  it('claims only a keydown of a runnable terminal command', () => {
    const cmds = commands()
    const { rerender } = renderHook(
      ({ list }) => useShortcutDispatcher(list, true),
      { initialProps: { list: cmds } },
    )
    const palette = { code: 'KeyP', ctrlKey: true, shiftKey: true }
    expect(terminalShortcut(ev(palette))).toBe(true)
    expect(terminalShortcut(ev(palette, 'keyup'))).toBe(false)
    expect(terminalShortcut(ev({ code: 'KeyP', ctrlKey: true }))).toBe(false)
    expect(terminalShortcut(ev({ code: 'KeyC', ctrlKey: true }))).toBe(false)
    expect(terminalShortcut(ev({ code: 'KeyJ', ctrlKey: true }))).toBe(false)
    expect(terminalShortcut(ev({ code: 'ShiftLeft', shiftKey: true }))).toBe(
      false,
    )
    rerender({ list: commands([{}, { disabledReason: 'No' }]) })
    expect(terminalShortcut(ev(palette))).toBe(false)
  })

  it('claims Cmd+P on Apple', () => {
    platform.apple = true
    const cmds = commands([{ inTerminal: true }])
    renderHook(() => useShortcutDispatcher(cmds, true))
    expect(terminalShortcut(ev({ code: 'KeyP', metaKey: true }))).toBe(true)
  })
})
