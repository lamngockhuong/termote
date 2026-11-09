import { useCallback, useSyncExternalStore } from 'react'
import { type LanguageSetting, resolveLanguage } from '../i18n'
import type { MessageKey } from '../i18n/messages/en'
import { DEFAULT_UI_STYLE, resolveUiStyle, type UiStyle } from '../ui-style'
import {
  DEFAULT_STUCK_MINUTES,
  resolveStuckMinutes,
} from '../utils/agent-stuck'
import { hiddenChars } from '../utils/prompt-templates'
import {
  DEFAULT_SIDEBAR_FILTER,
  resolveSidebarFilter,
  type SidebarFilter,
} from '../utils/session-filter'
import {
  SIDE_PANEL_DEFAULT,
  SIDE_PANEL_MIN,
  SIDE_PANEL_SAVED_MAX,
} from '../utils/side-panel-width'
import {
  DEFAULT_SIDEBAR_LAYOUT,
  resolveSidebarLayout,
  type SidebarLayout,
} from '../utils/sidebar-layout'
import { clampSidebarWidth, SIDEBAR_DEFAULT } from '../utils/sidebar-width'
import {
  DEFAULT_TOOLBAR_POSITION,
  resolveToolbarPosition,
  type ToolbarPosition,
} from '../utils/toolbar-position'

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

// The refresh intervals Settings offers, in seconds
export const POLL_INTERVAL_OPTIONS = [3, 5, 10, 15, 30, 60, 120, 300]

export function resolvePollInterval(value: unknown): number {
  return POLL_INTERVAL_OPTIONS.includes(value as number) ? (value as number) : 5
}

// A font name of at most this many bytes, without control or hidden
// characters (server/pwa_settings_schema.json)
export const TERMINAL_FONT_MAX = 200

// A saved font is kept as written; a proposed or imported one must also
// pass terminalFontProblem
export function resolveTerminalFont(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// Whether a proposed or imported font cannot be taken: spaces around it,
// longer than TERMINAL_FONT_MAX bytes, or a hidden character
export function terminalFontProblem(font: string): boolean {
  return (
    font.trim() !== font ||
    new TextEncoder().encode(font).length > TERMINAL_FONT_MAX ||
    hiddenChars(font, false).length > 0
  )
}

// A saved width, a whole number within the limits; anything else the
// default (the view narrows it further to fit its row)
export function resolveSidePanelWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return SIDE_PANEL_DEFAULT
  return Math.min(
    Math.max(Math.round(value), SIDE_PANEL_MIN),
    SIDE_PANEL_SAVED_MAX,
  )
}

export function resolveSidebarWidth(value: unknown): number {
  return clampSidebarWidth(value, null)
}

export type ImeSendBehavior = 'send-only' | 'send-enter'

export function resolveImeSendBehavior(value: unknown): ImeSendBehavior {
  return value === 'send-enter' ? 'send-enter' : 'send-only'
}
// The key that sends a chat message with a keyboard (a phone keeps its send
// button, Enter a new line): Ctrl/Cmd+Enter, or Enter alone with Shift+Enter
// for a new line
export type ChatSendKey = 'ctrl-enter' | 'enter'
export type PasteSource = 'clipboard' | 'tmux'

export function resolveChatSendKey(value: unknown): ChatSendKey {
  return value === 'enter' ? 'enter' : 'ctrl-enter'
}

export function resolvePasteSource(value: unknown): PasteSource {
  return value === 'tmux' ? 'tmux' : 'clipboard'
}

export interface Settings {
  imeSendBehavior: ImeSendBehavior
  chatSendKey: ChatSendKey // chat composer on desktop (above)
  toolbarDefaultExpanded: boolean
  disableContextMenu: boolean
  copyOnSelect: boolean // copy the terminal selection when a mouse drag ends
  pollInterval: number // seconds between session list refreshes
  // The welcome screen's version this device has seen (WELCOME_VERSION)
  welcomeSeenVersion: number
  // The app's language, the welcome screen's and the tour's with it
  language: LanguageSetting
  // Dismissed the banner saying the whole app speaks Vietnamese now, or
  // picked a language since (components/language-notice.tsx)
  languageNoticeSeen: boolean
  hasSeenLocalhostNotice: boolean // dismissed the notice of a page opened through localhost
  pasteSource: PasteSource // paste button source: system clipboard or tmux buffer
  showSessionTabs: boolean // show session tabs bar on desktop
  toolbarPosition: ToolbarPosition // desktop: the controls in the header or on a right bar
  terminalFont: string // font installed on this device, tried before the defaults
  uiStyle: UiStyle // visual style of the app chrome (tokens in index.css)
  // herdr: size the pane to this device while it shows it (Caps.driveSize)
  driveTerminalSize: boolean
  // herdr, desktop: a split tab's panes side by side, as the desktop has them
  herdrLayoutView: boolean
  sidebarFilter: SidebarFilter // which sessions the sidebar lists
  sidebarLayout: SidebarLayout // desktop sidebar: tabs under each workspace, or one line each
  sortBlockedFirst: boolean // sessions waiting on the user first in each group
  markdownPreview: boolean // Files: Markdown rendered (else its source)
  markdownEditLayout: MarkdownEditLayout // Files: Markdown being edited (above)
  tablePreview: boolean // Files: CSV/TSV shown as a table (else its source)
  svgPreview: boolean // Files/Changes: an SVG shown as an image (else as text)
  sidePanelWidth: number // desktop Files/Changes panel, in px
  sidebarWidth: number // desktop sidebar, expanded, in px
  findIncludeIgnored: boolean // Files search: a repo's ignored files too
  findExcludes: string[] // Files search: folder names never searched (above)
  searchCase: boolean // Files content search: Match case
  searchWord: boolean // Files content search: Whole word
  searchRegex: boolean // Files content search: a regular expression
  notifyAgents: boolean // notify when an agent is blocked or ends a turn
  appBadge: boolean // the installed app's icon counts the agents waiting on you
  stuckMinutes: number // overview: a working agent quiet this long may be stuck
  showUsageChip: boolean // header: the open pane's agent's context and limits
  showHostChip: boolean // header: CPU, memory and battery of termote's machine
  editorFontSize: number // desktop editor (CodeMirror): px, EDITOR_FONT_SIZES
  editorTabSize: EditorTabSize // desktop editor: columns of a tab, one indent
  editorWrap: boolean // Files/Changes on desktop: lines wrapped by default
  editorVim: boolean // desktop editor: Vim key bindings
  taskHistoryLines: number // Tasks: lines read for Send to agent (above)
}

export const DEFAULTS: Settings = {
  imeSendBehavior: 'send-only',
  chatSendKey: 'ctrl-enter',
  toolbarDefaultExpanded: false,
  disableContextMenu: true,
  copyOnSelect: false,
  pollInterval: 5,
  welcomeSeenVersion: 0,
  language: 'auto',
  languageNoticeSeen: false,
  hasSeenLocalhostNotice: false,
  pasteSource: 'clipboard',
  showSessionTabs: true,
  toolbarPosition: DEFAULT_TOOLBAR_POSITION,
  terminalFont: '',
  uiStyle: DEFAULT_UI_STYLE,
  driveTerminalSize: false,
  herdrLayoutView: true,
  sidebarFilter: DEFAULT_SIDEBAR_FILTER,
  sidebarLayout: DEFAULT_SIDEBAR_LAYOUT,
  sortBlockedFirst: false,
  markdownPreview: true,
  markdownEditLayout: 'split',
  tablePreview: true,
  svgPreview: false,
  sidePanelWidth: SIDE_PANEL_DEFAULT,
  sidebarWidth: SIDEBAR_DEFAULT,
  findIncludeIgnored: false,
  findExcludes: FIND_EXCLUDES_DEFAULT,
  searchCase: false,
  searchWord: false,
  searchRegex: false,
  notifyAgents: false,
  appBadge: true,
  stuckMinutes: DEFAULT_STUCK_MINUTES,
  showUsageChip: true,
  showHostChip: true,
  editorFontSize: 13,
  editorTabSize: 4,
  editorWrap: false,
  editorVim: false,
  taskHistoryLines: TASK_HISTORY_LINES_DEFAULT,
}

// Settings of this device alone: never proposed by an agent nor carried by
// Export/Import. Turning notifications or the badge on asks for a permission
// and subscribes to Web Push in the same click (use-push-subscription.ts),
// which a value written to storage would skip. Equal to deviceOnly in
// server/pwa_settings_schema.json (a test checks).
export const DEVICE_ONLY_KEYS = [
  'welcomeSeenVersion',
  'languageNoticeSeen',
  'hasSeenLocalhostNotice',
  'notifyAgents',
  'appBadge',
] as const satisfies readonly (keyof Settings)[]

type BooleanKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never
}[keyof Settings]

// A saved switch, kept when it is a boolean; otherwise its default
export function resolveBoolean(key: BooleanKey, value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULTS[key]
}

// Each setting's resolver: what a stored (or proposed) value is kept as.
// A value it keeps unchanged is a valid one.
export const SETTING_RESOLVERS: {
  [K in keyof Settings]: (value: unknown) => Settings[K]
} = {
  imeSendBehavior: resolveImeSendBehavior,
  chatSendKey: resolveChatSendKey,
  toolbarDefaultExpanded: (v) => resolveBoolean('toolbarDefaultExpanded', v),
  disableContextMenu: (v) => resolveBoolean('disableContextMenu', v),
  copyOnSelect: (v) => resolveBoolean('copyOnSelect', v),
  pollInterval: resolvePollInterval,
  welcomeSeenVersion: resolveSeenVersion,
  language: resolveLanguage,
  languageNoticeSeen: (v) => resolveBoolean('languageNoticeSeen', v),
  hasSeenLocalhostNotice: (v) => resolveBoolean('hasSeenLocalhostNotice', v),
  pasteSource: resolvePasteSource,
  showSessionTabs: (v) => resolveBoolean('showSessionTabs', v),
  toolbarPosition: resolveToolbarPosition,
  terminalFont: resolveTerminalFont,
  uiStyle: resolveUiStyle,
  driveTerminalSize: (v) => resolveBoolean('driveTerminalSize', v),
  herdrLayoutView: (v) => resolveBoolean('herdrLayoutView', v),
  sidebarFilter: resolveSidebarFilter,
  sidebarLayout: resolveSidebarLayout,
  sortBlockedFirst: (v) => resolveBoolean('sortBlockedFirst', v),
  markdownPreview: (v) => resolveBoolean('markdownPreview', v),
  markdownEditLayout: resolveMarkdownEditLayout,
  tablePreview: (v) => resolveBoolean('tablePreview', v),
  svgPreview: (v) => resolveBoolean('svgPreview', v),
  sidePanelWidth: resolveSidePanelWidth,
  sidebarWidth: resolveSidebarWidth,
  findIncludeIgnored: (v) => resolveBoolean('findIncludeIgnored', v),
  findExcludes: resolveFindExcludes,
  searchCase: (v) => resolveBoolean('searchCase', v),
  searchWord: (v) => resolveBoolean('searchWord', v),
  searchRegex: (v) => resolveBoolean('searchRegex', v),
  notifyAgents: (v) => resolveBoolean('notifyAgents', v),
  appBadge: (v) => resolveBoolean('appBadge', v),
  stuckMinutes: resolveStuckMinutes,
  showUsageChip: (v) => resolveBoolean('showUsageChip', v),
  showHostChip: (v) => resolveBoolean('showHostChip', v),
  editorFontSize: resolveEditorFontSize,
  editorTabSize: resolveEditorTabSize,
  editorWrap: (v) => resolveBoolean('editorWrap', v),
  editorVim: (v) => resolveBoolean('editorVim', v),
  taskHistoryLines: resolveTaskHistoryLines,
}

// Listeners for useSyncExternalStore
const listeners = new Set<() => void>()

function notifyListeners() {
  for (const fn of listeners) fn()
}

// Another tab of this browser changed the settings: getSnapshot reads them
// again
function onStorage(e: StorageEvent) {
  if (e.key === STORAGE_KEY || e.key === null) notifyListeners()
}

function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}

// Every setting through its resolver: an edited or future config may hold
// anything
function resolveSettings(raw: Record<string, unknown>): Settings {
  // A key this version does not know (a newer one wrote it) stays
  const out: Record<string, unknown> = { ...DEFAULTS, ...raw }
  for (const [key, resolve] of Object.entries(SETTING_RESOLVERS))
    out[key] = (resolve as (v: unknown) => unknown)(
      Object.hasOwn(raw, key) ? raw[key] : undefined,
    )
  return out as unknown as Settings
}

// Snapshot for useSyncExternalStore (stable reference when unchanged)
let cachedJson = ''
let cachedSettings = DEFAULTS

function getSnapshot(): Settings {
  // Blocked storage (a private window, site data off) reads as no settings
  let json = ''
  try {
    json = localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {}
  if (json !== cachedJson) {
    cachedJson = json
    try {
      const parsed: unknown = json ? JSON.parse(json) : {}
      cachedSettings =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? resolveSettings(parsed as Record<string, unknown>)
          : DEFAULTS
    } catch {
      cachedSettings = DEFAULTS
    }
  }
  return cachedSettings
}

// The settings now, for code outside React (settings-registry.ts)
export function readSettings(): Settings {
  return getSnapshot()
}

// Change several settings at once, each through its resolver
export function writeSettingsPatch(patch: Partial<Settings>) {
  writeSettings(resolveSettings({ ...getSnapshot(), ...patch }))
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
      writeSettings({
        ...cachedSettings,
        // A language picked now, in Settings or on the welcome screen, is
        // not one to tell about: only a 'vi' saved before the whole app
        // spoke it shows the banner
        ...(key === 'language' && { languageNoticeSeen: true }),
        [key]: value,
      })
    },
    [],
  )

  return { settings, updateSetting }
}
