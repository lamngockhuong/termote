import type { ResizeDirection, SplitDirection } from '../hooks/use-mux-api'
import type { ShortcutCommand } from '../hooks/use-shortcuts'
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

export type CommandCategory =
  | 'Palette'
  | 'View'
  | 'Files'
  | 'Tabs'
  | 'Panes'
  | 'Agent'
  | 'Terminal'
  | 'App'

// A command of the palette, which a shortcut can run too. Shown even when
// it cannot run, then with the reason.
export interface AppCommand extends ShortcutCommand {
  title: string
  category: CommandCategory
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

const VIEW_ONLY = 'View only'
const NO_FILES = 'Not available for this pane'
const IN_FOCUS = 'Not in a focus window'
const NO_LAYOUT = 'Not available for this backend'
const DESKTOP_ONLY = 'Changes only the Herdr desktop'

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
  const panel = (id: string, title: string): AppCommand => ({
    id: id === FILES_VIEW_ID ? 'view.filesPanel' : 'view.changesPanel',
    title,
    category: 'View',
    disabledReason: ctx.panelIds.includes(id) ? undefined : NO_FILES,
    restoreFocus: true,
    run: () => ctx.togglePanel(ctx.sidePanelId === id ? null : id),
  })
  const theme = (t: ThemeChoice, title: string): AppCommand => ({
    id: `theme.${t}`,
    title,
    category: 'App',
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
    title: string,
    run: () => void,
    reason = layoutReason,
  ): AppCommand => ({
    id,
    title,
    category: 'Panes',
    disabledReason: reason,
    restoreFocus: true,
    run,
  })
  // Zoom, swap and resize arrange the tab: refused where the page shows one
  // pane, which they would not change
  const arrangeReason =
    layoutReason ?? (ctx.paneStream ? DESKTOP_ONLY : undefined)
  const resize = (id: CommandId, direction: ResizeDirection) =>
    pane(
      id,
      `Resize pane ${direction}`,
      () => ctx.resizePane(direction),
      arrangeReason,
    )
  let agentReason: string | undefined
  if (!ctx.startOffered)
    agentReason = ctx.readOnly
      ? VIEW_ONLY
      : ctx.hasAgent
        ? 'An agent already runs in this pane'
        : 'This pane cannot start an agent'
  return [
    {
      id: 'palette.quickOpen',
      title: 'Go to file',
      category: 'Palette',
      defaultKey: 'Mod+P',
      // Cmd+P never reaches the pane; Ctrl+P is the terminal's
      inTerminal: ctx.apple,
      run: () => ctx.openPalette('files'),
    },
    {
      id: 'palette.commands',
      title: 'Show all commands',
      category: 'Palette',
      defaultKey: 'Mod+Shift+P',
      inTerminal: true,
      run: () => ctx.openPalette('commands'),
    },
    {
      id: 'palette.goToLine',
      title: 'Go to line',
      category: 'Palette',
      run: () => ctx.openPalette('line'),
    },
    {
      id: 'palette.sessions',
      title: 'Go to tab or pane',
      category: 'Palette',
      run: () => ctx.openPalette('sessions'),
    },
    {
      id: 'view.terminal',
      title: 'Show the terminal',
      category: 'View',
      run: ctx.showTerminal,
    },
    {
      id: 'view.chat',
      title: 'Show Chat',
      category: 'View',
      disabledReason: ctx.viewIds.includes(CHAT_VIEW_ID)
        ? undefined
        : 'No agent chat in this pane',
      run: ctx.showChat,
    },
    {
      id: 'view.tasks',
      title: 'Show Tasks',
      category: 'View',
      disabledReason: ctx.viewIds.includes(TASKS_VIEW_ID)
        ? undefined
        : ctx.readOnly
          ? VIEW_ONLY
          : 'No tasks for this pane',
      run: () => ctx.changeView(TASKS_VIEW_ID),
    },
    panel(FILES_VIEW_ID, 'Toggle the Files panel'),
    panel(CHANGES_VIEW_ID, 'Toggle the Changes panel'),
    {
      id: 'view.overview',
      title: 'Show the agent overview',
      category: 'View',
      run: ctx.openOverview,
    },
    {
      id: 'files.searchContent',
      title: 'Search in files',
      category: 'Files',
      defaultKey: SEARCH_CONTENT_KEY,
      disabledReason: ctx.panelIds.includes(FILES_VIEW_ID)
        ? undefined
        : NO_FILES,
      run: ctx.searchContent,
    },
    {
      id: 'tab.new',
      title: 'New tab',
      category: 'Tabs',
      disabledReason: ctx.readOnly ? VIEW_ONLY : undefined,
      restoreFocus: true,
      run: ctx.newTab,
    },
    {
      id: 'tab.previous',
      title: 'Previous tab',
      category: 'Tabs',
      disabledReason: ctx.previousTab ? undefined : 'No tab before this one',
      restoreFocus: true,
      run: () => ctx.previousTab && ctx.selectTab(ctx.previousTab),
    },
    {
      id: 'tab.next',
      title: 'Next tab',
      category: 'Tabs',
      disabledReason: ctx.nextTab ? undefined : 'No tab after this one',
      restoreFocus: true,
      run: () => ctx.nextTab && ctx.selectTab(ctx.nextTab),
    },
    pane('pane.splitRight', 'Split pane right', () => ctx.splitPane('right')),
    pane('pane.splitDown', 'Split pane down', () => ctx.splitPane('down')),
    pane('pane.zoom', 'Zoom pane', ctx.zoomPane, arrangeReason),
    pane(
      'pane.swapNext',
      'Swap pane with the next one',
      ctx.swapNextPane,
      arrangeReason ?? (ctx.canSwapNext ? undefined : 'No pane after this one'),
    ),
    ...(ctx.desktop
      ? [
          resize('pane.resizeLeft', 'left'),
          resize('pane.resizeRight', 'right'),
          resize('pane.resizeUp', 'up'),
          resize('pane.resizeDown', 'down'),
        ]
      : []),
    {
      id: 'agent.start',
      title: 'Start an agent',
      category: 'Agent',
      disabledReason: agentReason,
      run: () => ctx.changeView(CHAT_VIEW_ID),
    },
    {
      id: 'settings.open',
      title: 'Open Settings',
      category: 'App',
      restoreFocus: true,
      run: () => ctx.openSettings(),
    },
    {
      id: 'settings.devices',
      title: 'Open Settings: Devices',
      category: 'App',
      disabledReason: ctx.devices ? undefined : 'Not available on this server',
      restoreFocus: true,
      run: () => ctx.openSettings('devices'),
    },
    {
      id: 'settings.shortcuts',
      title: 'Open Settings: Shortcuts',
      category: 'App',
      restoreFocus: true,
      run: () => ctx.openSettings('shortcuts'),
    },
    {
      id: 'app.help',
      title: 'Show help',
      category: 'App',
      restoreFocus: true,
      run: ctx.openHelp,
    },
    {
      id: 'app.about',
      title: 'About Termote',
      category: 'App',
      restoreFocus: true,
      run: ctx.openAbout,
    },
    {
      id: 'app.docs',
      title: 'Open the documentation',
      category: 'App',
      restoreFocus: true,
      run: () => {
        window.open(APP_INFO.links.docs, '_blank', 'noopener,noreferrer')
      },
    },
    {
      id: 'app.toggleSidebar',
      title: 'Toggle the sidebar',
      category: 'App',
      restoreFocus: true,
      run: ctx.toggleSidebar,
    },
    {
      id: 'app.fullscreen',
      title: 'Toggle full screen',
      category: 'App',
      disabledReason: ctx.canFullscreen
        ? undefined
        : 'Not supported by this browser',
      restoreFocus: true,
      run: ctx.toggleFullscreen,
    },
    {
      id: 'window.openNew',
      title: 'Open in new window',
      category: 'App',
      disabledReason: ctx.openWindow ? undefined : 'No link names this pane',
      run: () => ctx.openWindow?.(),
    },
    {
      id: 'terminal.fontIncrease',
      title: 'Terminal: larger text',
      category: 'Terminal',
      restoreFocus: true,
      run: ctx.fontIncrease,
    },
    {
      id: 'terminal.fontDecrease',
      title: 'Terminal: smaller text',
      category: 'Terminal',
      restoreFocus: true,
      run: ctx.fontDecrease,
    },
    theme('light', 'Theme: light'),
    theme('dark', 'Theme: dark'),
    theme('system', 'Theme: follow the system'),
  ]
}
