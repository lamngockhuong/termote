// Every setting an agent may propose (termote settings propose) and that
// Export/Import carries, across the four places they are stored: read them,
// compare a set of values with them and apply it, at once in every view.
// The list is server/pwa_settings_schema.json's; settings-registry.test.ts
// checks the two match and runs server/testdata/pwa-settings-cases.json.

import {
  readStoredTheme,
  resolveTheme,
  setStoredTheme,
  type Theme,
} from '../contexts/theme-context'
import {
  readStoredFontSize,
  resolveFontSize,
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
import { applyShortcutsPatch, readSavedShortcuts } from '../hooks/use-shortcuts'
import { isApplePlatform } from './platform'
import { hiddenChars } from './prompt-templates'
import {
  COMMAND_IDS,
  type CommandId,
  isCommandId,
  isRefusedChord,
  parseChord,
  readSaved,
  type SavedShortcut,
  SHORTCUTS_VERSION,
} from './shortcuts'

export type SettingStore = 'settings' | 'theme' | 'font-size' | 'shortcuts'

interface Entry {
  store: SettingStore
  resolve: (value: unknown) => unknown
  read: () => unknown
}

const DEVICE_ONLY: readonly string[] = DEVICE_ONLY_KEYS

function settingsEntry(key: keyof Settings): Entry {
  return {
    store: 'settings',
    resolve: SETTING_RESOLVERS[key],
    read: () => readSettings()[key],
  }
}

// Each key's store, resolver and reader: the settings of termote-settings
// but the device-only ones, the colour mode, the terminal font size and the
// shortcuts. A diff lists them in this order.
export const REGISTRY: Readonly<Record<string, Entry>> = {
  theme: { store: 'theme', resolve: resolveTheme, read: readStoredTheme },
  terminalFontSize: {
    store: 'font-size',
    resolve: resolveFontSize,
    read: readStoredFontSize,
  },
  ...Object.fromEntries(
    (Object.keys(DEFAULTS) as (keyof Settings)[])
      .filter((k) => !DEVICE_ONLY.includes(k))
      .map((k) => [k, settingsEntry(k)]),
  ),
  shortcuts: {
    store: 'shortcuts',
    resolve: (v) => v,
    read: readSavedShortcuts,
  },
}

// Why a value is not applied: this version does not know the key (the
// server is newer), the value is not one it can keep, the chord does not
// work on this device, or the setting belongs to the device alone
export type SkipReason = 'unknown' | 'invalid' | 'device' | 'deviceOnly'

export interface SettingChange {
  key: string
  // For shortcuts: the command whose shortcut changes
  command?: string
  before: unknown
  // undefined: back to the default (a shortcut)
  after: unknown
  skip?: SkipReason
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]))
    )
  }
  return false
}

// A chord the app refuses on every platform: the browser keeps it, or text
// editing uses it (the server refuses the same)
function refusedEverywhere(chord: string): boolean {
  return !!isRefusedChord(chord, true) && !!isRefusedChord(chord, false)
}

// Whether one command's entry is valid wherever it is applied: null, or
// {key?: normal chord | null, inTerminal?: boolean} with something in it
function validShortcutEntry(entry: unknown): boolean {
  if (entry === null) return true
  if (!isPlainObject(entry) || !Object.keys(entry).length) return false
  return Object.entries(entry).every(([field, v]) => {
    if (field === 'inTerminal') return typeof v === 'boolean'
    if (field !== 'key') return false
    if (v === null) return true
    return typeof v === 'string' && parseChord(v) === v && !refusedEverywhere(v)
  })
}

// Why value cannot be key's anywhere, or undefined when it can: the check
// the server makes too
export function checkValue(
  key: string,
  value: unknown,
): SkipReason | undefined {
  if (DEVICE_ONLY.includes(key)) return 'deviceOnly'
  const entry = Object.hasOwn(REGISTRY, key) ? REGISTRY[key] : undefined
  if (!entry) return 'unknown'
  if (key === 'shortcuts') {
    if (!isPlainObject(value) || !Object.keys(value).length) return 'invalid'
    return Object.entries(value).every(
      ([id, e]) => isCommandId(id) && validShortcutEntry(e),
    )
      ? undefined
      : 'invalid'
  }
  if (!sameValue(entry.resolve(value), value)) return 'invalid'
  // The PWA keeps any directory name; a proposed one must hide nothing
  if (
    key === 'findExcludes' &&
    (value as string[]).some((n) => hiddenChars(n, false).length)
  )
    return 'invalid'
}

// The changes one command's shortcut entry makes on this device
function shortcutChange(
  id: string,
  entry: unknown,
  apple: boolean,
): SettingChange | undefined {
  const saved = readSavedShortcuts()
  const before = isCommandId(id) ? saved[id] : undefined
  const row = { key: 'shortcuts', command: id, before }
  if (!isCommandId(id)) return { ...row, after: entry, skip: 'unknown' }
  if (!validShortcutEntry(entry))
    return { ...row, after: entry, skip: 'invalid' }
  if (entry === null)
    return before === undefined ? undefined : { ...row, after: undefined }
  const kept = readSaved(
    { v: SHORTCUTS_VERSION, keys: { [id]: entry } },
    apple,
  )[id]
  if (!sameValue(kept, entry)) return { ...row, after: entry, skip: 'device' }
  return sameValue(kept, before) ? undefined : { ...row, after: kept }
}

// What values would change here: one row per setting (per command for the
// shortcuts) whose value differs, those that cannot apply marked skip
export function diffSettings(
  values: Record<string, unknown>,
  apple = isApplePlatform(),
): SettingChange[] {
  const rows: SettingChange[] = []
  const order = Object.keys(REGISTRY)
  const keys = Object.keys(values).sort(
    (a, b) =>
      (order.includes(a) ? order.indexOf(a) : order.length) -
      (order.includes(b) ? order.indexOf(b) : order.length),
  )
  for (const key of keys) {
    const value = values[key]
    if (
      key === 'shortcuts' &&
      isPlainObject(value) &&
      Object.keys(value).length
    ) {
      for (const [id, entry] of Object.entries(value)) {
        const row = shortcutChange(id, entry, apple)
        if (row) rows.push(row)
      }
      continue
    }
    const skip = checkValue(key, value)
    const before =
      !skip || skip === 'invalid' ? REGISTRY[key]?.read() : undefined
    if (skip) rows.push({ key, before, after: value, skip })
    else if (!sameValue(before, value)) rows.push({ key, before, after: value })
  }
  return rows
}

// Apply the rows that are not skipped, each store written once; every view
// shows them at once. Returns how many were applied. Never writes a
// device-only setting.
export function applySettings(rows: SettingChange[]): number {
  const patch: Record<string, unknown> = {}
  const shortcuts: Partial<Record<CommandId, SavedShortcut | null>> = {}
  let theme: Theme | undefined
  let fontSize: number | undefined
  let applied = 0
  for (const row of rows) {
    if (row.skip || DEVICE_ONLY.includes(row.key)) continue
    const store = REGISTRY[row.key]?.store
    if (store === 'settings') patch[row.key] = row.after
    else if (store === 'theme') theme = row.after as Theme
    else if (store === 'font-size') fontSize = row.after as number
    else if (store === 'shortcuts' && row.command && isCommandId(row.command))
      shortcuts[row.command] = (row.after as SavedShortcut | undefined) ?? null
    else continue
    applied++
  }
  if (Object.keys(patch).length) writeSettingsPatch(patch as Partial<Settings>)
  if (theme) setStoredTheme(theme)
  if (fontSize !== undefined) setStoredFontSize(fontSize)
  if (Object.keys(shortcuts).length) applyShortcutsPatch(shortcuts)
  return applied
}

export const EXPORT_VERSION = 1

// Every setting the registry knows, as the JSON Export saves: the shortcuts
// name every command, null for those at their default, so an Import gives
// another browser exactly these
export function exportSettings(): string {
  const values: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(REGISTRY))
    values[key] = entry.read()
  const saved = readSavedShortcuts()
  values.shortcuts = Object.fromEntries(
    (Object.keys(COMMAND_IDS) as CommandId[]).map((id) => [
      id,
      saved[id] ?? null,
    ]),
  )
  return `${JSON.stringify({ termote: 'settings', v: EXPORT_VERSION, values }, null, 2)}\n`
}

// The largest file Import reads
export const IMPORT_MAX_BYTES = 64 * 1024

export type ImportError = 'json' | 'format' | 'version' | 'tooLarge'

// The values of an exported file, or why it cannot be read. Its values are
// checked by diffSettings, which marks what cannot apply.
export function parseImport(
  text: string,
): { values: Record<string, unknown> } | { error: ImportError } {
  if (new TextEncoder().encode(text).length > IMPORT_MAX_BYTES)
    return { error: 'tooLarge' }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: 'json' }
  }
  if (!isPlainObject(data) || data.termote !== 'settings')
    return { error: 'format' }
  if (data.v !== EXPORT_VERSION) return { error: 'version' }
  if (!isPlainObject(data.values)) return { error: 'format' }
  return { values: data.values }
}
