import { describe, expect, it } from 'vitest'
import {
  canRunInTerminal,
  chordFromEvent,
  commandForChord,
  findConflicts,
  formatChord,
  isCommandId,
  isRefusedChord,
  keyFromCode,
  parseChord,
  readSaved,
  resolveKeymap,
  type ShortcutDefault,
} from './shortcuts'

function press(
  code: string,
  mods: Partial<
    Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>
  > = {},
  altGraph = false,
) {
  return {
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
    getModifierState: (k: string) => altGraph && k === 'AltGraph',
  }
}

describe('command ids', () => {
  it('are the static catalogue, never an inherited name', () => {
    expect(isCommandId('palette.commands')).toBe(true)
    expect(isCommandId('view.tasks')).toBe(true)
    expect(isCommandId('nope')).toBe(false)
    expect(isCommandId('__proto__')).toBe(false)
    expect(isCommandId('constructor')).toBe(false)
  })
})

describe('keyFromCode', () => {
  it('reads letters, digits, F-keys and named keys', () => {
    expect(keyFromCode('KeyP')).toBe('P')
    expect(keyFromCode('Digit1')).toBe('1')
    expect(keyFromCode('F5')).toBe('F5')
    expect(keyFromCode('Comma')).toBe('Comma')
  })

  it('has no key for a modifier or an unknown code', () => {
    expect(keyFromCode('ShiftLeft')).toBeUndefined()
    expect(keyFromCode('F13')).toBeUndefined()
    expect(keyFromCode('Numpad1')).toBeUndefined()
  })
})

describe('parseChord', () => {
  it('normalizes the modifier order', () => {
    expect(parseChord('Shift+Mod+P')).toBe('Mod+Shift+P')
    expect(parseChord('Alt+Ctrl+O')).toBe('Ctrl+Alt+O')
    expect(parseChord('Meta+K')).toBe('Meta+K')
    expect(parseChord('F2')).toBe('F2')
  })

  it('refuses a chord without Ctrl or Meta, or a bad token', () => {
    expect(parseChord('Shift+K')).toBeUndefined()
    expect(parseChord('Alt+O')).toBeUndefined()
    expect(parseChord('K')).toBeUndefined()
    expect(parseChord('Mod+Mod+K')).toBeUndefined()
    expect(parseChord('Hyper+K')).toBeUndefined()
    expect(parseChord('Mod+')).toBeUndefined()
    expect(parseChord('Mod+F13')).toBeUndefined()
  })
})

describe('chordFromEvent', () => {
  it('maps Ctrl to Mod off Apple, Meta to Mod on Apple', () => {
    expect(
      chordFromEvent(press('KeyP', { ctrlKey: true, shiftKey: true }), false),
    ).toBe('Mod+Shift+P')
    expect(chordFromEvent(press('KeyP', { metaKey: true }), true)).toBe('Mod+P')
    expect(chordFromEvent(press('KeyP', { ctrlKey: true }), true)).toBe(
      'Ctrl+P',
    )
    expect(chordFromEvent(press('KeyP', { metaKey: true }), false)).toBe(
      'Meta+P',
    )
    expect(
      chordFromEvent(press('KeyO', { ctrlKey: true, altKey: true }), false),
    ).toBe('Mod+Alt+O')
  })

  it('takes a function key alone', () => {
    expect(chordFromEvent(press('F1'), false)).toBe('F1')
  })

  it('is no chord for typing keys, modifiers or AltGr', () => {
    expect(chordFromEvent(press('KeyK', { shiftKey: true }), false)).toBe(
      undefined,
    )
    expect(chordFromEvent(press('KeyO', { altKey: true }), false)).toBe(
      undefined,
    )
    expect(
      chordFromEvent(press('ControlLeft', { ctrlKey: true }), false),
    ).toBeUndefined()
    expect(
      chordFromEvent(
        press('KeyQ', { ctrlKey: true, altKey: true }, true),
        false,
      ),
    ).toBeUndefined()
  })

  it('works without getModifierState', () => {
    const { getModifierState: _, ...e } = press('KeyP', { ctrlKey: true })
    expect(
      chordFromEvent(
        e as unknown as Parameters<typeof chordFromEvent>[0],
        false,
      ),
    ).toBe('Mod+P')
  })
})

describe('formatChord', () => {
  it('shows symbols on Apple, names elsewhere', () => {
    expect(formatChord('Mod+Shift+P', true)).toBe('⇧⌘P')
    expect(formatChord('Ctrl+Alt+Comma', true)).toBe('⌃⌥,')
    expect(formatChord('Mod+Shift+P', false)).toBe('Ctrl+Shift+P')
    expect(formatChord('Meta+ArrowUp', false)).toBe('Win+↑')
    expect(formatChord('F2', false)).toBe('F2')
  })

  it('leaves a malformed chord as it is', () => {
    expect(formatChord('what', false)).toBe('what')
  })
})

describe('isRefusedChord', () => {
  it('refuses keys the browser keeps', () => {
    for (const k of ['Mod+W', 'Mod+T', 'Mod+N', 'Mod+Q', 'Mod+Shift+T'])
      expect(isRefusedChord(k, false)).toBe('The browser keeps this key')
    expect(isRefusedChord('Mod+Tab', false)).toBe('The browser keeps this key')
    expect(isRefusedChord('Ctrl+Tab', true)).toBe('The browser keeps this key')
  })

  it('refuses fixed editor, terminal and text keys', () => {
    expect(isRefusedChord('Mod+S', false)).toBe('Used by the editor')
    expect(isRefusedChord('Mod+Shift+C', false)).toBe('Used by the terminal')
    expect(isRefusedChord('Mod+Shift+C', true)).toBeUndefined()
    expect(isRefusedChord('Mod+Shift+V', false)).toBe('Used by the terminal')
    expect(isRefusedChord('Mod+V', true)).toBe('Used to edit text')
  })

  it('accepts anything else', () => {
    expect(isRefusedChord('Mod+P', false)).toBeUndefined()
  })
})

describe('canRunInTerminal', () => {
  it('off Apple: only Ctrl+Shift+letter, not C', () => {
    expect(canRunInTerminal('Mod+Shift+P', false)).toBe(true)
    expect(canRunInTerminal('Mod+Shift+C', false)).toBe(false)
    expect(canRunInTerminal('Mod+Shift+V', false)).toBe(false)
    expect(canRunInTerminal('Mod+P', false)).toBe(false)
    expect(canRunInTerminal('Mod+Alt+Shift+P', false)).toBe(false)
    expect(canRunInTerminal('Mod+Shift+1', false)).toBe(false)
    expect(canRunInTerminal('Meta+Shift+P', false)).toBe(false)
    expect(canRunInTerminal('F2', false)).toBe(false)
  })

  it('on Apple: anything with Cmd that is not refused', () => {
    expect(canRunInTerminal('Mod+P', true)).toBe(true)
    expect(canRunInTerminal('Mod+C', true)).toBe(false)
    expect(canRunInTerminal('Mod+Shift+1', true)).toBe(true)
    expect(canRunInTerminal('Mod+Alt+Comma', true)).toBe(true)
    // Keys xterm still sends with Cmd, and Cmd with Ctrl
    for (const k of ['Mod+Enter', 'Mod+Backspace', 'Mod+Escape', 'Mod+F5'])
      expect(canRunInTerminal(k, true)).toBe(false)
    expect(canRunInTerminal('Mod+Ctrl+Shift+2', true)).toBe(false)
    expect(canRunInTerminal('Ctrl+Shift+P', true)).toBe(false)
  })

  it('never for a malformed chord', () => {
    expect(canRunInTerminal('nope', false)).toBe(false)
  })
})

describe('readSaved', () => {
  it('keeps valid entries, normalized', () => {
    expect(
      readSaved(
        {
          v: 1,
          keys: {
            'palette.quickOpen': { key: 'Alt+Mod+O' },
            'app.help': { key: null },
            'palette.commands': { inTerminal: false },
          },
        },
        false,
      ),
    ).toEqual({
      'palette.quickOpen': { key: 'Mod+Alt+O' },
      'app.help': { key: null },
      'palette.commands': { inTerminal: false },
    })
  })

  it('drops unknown ids, inherited names and bad values', () => {
    const raw = JSON.parse(
      '{"v":1,"keys":{"__proto__":{"key":"Mod+K"},"constructor":{"key":"Mod+K"},"nope":{"key":"Mod+K"},"app.help":"Mod+K","app.about":{"key":"Shift+K","inTerminal":"yes"},"tab.new":{"key":"Mod+W"},"tab.next":{"key":5}}}',
    )
    const saved = readSaved(raw, false)
    expect(saved).toEqual({})
    expect(Object.getPrototypeOf(saved)).toBe(Object.prototype)
  })

  it('is empty for another version or a non-object', () => {
    expect(
      readSaved({ v: 2, keys: { 'app.help': { key: null } } }, false),
    ).toEqual({})
    expect(readSaved({ v: 1, keys: 'x' }, false)).toEqual({})
    expect(readSaved({ v: 1 }, false)).toEqual({})
    expect(readSaved(null, false)).toEqual({})
    expect(readSaved('x', false)).toEqual({})
  })
})

const DEFAULTS: ShortcutDefault[] = [
  { id: 'palette.quickOpen', defaultKey: 'Mod+P' },
  { id: 'palette.commands', defaultKey: 'Mod+Shift+P', inTerminal: true },
  { id: 'files.searchContent', defaultKey: 'Mod+Shift+F' },
  { id: 'app.help' },
  { id: 'app.about' },
]

describe('resolveKeymap', () => {
  it('uses the defaults when nothing is saved', () => {
    const km = resolveKeymap(DEFAULTS, {}, false)
    expect(km.byId['palette.quickOpen']).toEqual({
      key: 'Mod+P',
      inTerminal: false,
      custom: false,
      replacedBy: undefined,
    })
    expect(km.byId['palette.commands']?.inTerminal).toBe(true)
    expect(km.byId['app.help']?.key).toBeUndefined()
    expect(km.byChord.get('Mod+P')).toEqual(['palette.quickOpen'])
  })

  it('lets an override win over the default it collides with', () => {
    const km = resolveKeymap(DEFAULTS, { 'app.help': { key: 'Mod+P' } }, false)
    expect(km.byId['app.help']).toMatchObject({ key: 'Mod+P', custom: true })
    expect(km.byId['palette.quickOpen']).toMatchObject({
      key: undefined,
      replacedBy: 'app.help',
    })
    expect(commandForChord(km, 'Mod+P')).toBe('app.help')
    expect(findConflicts(km).size).toBe(0)
  })

  it('keeps a command own default when its override is its own key', () => {
    const km = resolveKeymap(
      DEFAULTS,
      { 'palette.quickOpen': { key: 'Mod+P' } },
      false,
    )
    expect(km.byId['palette.quickOpen']).toMatchObject({
      key: 'Mod+P',
      custom: true,
    })
  })

  it('turns a key off with null', () => {
    const km = resolveKeymap(
      DEFAULTS,
      { 'palette.quickOpen': { key: null } },
      false,
    )
    expect(km.byId['palette.quickOpen']).toMatchObject({
      key: undefined,
      custom: true,
    })
    expect(km.byChord.has('Mod+P')).toBe(false)
  })

  it('marks two overrides on one chord; only the palette still runs', () => {
    const km = resolveKeymap(
      DEFAULTS,
      { 'app.help': { key: 'Mod+K' }, 'app.about': { key: 'Mod+K' } },
      false,
    )
    expect(findConflicts(km).get('app.help')).toEqual(['app.about'])
    expect(findConflicts(km).get('app.about')).toEqual(['app.help'])
    expect(commandForChord(km, 'Mod+K')).toBeUndefined()
    const withPalette = resolveKeymap(
      DEFAULTS,
      { 'app.help': { key: 'Mod+K' }, 'palette.commands': { key: 'Mod+K' } },
      false,
    )
    expect(commandForChord(withPalette, 'Mod+K')).toBe('palette.commands')
    expect(commandForChord(withPalette, 'Mod+J')).toBeUndefined()
  })

  it('runs in the terminal only where the chord allows it', () => {
    const km = resolveKeymap(
      DEFAULTS,
      {
        'palette.quickOpen': { inTerminal: true },
        'palette.commands': { key: 'Mod+Shift+K' },
        'app.help': { key: 'Mod+Shift+H', inTerminal: true },
        'files.searchContent': { inTerminal: false },
      },
      false,
    )
    expect(km.byId['palette.quickOpen']?.inTerminal).toBe(false)
    expect(km.byId['palette.commands']?.inTerminal).toBe(true)
    expect(km.byId['app.help']?.inTerminal).toBe(true)
    expect(km.byId['files.searchContent']?.inTerminal).toBe(false)
    expect(km.byId['app.about']?.inTerminal).toBe(false)
  })
})
