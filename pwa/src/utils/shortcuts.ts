// Desktop keyboard shortcuts: a chord is a normalized string such as
// "Mod+Shift+P", where Mod is Cmd on Apple platforms and Ctrl elsewhere
// (Ctrl on Apple is the real Control key, Meta elsewhere the Windows key).
// The key is the physical key (KeyboardEvent.code), so a chord does not
// change with the keyboard layout's Shift characters.

// Every id a command can have, whether or not this pane, backend or role
// shows it: a saved shortcut is kept or dropped by this list alone, so an
// override of a command hidden right now survives.
export const COMMAND_IDS = {
  'palette.quickOpen': true,
  'palette.commands': true,
  'palette.goToLine': true,
  'palette.sessions': true,
  'view.terminal': true,
  'view.chat': true,
  'view.filesPanel': true,
  'view.changesPanel': true,
  'view.overview': true,
  'files.searchContent': true,
  'tab.new': true,
  'tab.previous': true,
  'tab.next': true,
  'agent.start': true,
  'settings.open': true,
  'settings.devices': true,
  'settings.shortcuts': true,
  'app.help': true,
  'app.about': true,
  'app.toggleSidebar': true,
  'app.fullscreen': true,
  'terminal.fontIncrease': true,
  'terminal.fontDecrease': true,
  'theme.light': true,
  'theme.dark': true,
  'theme.system': true,
} as const

export type CommandId = keyof typeof COMMAND_IDS

export function isCommandId(id: string): id is CommandId {
  return Object.hasOwn(COMMAND_IDS, id)
}

// Always runs on its chord, even when another command shares it, so the
// palette stays reachable to fix the conflict
export const PALETTE_COMMANDS: CommandId = 'palette.commands'

// The content search's default key, which Files also handles itself
export const SEARCH_CONTENT_KEY = 'Mod+Shift+F'

const MODIFIERS = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'] as const
type Modifier = (typeof MODIFIERS)[number]

// Keys a chord can end with, beyond A-Z, 0-9 and F1-F12: their
// KeyboardEvent.code, and how they are shown
const NAMED_KEYS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Enter: 'Enter',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Escape: 'Esc',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
}

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/

function isKey(key: string): boolean {
  return (
    /^[A-Z0-9]$/.test(key) ||
    FUNCTION_KEY.test(key) ||
    Object.hasOwn(NAMED_KEYS, key)
  )
}

// The key of a KeyboardEvent.code ("KeyP" → "P", "Digit1" → "1"), or
// undefined for a modifier or a key a chord cannot use
export function keyFromCode(code: string): string | undefined {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code)
  if (m) return m[1] ?? m[2]
  return isKey(code) ? code : undefined
}

interface Parts {
  mods: Set<Modifier>
  key: string
}

function split(chord: string): Parts | undefined {
  const tokens = chord.split('+')
  const key = tokens.pop()
  if (!key || !isKey(key)) return
  const mods = new Set<Modifier>()
  for (const t of tokens) {
    if (!(MODIFIERS as readonly string[]).includes(t)) return
    if (mods.has(t as Modifier)) return
    mods.add(t as Modifier)
  }
  return { mods, key }
}

function join({ mods, key }: Parts): string {
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+')
}

// A chord holds Ctrl or Meta (Alt and Shift only with them), or is a
// function key: anything else would take a character while typing
function usable({ mods, key }: Parts): boolean {
  return (
    mods.has('Mod') ||
    mods.has('Ctrl') ||
    mods.has('Meta') ||
    FUNCTION_KEY.test(key)
  )
}

// The normalized chord, or undefined when the text is not one
export function parseChord(chord: string): string | undefined {
  const parts = split(chord)
  return parts && usable(parts) ? join(parts) : undefined
}

// The chord a key press makes, or undefined when it is not one: a modifier
// alone, a key without Ctrl/Meta (other than F1-F12), or AltGr, which
// types a character on many layouts
export function chordFromEvent(
  e: Pick<
    KeyboardEvent,
    'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'getModifierState'
  >,
  apple: boolean,
): string | undefined {
  if (e.getModifierState?.('AltGraph')) return
  const key = keyFromCode(e.code)
  if (!key) return
  const mods = new Set<Modifier>()
  if (apple) {
    if (e.metaKey) mods.add('Mod')
    if (e.ctrlKey) mods.add('Ctrl')
  } else {
    if (e.ctrlKey) mods.add('Mod')
    if (e.metaKey) mods.add('Meta')
  }
  if (e.altKey) mods.add('Alt')
  if (e.shiftKey) mods.add('Shift')
  const parts = { mods, key }
  return usable(parts) ? join(parts) : undefined
}

const APPLE_SYMBOLS: Record<Modifier, string> = {
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Mod: '⌘',
  Meta: '⌘',
}

// Apple writes the modifiers as symbols in this order
const APPLE_ORDER: Modifier[] = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta']

// How a chord is shown: "⌘⇧P" on Apple platforms, "Ctrl+Shift+P" elsewhere
export function formatChord(chord: string, apple: boolean): string {
  const parts = split(chord)
  if (!parts) return chord
  const key = NAMED_KEYS[parts.key] ?? parts.key
  if (apple) {
    const mods = APPLE_ORDER.filter((m) => parts.mods.has(m))
    return mods.map((m) => APPLE_SYMBOLS[m]).join('') + key
  }
  const names = MODIFIERS.filter((m) => parts.mods.has(m)).map((m) =>
    m === 'Mod' ? 'Ctrl' : m === 'Meta' ? 'Win' : m,
  )
  return [...names, key].join('+')
}

// Chords the browser handles before the page sees them, or that close or
// open a window or tab
const BROWSER_KEYS = [
  'Mod+W',
  'Mod+T',
  'Mod+N',
  'Mod+Q',
  'Mod+Shift+T',
  'Mod+Shift+N',
  'Mod+Shift+W',
]
// Ctrl+Tab switches browser tabs on every platform (Mod is Ctrl off Apple)
const BROWSER_TAB_KEYS = ['Ctrl+Tab', 'Ctrl+Shift+Tab']
const TEXT_KEYS = ['Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z']

// Why a chord cannot be assigned, or undefined when it can: the browser
// keeps it, or the editor, the terminal or text editing uses it
export function isRefusedChord(
  chord: string,
  apple: boolean,
): string | undefined {
  const tabKeys = apple
    ? BROWSER_TAB_KEYS
    : BROWSER_TAB_KEYS.map((k) => k.replace('Ctrl', 'Mod'))
  if (BROWSER_KEYS.includes(chord) || tabKeys.includes(chord))
    return 'The browser keeps this key'
  if (chord === 'Mod+S') return 'Used by the editor'
  // The terminal's copy and paste keys
  if (!apple && (chord === 'Mod+Shift+C' || chord === 'Mod+Shift+V'))
    return 'Used by the terminal'
  if (TEXT_KEYS.includes(chord)) return 'Used to edit text'
}

// Keys xterm sends nothing for with Cmd: letters, digits and punctuation
// (with Cmd it still sends Enter, Backspace, Escape, the arrows, F-keys...)
const CHARACTER_KEYS = new Set([
  'Comma',
  'Period',
  'Slash',
  'Semicolon',
  'Quote',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Minus',
  'Equal',
  'Backquote',
])

// Whether a chord may also run while the terminal has focus: only chords
// xterm sends nothing for and the terminal does not use, so no byte meant
// for the pane is taken. Ctrl+Shift+letter (but C and V, the copy and paste
// keys), or on Apple Cmd (and maybe Alt, Shift) with a character key.
export function canRunInTerminal(chord: string, apple: boolean): boolean {
  const parts = split(chord)
  if (!parts || isRefusedChord(chord, apple)) return false
  if (apple)
    return (
      parts.mods.has('Mod') &&
      !parts.mods.has('Ctrl') &&
      (/^[A-Z0-9]$/.test(parts.key) || CHARACTER_KEYS.has(parts.key))
    )
  return (
    parts.mods.size === 2 &&
    parts.mods.has('Mod') &&
    parts.mods.has('Shift') &&
    /^[A-Z]$/.test(parts.key)
  )
}

// What the user changed for one command: key undefined keeps the default,
// null turns the shortcut off
export interface SavedShortcut {
  key?: string | null
  inTerminal?: boolean
}

export type SavedShortcuts = Partial<Record<CommandId, SavedShortcut>>

export const SHORTCUTS_VERSION = 1

// The saved overrides in a stored value, keeping only what is valid: a
// known command id, a usable chord the app does not refuse, a boolean
// inTerminal. Anything else is dropped (never written back here).
export function readSaved(raw: unknown, apple: boolean): SavedShortcuts {
  const out: SavedShortcuts = {}
  if (!raw || typeof raw !== 'object') return out
  const { v, keys } = raw as { v?: unknown; keys?: unknown }
  if (v !== SHORTCUTS_VERSION || !keys || typeof keys !== 'object') return out
  for (const [id, value] of Object.entries(keys)) {
    if (!isCommandId(id) || !value || typeof value !== 'object') continue
    const entry: SavedShortcut = {}
    const { key, inTerminal } = value as Record<string, unknown>
    if (key === null) entry.key = null
    else if (typeof key === 'string') {
      const chord = parseChord(key)
      if (chord && !isRefusedChord(chord, apple)) entry.key = chord
    }
    if (typeof inTerminal === 'boolean') entry.inTerminal = inTerminal
    if (Object.keys(entry).length) out[id] = entry
  }
  return out
}

// What a command brings: its id, its default chord and whether that chord
// runs in the terminal by default
export interface ShortcutDefault {
  id: CommandId
  defaultKey?: string
  inTerminal?: boolean
}

export interface ResolvedShortcut {
  key?: string
  inTerminal: boolean
  custom: boolean // the user set (or removed) this command's key
  replacedBy?: CommandId // the default key went to this command's override
}

export interface Keymap {
  byId: Partial<Record<CommandId, ResolvedShortcut>>
  byChord: Map<string, CommandId[]>
}

// The chord each command answers to: the user's own key wins; a default
// key another command was given by the user is dropped from its owner
export function resolveKeymap(
  defaults: ShortcutDefault[],
  saved: SavedShortcuts,
  apple: boolean,
): Keymap {
  const overrides = new Map<string, CommandId>()
  for (const d of defaults) {
    const key = saved[d.id]?.key
    if (key) overrides.set(key, d.id)
  }
  const byId: Keymap['byId'] = {}
  const byChord = new Map<string, CommandId[]>()
  for (const d of defaults) {
    const s = saved[d.id]
    const custom = s?.key !== undefined
    let key: string | undefined
    let replacedBy: CommandId | undefined
    if (custom) key = s?.key ?? undefined
    else if (d.defaultKey) {
      const taker = overrides.get(d.defaultKey)
      if (taker && taker !== d.id) replacedBy = taker
      else key = d.defaultKey
    }
    const inTerminal =
      !!key && (s?.inTerminal ?? !!d.inTerminal) && canRunInTerminal(key, apple)
    byId[d.id] = { key, inTerminal, custom, replacedBy }
    if (key) byChord.set(key, [...(byChord.get(key) ?? []), d.id])
  }
  return { byId, byChord }
}

// The commands sharing each chord with another
export function findConflicts(keymap: Keymap): Map<CommandId, CommandId[]> {
  const out = new Map<CommandId, CommandId[]>()
  for (const ids of keymap.byChord.values()) {
    if (ids.length < 2) continue
    for (const id of ids)
      out.set(
        id,
        ids.filter((other) => other !== id),
      )
  }
  return out
}

// The command a chord runs: none when several share it, but the palette
export function commandForChord(
  keymap: Keymap,
  chord: string,
): CommandId | undefined {
  const ids = keymap.byChord.get(chord)
  if (!ids) return
  if (ids.length === 1) return ids[0]
  return ids.includes(PALETTE_COMMANDS) ? PALETTE_COMMANDS : undefined
}
