import { useCallback, useSyncExternalStore } from 'react'
import { type LanguageSetting, resolveLanguage } from '../i18n'
import type { MessageKey } from '../i18n/messages/en'
import { DEFAULT_UI_STYLE, resolveUiStyle, type UiStyle } from '../ui-style'
import {
  DEFAULT_STUCK_MINUTES,
  resolveStuckMinutes,
} from '../utils/agent-stuck'
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

// The message saying why name cannot be an excluded folder, or undefined
// when it can: one directory name, never a path or a pattern
export function findExcludeProblem(name: string): MessageKey | undefined {
  if (!name) return 'settings.excluded.empty'
  if (name === '.' || name === '..' || name.includes('\0'))
    return 'settings.excluded.notName'
  if (/[/\\]/.test(name)) return 'settings.excluded.path'
  if (/[*?[]/.test(name)) return 'settings.excluded.pattern'
  if (new TextEncoder().encode(name).length > FIND_EXCLUDE_NAME_MAX)
    return 'settings.excluded.tooLong'
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

// The sizes the desktop editor's text can be, in px
export const EDITOR_FONT_SIZES = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
export const EDITOR_TAB_SIZES = [2, 4, 8] as const
export type EditorTabSize = (typeof EDITOR_TAB_SIZES)[number]

// A saved editor font size, kept only when it is one of EDITOR_FONT_SIZES
export function resolveEditorFontSize(value: unknown): number {
  return EDITOR_FONT_SIZES.includes(value as number) ? (value as number) : 13
}

export function resolveEditorTabSize(value: unknown): EditorTabSize {
  return EDITOR_TAB_SIZES.includes(value as EditorTabSize)
    ? (value as EditorTabSize)
    : 4
}

// Lines of a task's tab read to find its run's output for Send to agent
// (only the part between the run's markers is sent); the pane text route
// takes up to PANE_TEXT_MAX_LINES
export const TASK_HISTORY_LINES_DEFAULT = 400
export const TASK_HISTORY_LINES_MIN = 100
export const TASK_HISTORY_LINES_MAX = 5000
// What Settings offers
export const TASK_HISTORY_LINE_CHOICES = [100, 200, 400, 1000, 2000, 5000]

// A saved line count, kept when it is a whole number in range
export function resolveTaskHistoryLines(value: unknown): number {
  return Number.isInteger(value) &&
    (value as number) >= TASK_HISTORY_LINES_MIN &&
    (value as number) <= TASK_HISTORY_LINES_MAX
    ? (value as number)
    : TASK_HISTORY_LINES_DEFAULT
}

// How a Markdown file being edited shows: its source, the source with its
// preview beside it, or the preview alone (the editor kept, hidden)
export const MARKDOWN_EDIT_LAYOUTS = ['source', 'split', 'preview'] as const
export type MarkdownEditLayout = (typeof MARKDOWN_EDIT_LAYOUTS)[number]

export function resolveMarkdownEditLayout(value: unknown): MarkdownEditLayout {
  return MARKDOWN_EDIT_LAYOUTS.includes(value as MarkdownEditLayout)
    ? (value as MarkdownEditLayout)
    : 'split'
}

// A saved welcome version, kept when it is a whole number from 0
export function resolveSeenVersion(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0
}

export type ImeSendBehavior = 'send-only' | 'send-enter'
export type PasteSource = 'clipboard' | 'tmux'

export interface Settings {
  imeSendBehavior: ImeSendBehavior
  toolbarDefaultExpanded: boolean
  disableContextMenu: boolean
  copyOnSelect: boolean // copy the terminal selection when a mouse drag ends
  pollInterval: number // seconds between session list refreshes
  // The welcome screen's version this device has seen (WELCOME_VERSION)
  welcomeSeenVersion: number
  // The welcome screen's and the tour's language (later the whole app's)
  language: LanguageSetting
  hasSeenLocalhostNotice: boolean // dismissed the notice of a page opened through localhost
  pasteSource: PasteSource // paste button source: system clipboard or tmux buffer
  showSessionTabs: boolean // show session tabs bar on desktop
  terminalFont: string // font installed on this device, tried before the defaults
  uiStyle: UiStyle // visual style of the app chrome (tokens in index.css)
  // herdr: size the pane to this device while it shows it (Caps.driveSize)
  driveTerminalSize: boolean
  sidebarFilter: SidebarFilter // which sessions the sidebar lists
  sortBlockedFirst: boolean // sessions waiting on the user first in each group
  markdownPreview: boolean // Files: Markdown rendered (else its source)
  markdownEditLayout: MarkdownEditLayout // Files: Markdown being edited (above)
  tablePreview: boolean // Files: CSV/TSV shown as a table (else its source)
  svgPreview: boolean // Files/Changes: an SVG shown as an image (else as text)
  sidePanelWidth: number // desktop Files/Changes panel, in px
  findIncludeIgnored: boolean // Files search: a repo's ignored files too
  findExcludes: string[] // Files search: folder names never searched (above)
  searchCase: boolean // Files content search: Match case
  searchWord: boolean // Files content search: Whole word
  searchRegex: boolean // Files content search: a regular expression
  notifyAgents: boolean // notify when an agent is blocked or ends a turn
  stuckMinutes: number // overview: a working agent quiet this long may be stuck
  showUsageChip: boolean // header: the open pane's agent's context and limits
  editorFontSize: number // desktop editor (CodeMirror): px, EDITOR_FONT_SIZES
  editorTabSize: EditorTabSize // desktop editor: columns of a tab, one indent
  editorWrap: boolean // Files/Changes on desktop: lines wrapped by default
  editorVim: boolean // desktop editor: Vim key bindings
  taskHistoryLines: number // Tasks: lines read for Send to agent (above)
}

const DEFAULTS: Settings = {
  imeSendBehavior: 'send-only',
  toolbarDefaultExpanded: false,
  disableContextMenu: true,
  copyOnSelect: false,
  pollInterval: 5,
  welcomeSeenVersion: 0,
  language: 'auto',
  hasSeenLocalhostNotice: false,
  pasteSource: 'clipboard',
  showSessionTabs: true,
  terminalFont: '',
  uiStyle: DEFAULT_UI_STYLE,
  driveTerminalSize: false,
  sidebarFilter: DEFAULT_SIDEBAR_FILTER,
  sortBlockedFirst: false,
  markdownPreview: true,
  markdownEditLayout: 'split',
  tablePreview: true,
  svgPreview: false,
  sidePanelWidth: SIDE_PANEL_DEFAULT,
  findIncludeIgnored: false,
  findExcludes: FIND_EXCLUDES_DEFAULT,
  searchCase: false,
  searchWord: false,
  searchRegex: false,
  notifyAgents: false,
  stuckMinutes: DEFAULT_STUCK_MINUTES,
  showUsageChip: true,
  editorFontSize: 13,
  editorTabSize: 4,
  editorWrap: false,
  editorVim: false,
  taskHistoryLines: TASK_HISTORY_LINES_DEFAULT,
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
        stuckMinutes: resolveStuckMinutes(merged.stuckMinutes),
        copyOnSelect: merged.copyOnSelect === true,
        showUsageChip: merged.showUsageChip !== false,
        editorFontSize: resolveEditorFontSize(merged.editorFontSize),
        editorTabSize: resolveEditorTabSize(merged.editorTabSize),
        editorWrap: merged.editorWrap === true,
        editorVim: merged.editorVim === true,
        taskHistoryLines: resolveTaskHistoryLines(merged.taskHistoryLines),
        markdownEditLayout: resolveMarkdownEditLayout(
          merged.markdownEditLayout,
        ),
        welcomeSeenVersion: resolveSeenVersion(merged.welcomeSeenVersion),
        language: resolveLanguage(merged.language),
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
