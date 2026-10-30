// The Usage Guide (components/help-modal.tsx): key names, tmux keys and
// commands stay inside the messages as they are typed
export default {
  'help.title': 'Usage Guide',
  'help.topic': 'Guide topic',
  'help.tab.gestures': 'Gestures',
  'help.tab.toolbar': 'Toolbar',
  'help.tab.tmux': 'tmux',
  'help.docs': 'Full documentation',

  // Gestures tab
  'help.gestures.title': 'Touch Gestures',
  'help.gestures.swipeLeft': 'Swipe Left',
  'help.gestures.swipeLeftDesc': 'Cancel (Ctrl+C)',
  'help.gestures.swipeRight': 'Swipe Right',
  'help.gestures.swipeRightDesc': 'Tab completion',
  'help.gestures.swipeUpDown': 'Swipe Up/Down',
  'help.gestures.swipeUpDownDesc': 'Scroll history',
  'help.gestures.longPress': 'Long Press',
  'help.gestures.longPressDesc': 'Paste from clipboard',
  'help.gestures.pinch': 'Pinch In/Out',
  'help.gestures.pinchDesc': 'Decrease/Increase font size',

  // Toolbar tab: the bottom row
  'help.buttons.title': 'Toolbar Buttons',
  'help.buttons.keyboard': 'Toggle virtual keyboard',
  'help.buttons.ime': 'Text input mode (IME)',
  'help.buttons.esc': 'Escape key (clears modifiers if active)',
  'help.buttons.ctrl': 'Toggle Ctrl modifier (sticky)',
  'help.buttons.upDown': 'Up/Down arrows',
  'help.buttons.enter': 'Enter / Submit command',
  'help.buttons.tab': 'Tab key / autocomplete',
  'help.buttons.extra':
    'Extra keys: show or hide the expanded rows (pinned at the right)',

  // Toolbar tab: the keys of the expanded rows
  'help.expanded.title': 'Expanded Keys',
  'help.expanded.history': 'Command history search',
  'help.expanded.pasteSource': 'Paste (source configurable in Settings)',
  'help.expanded.pasteSystem': 'Paste from the system clipboard',
  'help.expanded.attach': 'Attach an image',
  'help.expanded.selectText':
    "Select text: the pane's text, to select and copy",
  'help.expanded.shift': 'Toggle Shift modifier (sticky)',
  'help.expanded.shiftTab': 'Shift+Tab (e.g. switch mode in Claude Code)',
  'help.expanded.leftRight': 'Left/Right arrows',
  'help.expanded.copyMode': 'Toggle tmux copy mode',
  'help.expanded.page': 'Page up/down in copy mode',
  'help.expanded.scroll': 'Scroll history',

  // Toolbar tab: what Ctrl and Ctrl+Shift send
  'help.ctrl.title': 'Ctrl Combos (when Ctrl active)',
  'help.ctrl.c': 'Cancel/interrupt',
  'help.ctrl.d': 'Exit/EOF',
  'help.ctrl.z': 'Suspend process',
  'help.ctrl.l': 'Clear screen',
  'help.ctrl.a': 'Move to line start',
  'help.ctrl.e': 'Move to line end',
  'help.ctrl.prefix': 'tmux prefix',
  'help.ctrl.back': 'Move cursor back',
  'help.ctrlShift.title': 'Ctrl+Shift Combos',
  'help.ctrlShift.c': 'Copy the selection, else send ^⇧C',
  'help.ctrlShift.v': 'Paste from clipboard',
  'help.ctrlShift.z': 'Redo',
  'help.ctrlShift.x': 'Cut',

  // Toolbar tab: the expanded rows, by the name each row shows
  'help.rows.title': 'Expanded Toolbar Rows',
  'help.rows.actions': 'Clear, Cancel, Clear line, Exit (mobile)',
  'help.rows.textCopyMode':
    'History, paste, attach image, select text, copy mode, page up/down',
  'help.rows.textScroll':
    'History, paste, attach image, select text, scroll up/down',
  'help.rows.navigate':
    'Shift, Shift+Tab, Left/Right, Home/End, PgUp/PgDn, Del/Bksp, Insert',
  'help.rows.ctrl': 'Every Ctrl combo, above the toolbar while Ctrl is on',

  // Toolbar tab: the agent badges (names from tasks.status.*)
  'help.status.title': 'Agent Status',
  'help.status.blocked': 'Blocked: the agent is waiting for you',
  'help.status.chat':
    'Claude Code and Codex panes: read the conversation, send a message, answer its dialogs (Codex on tmux: in the terminal)',

  // tmux tab
  'help.windows.title': 'Windows (Ctrl+B, then...)',
  'help.windows.create': 'Create new window',
  'help.windows.nextPrev': 'Next / Previous window',
  'help.windows.switch': 'Switch to window N',
  'help.windows.rename': 'Rename current window',
  'help.windows.kill': 'Kill current window',
  'help.windows.list': 'List all windows',
  'help.panes.title': 'Panes (Ctrl+B, then...)',
  'help.panes.splitVertical': 'Split vertically',
  'help.panes.splitHorizontal': 'Split horizontally',
  'help.panes.navigate': 'Navigate panes',
  'help.panes.kill': 'Kill current pane',
  'help.panes.zoom': 'Toggle pane zoom',
  'help.panes.layouts': 'Cycle layouts',
  'help.copy.title': 'Copy Mode (Ctrl+B, then...)',
  'help.copy.enter': 'Enter copy mode',
  'help.copy.exit': 'Exit copy mode',
  'help.copy.start': 'Start selection',
  'help.copy.copy': 'Copy selection',
  'help.copy.paste': 'Paste buffer',
  'help.copy.search': 'Search forward',
  'help.sessions.title': 'Sessions (Ctrl+B, then...)',
  'help.sessions.list': 'List sessions',
  'help.sessions.rename': 'Rename session',
  'help.sessions.detach': 'Detach from session',
  'help.sessions.prevNext': 'Prev / Next session',
} as const
