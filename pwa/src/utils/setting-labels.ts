// What the before/after table of a proposal or an import calls each setting
// and each of its values: the words Settings shows, never the stored key.
// setting-labels.test.ts checks every key of the registry and every command
// has one.

import type { MessageKey } from '../i18n/messages/en'
import type { CommandId } from './shortcuts'

export const SETTING_LABEL: Record<string, MessageKey> = {
  theme: 'shell.menu.theme',
  uiStyle: 'settings.style',
  language: 'settings.language',
  terminalFontSize: 'settings.key.terminalFontSize',
  terminalFont: 'settings.font',
  disableContextMenu: 'settings.contextMenu',
  copyOnSelect: 'settings.copyOnSelect',
  pasteSource: 'settings.paste',
  imeSendBehavior: 'settings.ime',
  chatSendKey: 'settings.chatSend',
  toolbarDefaultExpanded: 'settings.toolbarExpanded',
  toolbarPosition: 'settings.toolbarPosition',
  showSessionTabs: 'settings.tabs',
  showUsageChip: 'settings.usage',
  showHostChip: 'settings.hostChip',
  pollInterval: 'settings.poll',
  sidebarFilter: 'settings.key.sidebarFilter',
  sidebarLayout: 'settings.sidebarLayout',
  sortBlockedFirst: 'settings.blockedFirst',
  sidebarWidth: 'settings.key.sidebarWidth',
  sidePanelWidth: 'settings.key.sidePanelWidth',
  stuckMinutes: 'settings.stuck',
  driveTerminalSize: 'settings.fitPane',
  herdrLayoutView: 'settings.layoutView',
  markdownPreview: 'settings.key.markdownPreview',
  markdownEditLayout: 'settings.key.markdownEditLayout',
  tablePreview: 'settings.key.tablePreview',
  svgPreview: 'settings.key.svgPreview',
  findIncludeIgnored: 'settings.key.findIncludeIgnored',
  findExcludes: 'settings.excluded',
  searchCase: 'settings.key.searchCase',
  searchWord: 'settings.key.searchWord',
  searchRegex: 'settings.key.searchRegex',
  editorFontSize: 'settings.fontSize',
  editorTabSize: 'settings.tabSize',
  editorWrap: 'settings.wrap',
  editorVim: 'settings.vim',
  taskHistoryLines: 'settings.taskHistory',
  shortcuts: 'settings.group.shortcuts',
}

// The command palette's title of each command
export const COMMAND_LABEL: Record<CommandId, MessageKey> = {
  'palette.quickOpen': 'tasks.command.quickOpen',
  'palette.commands': 'tasks.command.commands',
  'palette.goToLine': 'tasks.command.goToLine',
  'palette.sessions': 'tasks.command.sessions',
  'view.terminal': 'tasks.command.terminal',
  'view.chat': 'tasks.command.chat',
  'view.filesPanel': 'tasks.command.filesPanel',
  'view.changesPanel': 'tasks.command.changesPanel',
  'view.tasks': 'tasks.command.tasks',
  'view.overview': 'tasks.command.overview',
  'files.searchContent': 'tasks.command.searchContent',
  'tab.new': 'tasks.command.newTab',
  'tab.previous': 'tasks.command.previousTab',
  'tab.next': 'tasks.command.nextTab',
  'pane.previous': 'tasks.command.previousPane',
  'pane.next': 'tasks.command.nextPane',
  'pane.splitRight': 'tasks.command.splitRight',
  'pane.splitDown': 'tasks.command.splitDown',
  'pane.zoom': 'tasks.command.zoom',
  'pane.swapNext': 'tasks.command.swapNext',
  'pane.resizeLeft': 'tasks.command.resizeLeft',
  'pane.resizeRight': 'tasks.command.resizeRight',
  'pane.resizeUp': 'tasks.command.resizeUp',
  'pane.resizeDown': 'tasks.command.resizeDown',
  'agent.start': 'tasks.command.agentStart',
  'settings.open': 'tasks.command.settings',
  'settings.devices': 'tasks.command.settingsDevices',
  'settings.shortcuts': 'tasks.command.settingsShortcuts',
  'machine.next': 'tasks.command.switchMachine',
  'app.help': 'tasks.command.help',
  'app.about': 'tasks.command.about',
  'app.docs': 'tasks.command.docs',
  'app.toggleSidebar': 'tasks.command.toggleSidebar',
  'app.fullscreen': 'tasks.command.fullscreen',
  'window.openNew': 'tasks.command.openWindow',
  'terminal.fontIncrease': 'tasks.command.fontIncrease',
  'terminal.fontDecrease': 'tasks.command.fontDecrease',
  'theme.light': 'tasks.command.themeLight',
  'theme.dark': 'tasks.command.themeDark',
  'theme.system': 'tasks.command.themeSystem',
}

// The words of each value a choice setting takes, as Settings names them
export const VALUE_LABEL: Record<string, Record<string, MessageKey>> = {
  theme: {
    light: 'shell.menu.light',
    dark: 'shell.menu.dark',
    system: 'shell.menu.system',
  },
  uiStyle: {
    neutral: 'settings.style.neutral',
    terminal: 'settings.style.terminal',
    native: 'settings.style.native',
  },
  language: {
    auto: 'settings.languageAuto',
    en: 'common.english',
    vi: 'common.vietnamese',
  },
  sidebarLayout: {
    detailed: 'settings.sidebarLayout.detailed',
    compact: 'settings.sidebarLayout.compact',
  },
  toolbarPosition: {
    header: 'settings.toolbarPosition.header',
    right: 'settings.toolbarPosition.right',
  },
  imeSendBehavior: {
    'send-only': 'settings.ime.sendOnly',
    'send-enter': 'settings.ime.sendEnter',
  },
  chatSendKey: {
    'ctrl-enter': 'settings.chatSend.ctrlEnter',
    enter: 'settings.chatSend.enter',
  },
  pasteSource: {
    clipboard: 'settings.paste.clipboard',
    tmux: 'settings.key.pasteBuffer',
  },
  sidebarFilter: {
    all: 'tasks.filter.all',
    'needs-you': 'tasks.filter.needsYou',
    agents: 'tasks.filter.agentsSegment',
    working: 'tasks.filter.working',
  },
  markdownEditLayout: {
    source: 'files.viewer.layout.source',
    split: 'files.viewer.layout.split',
    preview: 'files.viewer.layout.preview',
  },
}
