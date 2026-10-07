import { useCallback, useSyncExternalStore } from 'react'
import { DEFAULT_UI_STYLE, resolveUiStyle, type UiStyle } from '../ui-style'
import {
  DEFAULT_SIDEBAR_FILTER,
  resolveSidebarFilter,
  type SidebarFilter,
} from '../utils/session-filter'
import { SIDE_PANEL_DEFAULT } from '../utils/side-panel-width'

const STORAGE_KEY = 'termote-settings'

// Directory names a file search never enters for ignored files, nor
// outside a repository: dependencies and build output
export const FIND_EXCLUDES_DEFAULT = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'vendor',
]

// The server takes at most this many excluded names, each one directory
// name of at most 255 bytes (server/files_find.go)
export const FIND_EXCLUDES_MAX = 50
const FIND_EXCLUDE_NAME_MAX = 255

// Why name cannot be an excluded folder, or undefined when it can: one
// directory name, never a path or a pattern
export function findExcludeProblem(name: string): string | undefined {
  if (!name) return 'Enter a folder name'
  if (name === '.' || name === '..' || name.includes('\0'))
    return 'Not a folder name'
  if (/[/\\]/.test(name)) return 'One folder name, not a path'
  if (/[*?[]/.test(name)) return 'A name, not a pattern'
  if (new TextEncoder().encode(name).length > FIND_EXCLUDE_NAME_MAX)
    return 'Name too long'
}

// A saved list, kept only when it is one: valid names, each once, at most
// FIND_EXCLUDES_MAX; anything else is the defaults
export function resolveFindExcludes(value: unknown): string[] {
  if (!Array.isArray(value)) return FIND_EXCLUDES_DEFAULT
  const names = value.filter(
    (v): v is string => typeof v === 'string' && !findExcludeProblem(v),
  )
  return [...new Set(names)].slice(0, FIND_EXCLUDES_MAX)
}

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
  terminalFont: string // font installed on this device, tried before the defaults
  uiStyle: UiStyle // visual style of the app chrome (tokens in index.css)
  // herdr: size the pane to this device while it shows it (Caps.driveSize)
  driveTerminalSize: boolean
  sidebarFilter: SidebarFilter // which sessions the sidebar lists
  sortBlockedFirst: boolean // sessions waiting on the user first in each group
  markdownPreview: boolean // Files: Markdown rendered (else its source)
  svgPreview: boolean // Files/Changes: an SVG shown as an image (else as text)
  sidePanelWidth: number // desktop Files/Changes panel, in px
  findIncludeIgnored: boolean // Files search: a repo's ignored files too
  findExcludes: string[] // Files search: folder names never searched (above)
  notifyAgents: boolean // notify when an agent is blocked or ends a turn
}

const DEFAULTS: Settings = {
  imeSendBehavior: 'send-only',
  toolbarDefaultExpanded: false,
  disableContextMenu: true,
  pollInterval: 5,
  hasSeenGestureHints: false,
  pasteSource: 'clipboard',
  showSessionTabs: true,
  terminalFont: '',
  uiStyle: DEFAULT_UI_STYLE,
  driveTerminalSize: false,
  sidebarFilter: DEFAULT_SIDEBAR_FILTER,
  sortBlockedFirst: false,
  markdownPreview: true,
  svgPreview: false,
  sidePanelWidth: SIDE_PANEL_DEFAULT,
  findIncludeIgnored: false,
  findExcludes: FIND_EXCLUDES_DEFAULT,
  notifyAgents: false,
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
      const merged: Settings = json
        ? { ...DEFAULTS, ...JSON.parse(json) }
        : DEFAULTS
      // An edited or future config may hold a style this version does not know.
      cachedSettings = {
        ...merged,
        uiStyle: resolveUiStyle(merged.uiStyle),
        sidebarFilter: resolveSidebarFilter(merged.sidebarFilter),
        findIncludeIgnored: merged.findIncludeIgnored === true,
        findExcludes: resolveFindExcludes(merged.findExcludes),
        notifyAgents: merged.notifyAgents === true,
      }
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
