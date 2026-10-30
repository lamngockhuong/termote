import type { ResizeDirection, SplitDirection } from '../hooks/use-mux-api'
import type { ShortcutCommand } from '../hooks/use-shortcuts'
import type { MessageKey } from '../i18n/messages/en'
import {
  CHANGES_VIEW_ID,
  CHAT_VIEW_ID,
  FILES_VIEW_ID,
  TASKS_VIEW_ID,
} from '../view-ids'
import { APP_INFO } from './app-info'
import { type CommandId, SEARCH_CONTENT_KEY } from './shortcuts'

// Where the palette opens: files (no prefix), commands (>), a line of the
// open file (:), tabs and panes (@)
export type PaletteMode = 'files' | 'commands' | 'line' | 'sessions'

// The group a command is listed under, as the key of its name
export type CommandCategory =
  | 'tasks.category.palette'
  | 'tasks.category.view'
  | 'tasks.category.files'
  | 'tasks.category.tabs'
  | 'tasks.category.panes'
  | 'tasks.category.agent'
  | 'tasks.category.terminal'
  | 'tasks.category.app'

// A command of the palette, which a shortcut can run too. Shown even when
// it cannot run, then with the reason.
export interface AppCommand extends ShortcutCommand {
  // Keys of the messages, read through t() where shown
  title: MessageKey
  category: CommandCategory
  disabledReason?: MessageKey
  // Run from the palette, focus goes back where it was before (the command
  // moves it nowhere, or opens a dialog that gives it back there on close);
  // otherwise it stays where the command puts it
  restoreFocus?: boolean
}

export type ThemeChoice = 'light' | 'dark' | 'system'

// What the commands are built from: the app's state and its actions
export interface AppCommandContext {
  apple: boolean
  readOnly: boolean
  // Views of the switcher, and of the desktop side panel, offered now
  viewIds: string[]
  panelIds: string[]
  sidePanelId: string | null
  // The pane's agent can be started from its Chat view
  startOffered: boolean
  hasAgent: boolean
  devices: boolean
  canFullscreen: boolean
  // A focus window (focus-mode.ts): it shows one target, so commands that
  // move to another session, tab or screen are off
  focus?: boolean
  // The tabs before and after the current one in its group
  previousTab?: string
  nextTab?: string
  // The panes before and after the one the page works on, in the tab
  previousPane?: string
  nextPane?: string
  selectPane: (id: string) => void
  // The backend can split, zoom, swap and resize panes (caps.paneLayout)
  paneLayout: boolean
  // The page shows one pane, not the tab's layout (caps.paneStream)
  paneStream: boolean
  // The pane shown has a pane after it to swap with
  canSwapNext: boolean
  // Desktop: the resize commands are offered
  desktop: boolean
  splitPane: (direction: SplitDirection) => void
  zoomPane: () => void
  swapNextPane: () => void
  resizePane: (direction: ResizeDirection) => void
  openPalette: (mode: PaletteMode) => void
  changeView: (id: string) => void
  // The terminal view, focused
  showTerminal: () => void
  // The Chat view, its message box focused when it has one
  showChat: () => void
  togglePanel: (id: string | null) => void
  openOverview: () => void
  searchContent: () => void
  newTab: () => void
  selectTab: (id: string) => void
  openSettings: (group?: string) => void
  openHelp: () => void
  openAbout: () => void
  toggleSidebar: () => void
  toggleFullscreen: () => void
  // What is on screen in a window of its own; unset where no link names it
  openWindow?: () => void
  fontIncrease: () => void
  fontDecrease: () => void
  setTheme: (theme: ThemeChoice) => void
}

const VIEW_ONLY: MessageKey = 'tasks.commandOff.viewOnly'
const NO_FILES: MessageKey = 'tasks.commandOff.noFiles'
const IN_FOCUS: MessageKey = 'tasks.commandOff.inFocus'
const NO_LAYOUT: MessageKey = 'tasks.commandOff.noLayout'
const DESKTOP_ONLY: MessageKey = 'tasks.commandOff.desktopOnly'

// Commands that leave a focus window's target (or fold a sidebar it has not)
const LEAVE_FOCUS = new Set([
  'palette.sessions',
  'view.overview',
  'tab.new',
  'tab.previous',
  'tab.next',
  'app.toggleSidebar',
  'window.openNew',
])

export function buildAppCommands(ctx: AppCommandContext): AppCommand[] {
  const commands = allCommands(ctx)
  if (!ctx.focus) return commands
  return commands.map((c) =>
    LEAVE_FOCUS.has(c.id) ? { ...c, disabledReason: IN_FOCUS } : c,
  )
}

function allCommands(ctx: AppCommandContext): AppCommand[] {
  const panel = (id: string, title: MessageKey): AppCommand => ({
    id: id === FILES_VIEW_ID ? 'view.filesPanel' : 'view.changesPanel',
    title,
    category: 'tasks.category.view',
    disabledReason: ctx.panelIds.includes(id) ? undefined : NO_FILES,
    restoreFocus: true,
    run: () => ctx.togglePanel(ctx.sidePanelId === id ? null : id),
  })
  const theme = (t: ThemeChoice, title: MessageKey): AppCommand => ({
    id: `theme.${t}`,
    title,
    category: 'tasks.category.app',
    restoreFocus: true,
    run: () => ctx.setTheme(t),
  })
  // Pane layout: refused to a view-only device and where the backend has
  // none; resizing only on a desktop
  const layoutReason = ctx.readOnly
    ? VIEW_ONLY
    : ctx.paneLayout
      ? undefined
      : NO_LAYOUT
  const pane = (
    id: CommandId,
    title: MessageKey,
    run: () => void,
    reason = layoutReason,
  ): AppCommand => ({
    id,
    title,
    category: 'tasks.category.panes',
    disabledReason: reason,
    restoreFocus: true,
    run,
  })
  // Zoom, swap and resize arrange the tab: refused where the page shows one
  // pane, which they would not change
  const arrangeReason =
    layoutReason ?? (ctx.paneStream ? DESKTOP_ONLY : undefined)
  const resize = (
    id: CommandId,
    title: MessageKey,
    direction: ResizeDirection,
  ) => pane(id, title, () => ctx.resizePane(direction), arrangeReason)
  let agentReason: MessageKey | undefined
  if (!ctx.startOffered)
    agentReason = ctx.readOnly
      ? VIEW_ONLY
      : ctx.hasAgent
        ? 'tasks.commandOff.hasAgent'
        : 'tasks.commandOff.cannotStart'
  return [
    {
      id: 'palette.quickOpen',
      title: 'tasks.command.quickOpen',
      category: 'tasks.category.palette',
      defaultKey: 'Mod+P',
      // Cmd+P never reaches the pane; Ctrl+P is the terminal's
      inTerminal: ctx.apple,
      run: () => ctx.openPalette('files'),
    },
    {
      id: 'palette.commands',
      title: 'tasks.command.commands',
      category: 'tasks.category.palette',
      defaultKey: 'Mod+Shift+P',
      inTerminal: true,
      run: () => ctx.openPalette('commands'),
    },
    {
      id: 'palette.goToLine',
      title: 'tasks.command.goToLine',
      category: 'tasks.category.palette',
      run: () => ctx.openPalette('line'),
    },
    {
      id: 'palette.sessions',
      title: 'tasks.command.sessions',
      category: 'tasks.category.palette',
      run: () => ctx.openPalette('sessions'),
    },
    {
      id: 'view.terminal',
      title: 'tasks.command.terminal',
      category: 'tasks.category.view',
      run: ctx.showTerminal,
    },
    {
      id: 'view.chat',
      title: 'tasks.command.chat',
      category: 'tasks.category.view',
      disabledReason: ctx.viewIds.includes(CHAT_VIEW_ID)
        ? undefined
        : 'tasks.commandOff.noChat',
      run: ctx.showChat,
    },
    {
      id: 'view.tasks',
      title: 'tasks.command.tasks',
      category: 'tasks.category.view',
      disabledReason: ctx.viewIds.includes(TASKS_VIEW_ID)
        ? undefined
        : ctx.readOnly
          ? VIEW_ONLY
          : 'tasks.commandOff.noTasks',
      run: () => ctx.changeView(TASKS_VIEW_ID),
    },
    panel(FILES_VIEW_ID, 'tasks.command.filesPanel'),
    panel(CHANGES_VIEW_ID, 'tasks.command.changesPanel'),
    {
      id: 'view.overview',
      title: 'tasks.command.overview',
      category: 'tasks.category.view',
      run: ctx.openOverview,
    },
    {
      id: 'files.searchContent',
      title: 'tasks.command.searchContent',
      category: 'tasks.category.files',
      defaultKey: SEARCH_CONTENT_KEY,
      disabledReason: ctx.panelIds.includes(FILES_VIEW_ID)
        ? undefined
        : NO_FILES,
      run: ctx.searchContent,
    },
    {
      id: 'tab.new',
      title: 'tasks.command.newTab',
      category: 'tasks.category.tabs',
      disabledReason: ctx.readOnly ? VIEW_ONLY : undefined,
      restoreFocus: true,
      run: ctx.newTab,
    },
    {
      id: 'tab.previous',
      title: 'tasks.command.previousTab',
      category: 'tasks.category.tabs',
      disabledReason: ctx.previousTab
        ? undefined
        : 'tasks.commandOff.noPrevious',
      restoreFocus: true,
      run: () => ctx.previousTab && ctx.selectTab(ctx.previousTab),
    },
    {
      id: 'tab.next',
      title: 'tasks.command.nextTab',
      category: 'tasks.category.tabs',
      disabledReason: ctx.nextTab ? undefined : 'tasks.commandOff.noNext',
      restoreFocus: true,
      run: () => ctx.nextTab && ctx.selectTab(ctx.nextTab),
    },
    {
      id: 'pane.previous',
      title: 'tasks.command.previousPane',
      category: 'tasks.category.panes',
      disabledReason: ctx.previousPane
        ? undefined
        : 'tasks.commandOff.noPreviousPane',
      run: () => ctx.previousPane && ctx.selectPane(ctx.previousPane),
    },
    {
      id: 'pane.next',
      title: 'tasks.command.nextPane',
      category: 'tasks.category.panes',
      disabledReason: ctx.nextPane ? undefined : 'tasks.commandOff.noNextPane',
      run: () => ctx.nextPane && ctx.selectPane(ctx.nextPane),
    },
    pane('pane.splitRight', 'tasks.command.splitRight', () =>
      ctx.splitPane('right'),
    ),
    pane('pane.splitDown', 'tasks.command.splitDown', () =>
      ctx.splitPane('down'),
    ),
    pane('pane.zoom', 'tasks.command.zoom', ctx.zoomPane, arrangeReason),
    pane(
      'pane.swapNext',
      'tasks.command.swapNext',
      ctx.swapNextPane,
      arrangeReason ??
        (ctx.canSwapNext ? undefined : 'tasks.commandOff.noPaneAfter'),
    ),
    ...(ctx.desktop
      ? [
          resize('pane.resizeLeft', 'tasks.command.resizeLeft', 'left'),
          resize('pane.resizeRight', 'tasks.command.resizeRight', 'right'),
          resize('pane.resizeUp', 'tasks.command.resizeUp', 'up'),
          resize('pane.resizeDown', 'tasks.command.resizeDown', 'down'),
        ]
      : []),
    {
      id: 'agent.start',
      title: 'tasks.command.agentStart',
      category: 'tasks.category.agent',
      disabledReason: agentReason,
      run: () => ctx.changeView(CHAT_VIEW_ID),
    },
    {
      id: 'settings.open',
      title: 'tasks.command.settings',
      category: 'tasks.category.app',
      restoreFocus: true,
      run: () => ctx.openSettings(),
    },
    {
      id: 'settings.devices',
      title: 'tasks.command.settingsDevices',
      category: 'tasks.category.app',
      disabledReason: ctx.devices ? undefined : 'tasks.commandOff.noDevices',
      restoreFocus: true,
      run: () => ctx.openSettings('devices'),
    },
    {
      id: 'settings.shortcuts',
      title: 'tasks.command.settingsShortcuts',
      category: 'tasks.category.app',
      restoreFocus: true,
      run: () => ctx.openSettings('shortcuts'),
    },
    {
      id: 'app.help',
      title: 'tasks.command.help',
      category: 'tasks.category.app',
      restoreFocus: true,
      run: ctx.openHelp,
    },
    {
      id: 'app.about',
      title: 'tasks.command.about',
      category: 'tasks.category.app',
      restoreFocus: true,
      run: ctx.openAbout,
    },
    {
      id: 'app.docs',
      title: 'tasks.command.docs',
      category: 'tasks.category.app',
      restoreFocus: true,
      run: () => {
        window.open(APP_INFO.links.docs, '_blank', 'noopener,noreferrer')
      },
    },
    {
      id: 'app.toggleSidebar',
      title: 'tasks.command.toggleSidebar',
      category: 'tasks.category.app',
      restoreFocus: true,
      run: ctx.toggleSidebar,
    },
    {
      id: 'app.fullscreen',
      title: 'tasks.command.fullscreen',
      category: 'tasks.category.app',
      disabledReason: ctx.canFullscreen
        ? undefined
        : 'tasks.commandOff.noFullscreen',
      restoreFocus: true,
      run: ctx.toggleFullscreen,
    },
    {
      id: 'window.openNew',
      title: 'tasks.command.openWindow',
      category: 'tasks.category.app',
      disabledReason: ctx.openWindow ? undefined : 'tasks.commandOff.noLink',
      run: () => ctx.openWindow?.(),
    },
    {
      id: 'terminal.fontIncrease',
      title: 'tasks.command.fontIncrease',
      category: 'tasks.category.terminal',
      restoreFocus: true,
      run: ctx.fontIncrease,
    },
    {
      id: 'terminal.fontDecrease',
      title: 'tasks.command.fontDecrease',
      category: 'tasks.category.terminal',
      restoreFocus: true,
      run: ctx.fontDecrease,
    },
    theme('light', 'tasks.command.themeLight'),
    theme('dark', 'tasks.command.themeDark'),
    theme('system', 'tasks.command.themeSystem'),
  ]
}
