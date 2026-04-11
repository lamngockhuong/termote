import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'termote-settings'

export type ImeSendBehavior = 'send-only' | 'send-enter'
export type PasteSource = 'clipboard' | 'tmux'

export interface Settings {
  imeSendBehavior: ImeSendBehavior
  toolbarDefaultExpanded: boolean
  disableContextMenu: boolean
  pollInterval: number // seconds between session list refreshes
  hasSeenGestureHints: boolean // first-time gesture hints overlay
  pasteSource: PasteSource // paste button source: system clipboard or tmux buffer
  showSessionTabs: boolean // show session tabs bar on desktop
}

const DEFAULTS: Settings = {
  imeSendBehavior: 'send-only',
  toolbarDefaultExpanded: false,
  disableContextMenu: true,
  pollInterval: 5,
  hasSeenGestureHints: false,
  pasteSource: 'clipboard',
  showSessionTabs: true,
}

// Listeners for useSyncExternalStore
const listeners = new Set<() => void>()

function notifyListeners() {
  for (const fn of listeners) fn()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Snapshot for useSyncExternalStore (stable reference when unchanged)
let cachedJson = ''
let cachedSettings = DEFAULTS

function getSnapshot(): Settings {
  const json = localStorage.getItem(STORAGE_KEY) ?? ''
  if (json !== cachedJson) {
    cachedJson = json
    try {
      cachedSettings = json ? { ...DEFAULTS, ...JSON.parse(json) } : DEFAULTS
    } catch {
      cachedSettings = DEFAULTS
    }
  }
  return cachedSettings
}

function writeSettings(settings: Settings) {
  const json = JSON.stringify(settings)
  localStorage.setItem(STORAGE_KEY, json)
  cachedJson = json
  cachedSettings = settings
  notifyListeners()
}

export function useSettings() {
  /* v8 ignore next */
  const settings = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULTS)

  const updateSetting = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      writeSettings({ ...cachedSettings, [key]: value })
    },
    [],
  )

  return { settings, updateSetting }
}
