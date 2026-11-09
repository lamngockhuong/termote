import { beforeEach, describe, expect, it, vi } from 'vitest'
import schemaJson from '../../../server/pwa_settings_schema.json?raw'
import casesJson from '../../../server/testdata/pwa-settings-cases.json?raw'
import { readStoredTheme, setStoredTheme } from '../contexts/theme-context'
import {
  DEFAULT_SIZE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  readStoredFontSize,
  setStoredFontSize,
} from '../hooks/use-font-size'
import {
  DEFAULTS,
  DEVICE_ONLY_KEYS,
  readSettings,
  SETTING_RESOLVERS,
  type Settings,
  writeSettingsPatch,
} from '../hooks/use-settings'
import {
  readSavedShortcuts,
  resetAllShortcuts,
  setShortcut,
} from '../hooks/use-shortcuts'
import {
  applySettings,
  checkValue,
  diffSettings,
  EXPORT_VERSION,
  exportSettings,
  IMPORT_MAX_BYTES,
  parseImport,
  REGISTRY,
  type SettingChange,
  sameValue,
} from './settings-registry'
import { COMMAND_IDS } from './shortcuts'

const platform = vi.hoisted(() => ({ apple: false }))
vi.mock('./platform', () => ({ isApplePlatform: () => platform.apple }))

interface Spec {
  key: string
  store: string
  type: string
  values?: unknown[]
  min?: number
  max?: number
  maxItems?: number
  maxBytes?: number
  commands?: string[]
  default: unknown
}
const schema = JSON.parse(schemaJson) as {
  deviceOnly: string[]
  keys: Spec[]
}
const cases = JSON.parse(casesJson).cases as {
  name: string
  values: Record<string, unknown>
  bad: string[]
}[]

beforeEach(() => {
  localStorage.clear()
  resetAllShortcuts()
  platform.apple = false
})

// The schema the server checks proposals with is the PWA's own list
describe('schema', () => {
  it('names exactly the registry keys, each in its store', () => {
    expect(schema.keys.map((k) => k.key).sort()).toEqual(
      Object.keys(REGISTRY).sort(),
    )
    for (const k of schema.keys) expect(REGISTRY[k.key].store).toBe(k.store)
  })

  it('puts every setting in the schema or among the device-only ones', () => {
    expect([...DEVICE_ONLY_KEYS].sort()).toEqual([...schema.deviceOnly].sort())
    for (const key of Object.keys(DEFAULTS))
      expect(
        Object.hasOwn(REGISTRY, key) !==
          (DEVICE_ONLY_KEYS as readonly string[]).includes(key),
      ).toBe(true)
  })

  it('has the defaults and ranges the resolvers keep', () => {
    for (const k of schema.keys) {
      const { resolve } = REGISTRY[k.key]
      if (k.type === 'shortcuts') {
        expect(k.commands).toEqual(Object.keys(COMMAND_IDS))
        // Kept as given: each command's entry is checked on its own
        expect(resolve({ 'tab.new': null })).toEqual({ 'tab.new': null })
        continue
      }
      // The default is what nothing stored reads as
      expect(resolve(undefined), k.key).toEqual(k.default)
      if (k.key in DEFAULTS)
        expect(DEFAULTS[k.key as keyof Settings]).toEqual(k.default)
      switch (k.type) {
        case 'enum':
          for (const v of k.values ?? []) expect(resolve(v), k.key).toBe(v)
          break
        case 'boolean':
          expect(resolve(!k.default)).toBe(!k.default)
          break
        case 'integer': {
          const { min = 0, max = 0 } = k
          expect(resolve(min)).toBe(min)
          expect(resolve(max)).toBe(max)
          expect(resolve(min - 1), k.key).not.toBe(min - 1)
          expect(resolve(max + 1), k.key).not.toBe(max + 1)
          break
        }
        case 'string':
          // Any saved text is kept; a proposed one has the limit
          expect(checkValue(k.key, 'x'.repeat(k.maxBytes ?? 0))).toBeUndefined()
          expect(checkValue(k.key, 'x'.repeat((k.maxBytes ?? 0) + 1))).toBe(
            'invalid',
          )
          expect(resolve(5)).toBe('')
          break
        case 'names': {
          const many = Array.from(
            { length: k.maxItems ?? 0 },
            (_, i) => `n${i}`,
          )
          expect(resolve(many)).toEqual(many)
          expect(resolve([...many, 'more'])).toEqual(many)
        }
      }
    }
    // The terminal font size's range is the hook's
    const size = schema.keys.find((k) => k.key === 'terminalFontSize')
    expect([size?.min, size?.max, size?.default]).toEqual([
      FONT_SIZE_MIN,
      FONT_SIZE_MAX,
      DEFAULT_SIZE,
    ])
  })

  // The same verdicts as the server's validateSettingsProposal
  it.each(cases)('$name', ({ values, bad }) => {
    const refused = Object.entries(values)
      .filter(([k, v]) => checkValue(k, v))
      .map(([k]) => k)
      .sort()
    expect(refused).toEqual(bad)
  })
})

describe('sameValue', () => {
  it('compares arrays in order and objects by key', () => {
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameValue(['a'], ['a', 'b'])).toBe(false)
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(sameValue({ a: 1, c: 2 }, { a: 1, b: 2 })).toBe(false)
    expect(sameValue(1, '1')).toBe(false)
    expect(sameValue(null, {})).toBe(false)
  })
})

describe('diffSettings', () => {
  it('lists only what changes, in registry order, with the value before', () => {
    writeSettingsPatch({ editorVim: true })
    const rows = diffSettings({
      editorVim: true,
      editorFontSize: 15,
      theme: 'dark',
      terminalFontSize: 18,
    })
    expect(rows).toEqual([
      { key: 'theme', before: 'system', after: 'dark' },
      { key: 'terminalFontSize', before: 14, after: 18 },
      { key: 'editorFontSize', before: 13, after: 15 },
    ])
  })

  it('marks what cannot apply', () => {
    const rows = diffSettings({
      notifyAgents: true,
      future: 1,
      editorFontSize: 99,
    })
    expect(rows).toEqual([
      { key: 'editorFontSize', before: 13, after: 99, skip: 'invalid' },
      {
        key: 'notifyAgents',
        before: undefined,
        after: true,
        skip: 'deviceOnly',
      },
      { key: 'future', before: undefined, after: 1, skip: 'unknown' },
    ])
  })

  it('lists a row per command for the shortcuts', () => {
    setShortcut('tab.new', { key: 'Mod+Shift+K' })
    setShortcut('pane.zoom', { key: 'Mod+Shift+Z' })
    const rows = diffSettings({
      shortcuts: {
        'tab.new': null, // back to the default
        'tab.next': null, // at its default already
        'pane.zoom': { key: 'Mod+Shift+Z' }, // unchanged
        'palette.commands': { inTerminal: true, key: 'Mod+Shift+L' },
        'pane.next': { key: 'Mod+Shift+C' }, // the terminal's copy key here
        nope: { key: 'Mod+J' },
        'tab.previous': { key: 'Mod+W' },
      },
    })
    expect(rows).toEqual<SettingChange[]>([
      {
        key: 'shortcuts',
        command: 'tab.new',
        before: { key: 'Mod+Shift+K' },
        after: undefined,
      },
      {
        key: 'shortcuts',
        command: 'palette.commands',
        before: undefined,
        after: { key: 'Mod+Shift+L', inTerminal: true },
      },
      {
        key: 'shortcuts',
        command: 'pane.next',
        before: undefined,
        after: { key: 'Mod+Shift+C' },
        skip: 'device',
      },
      {
        key: 'shortcuts',
        command: 'nope',
        before: undefined,
        after: { key: 'Mod+J' },
        skip: 'unknown',
      },
      {
        key: 'shortcuts',
        command: 'tab.previous',
        before: undefined,
        after: { key: 'Mod+W' },
        skip: 'invalid',
      },
    ])
    // On Apple the terminal's copy key is free
    platform.apple = true
    expect(
      diffSettings({ shortcuts: { 'pane.next': { key: 'Mod+Shift+C' } } }),
    ).toEqual([
      {
        key: 'shortcuts',
        command: 'pane.next',
        before: undefined,
        after: { key: 'Mod+Shift+C' },
      },
    ])
  })

  it('marks shortcuts that are not an object of commands', () => {
    expect(diffSettings({ shortcuts: [] })).toEqual([
      { key: 'shortcuts', before: {}, after: [], skip: 'invalid' },
    ])
  })

  it('marks a hidden character in an excluded folder', () => {
    expect(diffSettings({ findExcludes: ['a​b'] })[0].skip).toBe('invalid')
  })
})

describe('applySettings', () => {
  it('writes each store, skipping what cannot apply and device-only keys', () => {
    setShortcut('tab.new', { key: 'Mod+Shift+K' })
    const rows = diffSettings({
      editorVim: true,
      findExcludes: ['out'],
      theme: 'dark',
      terminalFontSize: 18,
      editorFontSize: 99,
      shortcuts: {
        'tab.new': null,
        'palette.commands': { key: 'Mod+Shift+L' },
      },
    })
    // A row naming a device-only key is never written, whatever it says
    rows.push({ key: 'notifyAgents', before: false, after: true })
    rows.push({ key: 'future', before: undefined, after: 1 })
    expect(applySettings(rows)).toBe(6)
    expect(readSettings().editorVim).toBe(true)
    expect(readSettings().findExcludes).toEqual(['out'])
    expect(readSettings().editorFontSize).toBe(13)
    expect(readSettings().notifyAgents).toBe(false)
    expect(readStoredTheme()).toBe('dark')
    expect(readStoredFontSize()).toBe(18)
    expect(readSavedShortcuts()).toEqual({
      'palette.commands': { key: 'Mod+Shift+L' },
    })
  })

  it('writes nothing for nothing', () => {
    const before = { ...localStorage }
    expect(applySettings([])).toBe(0)
    expect({ ...localStorage }).toEqual(before)
  })
})

describe('export and import', () => {
  it('carries every setting but the device-only ones, to another browser', () => {
    writeSettingsPatch({
      editorVim: true,
      terminalFont: 'Fira Code',
      notifyAgents: true,
      welcomeSeenVersion: 3,
    })
    setStoredTheme('light')
    setStoredFontSize(20)
    setShortcut('tab.new', { key: null })
    const text = exportSettings()
    const data = JSON.parse(text)
    expect(data.termote).toBe('settings')
    expect(data.v).toBe(EXPORT_VERSION)
    for (const key of DEVICE_ONLY_KEYS)
      expect(data.values).not.toHaveProperty(key)
    expect(data.values.shortcuts['tab.new']).toEqual({ key: null })
    expect(data.values.shortcuts['tab.next']).toBeNull()

    // Another browser: its own shortcut and device-only settings
    localStorage.clear()
    resetAllShortcuts()
    setShortcut('tab.next', { key: 'Mod+Shift+N' })
    writeSettingsPatch({ notifyAgents: false, appBadge: false })
    const parsed = parseImport(text)
    if (!('values' in parsed)) throw new Error('not read')
    expect(applySettings(diffSettings(parsed.values))).toBeGreaterThan(0)
    expect(readSettings().editorVim).toBe(true)
    expect(readSettings().terminalFont).toBe('Fira Code')
    expect(readSettings().welcomeSeenVersion).toBe(0)
    expect(readSettings().appBadge).toBe(false)
    expect(readStoredTheme()).toBe('light')
    expect(readStoredFontSize()).toBe(20)
    expect(readSavedShortcuts()).toEqual({ 'tab.new': { key: null } })
    // Importing it again changes nothing
    expect(diffSettings(parsed.values)).toEqual([])
  })

  it('says why a file cannot be read', () => {
    expect(parseImport('{')).toEqual({ error: 'json' })
    expect(parseImport('[]')).toEqual({ error: 'format' })
    expect(parseImport('{"termote":"tasks","v":1}')).toEqual({
      error: 'format',
    })
    expect(parseImport('{"termote":"settings","v":2,"values":{}}')).toEqual({
      error: 'version',
    })
    for (const v of ['0', '"1"', 'null'])
      expect(
        parseImport(`{"termote":"settings","v":${v},"values":{}}`),
      ).toEqual({ error: 'format' })
    expect(parseImport('{"termote":"settings","v":1,"values":[]}')).toEqual({
      error: 'format',
    })
    expect(parseImport(' '.repeat(IMPORT_MAX_BYTES + 1))).toEqual({
      error: 'tooLarge',
    })
    expect(
      parseImport('{"termote":"settings","v":1,"values":{"theme":"dark"}}'),
    ).toEqual({ values: { theme: 'dark' } })
  })
})

describe('resolvers', () => {
  it('keeps every default as it is', () => {
    for (const [key, resolve] of Object.entries(SETTING_RESOLVERS))
      expect(
        (resolve as (v: unknown) => unknown)(DEFAULTS[key as keyof Settings]),
      ).toEqual(DEFAULTS[key as keyof Settings])
  })
})

describe('a saved terminal font', () => {
  it('stays whatever its length, through a reload and another change', () => {
    const font = Array.from({ length: 20 }, (_, i) => `Font Family ${i}`).join(
      ', ',
    )
    expect(new TextEncoder().encode(font).length).toBeGreaterThan(200)
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ terminalFont: font }),
    )
    expect(readSettings().terminalFont).toBe(font)
    writeSettingsPatch({ editorVim: true })
    expect(
      JSON.parse(localStorage.getItem('termote-settings') ?? '{}').terminalFont,
    ).toBe(font)
    // Proposing or importing it is refused, and the table says so
    expect(diffSettings({ terminalFont: `${font}x` })[0].skip).toBe('invalid')
    expect(checkValue('terminalFont', ' Mono')).toBe('invalid')
    expect(checkValue('terminalFont', 'Mo\u200bno')).toBe('invalid')
  })
})
