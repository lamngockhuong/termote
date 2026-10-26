import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import { isApplePlatform } from '../utils/platform'
import {
  type CommandId,
  chordFromEvent,
  commandForChord,
  type Keymap,
  readSaved,
  resolveKeymap,
  type SavedShortcut,
  type SavedShortcuts,
  SHORTCUTS_VERSION,
  type ShortcutDefault,
} from '../utils/shortcuts'

// One per browser, like termote-settings: a preference of this device, not
// data of a server, so it stays after signing out
export const SHORTCUTS_KEY = 'termote-shortcuts'

// A command the dispatcher can run on its chord
export interface ShortcutCommand extends ShortcutDefault {
  disabledReason?: string
  run: () => void
}

const listeners = new Set<() => void>()
let cached: SavedShortcuts | undefined

function load(): SavedShortcuts {
  try {
    const json = localStorage.getItem(SHORTCUTS_KEY)
    return json ? readSaved(JSON.parse(json), isApplePlatform()) : {}
  } catch {
    return {}
  }
}

function notify() {
  for (const fn of listeners) fn()
}

function getSnapshot(): SavedShortcuts {
  cached ??= load()
  return cached
}

// Another tab of this browser changed the shortcuts
function onStorage(e: StorageEvent) {
  if (e.key !== SHORTCUTS_KEY && e.key !== null) return
  cached = undefined
  notify()
}

function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}

function save(next: SavedShortcuts) {
  cached = next
  try {
    if (Object.keys(next).length)
      localStorage.setItem(
        SHORTCUTS_KEY,
        JSON.stringify({ v: SHORTCUTS_VERSION, keys: next }),
      )
    else localStorage.removeItem(SHORTCUTS_KEY)
  } catch {
    // storage full or blocked: the change holds until the page reloads
  }
  notify()
}

// Change one command's key (null: no key) or whether it runs in the
// terminal; what is left out stays as it was
export function setShortcut(id: CommandId, change: SavedShortcut) {
  save({ ...getSnapshot(), [id]: { ...getSnapshot()[id], ...change } })
}

// Back to the command's default key
export function resetShortcut(id: CommandId) {
  const { [id]: _, ...rest } = getSnapshot()
  save(rest)
}

export function resetAllShortcuts() {
  save({})
}

export function useSavedShortcuts(): SavedShortcuts {
  /* v8 ignore next */
  return useSyncExternalStore(subscribe, getSnapshot, () => ({}))
}

// The keymap of these commands with the user's changes applied
export function useKeymap(commands: ShortcutDefault[]): Keymap {
  const saved = useSavedShortcuts()
  return useMemo(
    () => resolveKeymap(commands, saved, isApplePlatform()),
    [commands, saved],
  )
}

// The key one command answers to now, for a view that handles it itself:
// its default unless the user changed it or gave it to another command
export function useShortcutKey(
  id: CommandId,
  defaultKey: string,
): string | undefined {
  const saved = useSavedShortcuts()
  return useMemo(() => {
    const others = Object.keys(saved).filter((k) => k !== id) as CommandId[]
    const keymap = resolveKeymap(
      [{ id, defaultKey }, ...others.map((other) => ({ id: other }))],
      saved,
      isApplePlatform(),
    )
    return keymap.byId[id]?.key
  }, [id, defaultKey, saved])
}

interface Active {
  keymap: Keymap
  commands: Map<CommandId, ShortcutCommand>
  apple: boolean
}

// What the dispatcher runs now, for the terminal's key handler
let active: Active | undefined

function runnable(a: Active, chord: string | undefined) {
  const id = chord ? commandForChord(a.keymap, chord) : undefined
  const cmd = id ? a.commands.get(id) : undefined
  return cmd && !cmd.disabledReason ? cmd : undefined
}

// For xterm's key handler: true when this key press runs a command marked
// to run in the terminal, so xterm leaves it alone. The press goes on to
// the window, where the dispatcher runs the command.
export function terminalShortcut(ev: KeyboardEvent): boolean {
  if (!active || ev.type !== 'keydown') return false
  const chord = chordFromEvent(ev, active.apple)
  const cmd = runnable(active, chord)
  return !!cmd && !!active.keymap.byId[cmd.id]?.inTerminal
}

// Places a command shortcut never runs from: there the chord is only kept
// from the browser (Ctrl+P in a dialog would open the print dialog)
const BLOCKED =
  'dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[inert]'

// The one listener for app shortcuts, on the window in the bubble phase so
// a focused element's own keys (Files, the editor, Vim) come first. In
// the terminal only commands marked to run there.
export function useShortcutDispatcher(
  commands: ShortcutCommand[],
  enabled: boolean,
) {
  const keymap = useKeymap(commands)
  const ref = useRef<Active | undefined>(undefined)
  ref.current = enabled
    ? {
        keymap,
        commands: new Map(commands.map((c) => [c.id, c])),
        apple: isApplePlatform(),
      }
    : undefined
  // The terminal's handler reads what was committed, never a render React
  // dropped
  useLayoutEffect(() => {
    active = ref.current
    return () => {
      active = undefined
    }
  })

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const a = ref.current
      if (!a || e.defaultPrevented || e.repeat || e.isComposing) return
      const chord = chordFromEvent(e, a.apple)
      if (!chord || !a.keymap.byChord.has(chord)) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest(BLOCKED)) {
        e.preventDefault()
        return
      }
      const cmd = runnable(a, chord)
      if (!cmd) return
      if (target?.closest('.xterm') && !a.keymap.byId[cmd.id]?.inTerminal)
        return
      e.preventDefault()
      cmd.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
