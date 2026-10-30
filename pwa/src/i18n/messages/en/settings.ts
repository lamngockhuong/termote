// Settings (components/settings-modal.tsx) and its groups, the pairing sheet
// and About
export default {
  'settings.language': 'Language',
  'settings.languageDesc': 'Auto follows the browser',
  'settings.languageAuto': 'Auto',
  'settings.takeTour': 'Take the tour',
  'settings.showWelcome': 'Show welcome screen',
  // The groups, in the desktop rail and as headings
  'settings.groups': 'Settings groups',
  'settings.group.appearance': 'Appearance',
  'settings.group.keyboard': 'Keyboard',
  'settings.group.shortcuts': 'Shortcuts',
  'settings.group.sessions': 'Sessions',
  'settings.group.devices': 'Devices',
  'settings.group.signins': 'Signed-in browsers',
  'settings.group.templates': 'Prompt templates',
  'settings.group.updates': 'Updates',
  'settings.group.data': 'Data & help',
  // Appearance
  'settings.style': 'Interface style',
  'settings.styleDesc': 'Applies at once. Theme stays in the ⋯ menu.',
  'settings.style.neutral': 'Neutral',
  'settings.style.terminal': 'Terminal',
  'settings.style.native': 'Native',
  // Keyboard
  'settings.ime': 'Text input send behavior',
  'settings.ime.sendOnly': 'Send text only',
  'settings.ime.sendOnlyDesc': 'Send text to terminal without Enter',
  'settings.ime.sendEnter': 'Send + Enter',
  'settings.ime.sendEnterDesc': 'Send text then press Enter automatically',
  'settings.paste': 'Paste button source',
  'settings.paste.clipboard': 'System clipboard',
  'settings.paste.clipboardDesc': 'Paste from device clipboard (Ctrl+Shift+V)',
  'settings.paste.bufferDesc': 'Paste from the copy mode buffer',
  'settings.toolbarExpanded': 'Toolbar default expanded',
  'settings.toolbarExpandedDesc': 'Show all keys when toolbar loads',
  // Terminal
  'settings.font': 'Terminal font',
  'settings.fontDesc':
    'A font installed on this device (e.g. a Nerd Font). Nerd Font icons work without one.',
  'settings.contextMenu': 'Disable right-click menu',
  'settings.contextMenuDesc': 'Block context menu on terminal area',
  'settings.copyOnSelect': 'Copy on select',
  'settings.copyOnSelectDesc':
    'Copy the text you select with the mouse as soon as you release the button',
  'settings.fitPane': 'Fit herdr pane to this device',
  'settings.fitPaneDesc':
    'While the terminal shows; resizes the pane on the desktop too, until this page is hidden or closed, another view opens, or another device takes over',
  'settings.layoutView': 'Show herdr panes side by side',
  'settings.layoutViewDesc':
    "On a computer, a tab of 2 to 4 panes shows them in herdr's layout; off, or when they would be too small to read, one pane at a time",
  // Sessions
  'settings.tabs': 'Show session tabs',
  'settings.tabsDesc': 'Display tab bar for quick session switching (desktop)',
  'settings.blockedFirst': 'Blocked sessions first',
  'settings.blockedFirstDesc':
    'List sessions waiting on you at the top of each group',
  'settings.notify': 'Notify when an agent needs me',
  'settings.notify.homeScreen':
    'iPhone/iPad: works only from the Home Screen app (iOS 16.4+)',
  'settings.notify.denied': 'Blocked in browser settings',
  'settings.notify.reload': 'Reload to turn on',
  'settings.notify.desc':
    'A dialog waits or a turn finished. On a phone, needs the installed app',
  'settings.stuck': 'Stuck agent',
  'settings.stuckDesc':
    'Mark a working agent quiet for {minutes} min in the overview',
  'settings.stuckAfter': 'Stuck agent after',
  'settings.minutes': '{n} min',
  'settings.usage': 'Agent usage in the header',
  'settings.usageDesc':
    "Show how full the open pane's agent context is, and its Codex limits",
  'settings.poll': 'Session poll interval',
  'settings.pollDesc': 'How often to sync session list ({interval})',
  'settings.pollSeconds': '{n}s',
  'settings.pollMinutes': '{n}m',
  // Files
  'settings.excluded': 'Excluded folders',
  'settings.excludedDesc':
    'Never searched for ignored files, and never outside a repository. Tracked files are always searched.',
  'settings.excluded.list': 'Folders never searched',
  'settings.excluded.remove': 'Remove {name}',
  'settings.excluded.placeholder': 'Folder name',
  'settings.excluded.add': 'Add',
  'settings.excluded.reset': 'Reset to defaults',
  'settings.excluded.listed': 'Already in the list',
  'settings.excluded.max': 'At most {max} folders',
  'settings.excluded.empty': 'Enter a folder name',
  'settings.excluded.notName': 'Not a folder name',
  'settings.excluded.path': 'One folder name, not a path',
  'settings.excluded.pattern': 'A name, not a pattern',
  'settings.excluded.tooLong': 'Name too long',
  'settings.wrap': 'Wrap lines',
  'settings.wrapDesc': 'Wrap long lines of a file at first, on desktop too',
  'settings.fontSize': 'Editor font size',
  'settings.fontSizeDesc': 'Desktop editor (a phone edits in a plain text box)',
  'settings.px': '{n} px',
  'settings.tabSize': 'Tab size',
  'settings.tabSizeDesc': 'Desktop editor: columns of a tab, and of one indent',
  'settings.vim': 'Vim mode',
  'settings.vimDesc': 'Desktop editor: Vim keys; :w saves',
  // Tasks
  'settings.taskHistory': 'History read for Send to agent',
  'settings.taskHistoryDesc':
    "Lines of a task's tab searched for its run's output; only the run's own output is sent",
  'settings.taskLines': '{n} lines',
  // Data & help
  'settings.clearHistory': 'Clear Command History ({count})',

  // Words the groups share: a row's buttons, a list's state, a save refused
  'settings.edit': 'Edit',
  'settings.editName': 'Edit {name}',
  'settings.delete': 'Delete',
  'settings.deleteName': 'Delete {name}',
  'settings.deleteTitle': 'Delete {name}?',
  'settings.deleteAgain': 'Changed on another device: delete anyway?',
  'settings.deleted': 'Deleted {name}',
  'settings.deleteBody': 'Every device of this server loses {name}.',
  'settings.name': 'Name',
  'settings.save': 'Save',
  'settings.changedElsewhere': 'Changed on another device',
  'settings.deletedElsewhere': 'Deleted on another device',
  'settings.loadTheirs': 'Load theirs',
  'settings.keepMine': 'Keep mine',
  'settings.saveAsNew': 'Save as new',
  'settings.nameTooLong': 'The name is longer than {max} characters',
  'settings.nameHidden': 'The name contains hidden characters ({code})',
  'settings.notSaved': 'Not saved: {message}',
  'settings.viewOnly': 'This device is view only',
  'settings.tooLarge': 'Too large to save',
  'settings.used': 'used {ago}',
  'settings.paired': 'paired {ago}',
  'settings.copied': 'Copied',
  'settings.securityModel': 'Security model',
  'settings.newTab': '(opens in a new tab)',

  // Devices (components/devices-section.tsx)
  'settings.devices.intro':
    'A paired device signs in without the password. Changing the password (termote start --fresh) revokes every one.',
  'settings.devices.full': 'Full',
  'settings.devices.viewOnly': 'View only',
  'settings.devices.byPassword':
    'Paired with the password, kept when a browser signs out',
  'settings.devices.unknownOrigin': 'Unknown origin',
  'settings.devices.fromSignin': 'Paired from a signed-in browser ({id})',
  'settings.devices.pairedBy': 'Paired by {name}',
  'settings.devices.byRemoved': 'Paired by a removed device',
  'settings.devices.expired': 'Expired',
  'settings.devices.validUntil': 'Valid until {date}',
  'settings.devices.revoked': 'Revoked {name}',
  'settings.devices.revokedAlso':
    'Revoked {name}, and the devices it paired: {names}',
  'settings.devices.revokeFailed': 'Could not revoke {name}. Try again',
  'settings.devices.none': 'No device is paired yet.',
  'settings.devices.list': 'Paired devices',
  'settings.devices.thisDevice': 'This device',
  'settings.devices.revoke': 'Revoke',
  'settings.devices.revokeName': 'Revoke {name}',
  'settings.devices.pair': 'Pair a device',
  'settings.devices.confirmTitle': 'Revoke this device?',
  'settings.devices.confirmCurrent':
    'This is the device you are using: it is signed out at once.',
  'settings.devices.confirmOther':
    '{name} is signed out at its next request, and its open terminals close.',
  'settings.devices.confirmPaired':
    'The devices it paired are revoked with it: {names}.',
  'settings.devices.confirmFull':
    'A full device could open a terminal on this computer. To be sure nothing it left behind stays, also run <code>termote start --fresh</code>.',

  // Signed-in browsers (components/signins-section.tsx)
  'settings.signins.intro':
    "Signing out ends the browser's cookie. If the password may be known, run <code>termote start --fresh</code>.",
  'settings.signins.viaForm': 'Sign-in form',
  'settings.signins.viaBasic': 'Basic auth',
  'settings.signins.viaLink': 'Link from the CLI',
  'settings.signins.browserOn': '{browser} on {system}',
  'settings.signins.aBrowserOn': 'A browser on {system}',
  'settings.signins.unknown': 'Unknown browser',
  'settings.signins.signedOutOthers_one': 'Signed out {count} other browser',
  'settings.signins.signedOutOthers_other': 'Signed out {count} other browsers',
  'settings.signins.signedOut': 'Signed out {name}',
  'settings.signins.keptOthers':
    'Signed out the other browsers, but the devices paired from them could not be revoked. Revoke them in Devices',
  'settings.signins.keptOne':
    'Signed out {name}, but the devices paired from it could not be revoked. Revoke them in Devices',
  'settings.signins.failedOthers':
    'Could not sign the other browsers out. Try again',
  'settings.signins.failedOne': 'Could not sign {name} out. Try again',
  'settings.signins.none': 'No browser is signed in with the password.',
  'settings.signins.thisBrowser': 'This browser',
  'settings.signins.signOut': 'Sign out',
  'settings.signins.signOutName': 'Sign out {name}',
  'settings.signins.signOutCurrent': 'Sign out {name} (this browser)',
  'settings.signins.signOutOthers': 'Sign out all others',
  'settings.signins.confirmOthersTitle': 'Sign out every other browser?',
  'settings.signins.confirmTitle': 'Sign out this browser?',
  'settings.signins.confirmOthers_one':
    '{count} browser is signed out at the next request, and their open terminals close. The devices paired from them are revoked too. This browser stays signed in.',
  'settings.signins.confirmOthers_other':
    '{count} browsers are signed out at the next request, and their open terminals close. The devices paired from them are revoked too. This browser stays signed in.',
  'settings.signins.confirmCurrent':
    'This is the browser you are using: it is signed out at once.',
  'settings.signins.confirmCurrentDevices':
    'This is the browser you are using: it is signed out at once. The devices paired from it are revoked too.',
  'settings.signins.confirmOther':
    '{name} is signed out at its next request, and its open terminals close. The devices paired from it are revoked too.',

  // Updates (components/updates-section.tsx, star-prompt-card.tsx)
  'settings.updates.howRelease':
    'Run in a terminal on the host (a Termote one works too):',
  'settings.updates.howContainer':
    'Run on the host, not in this container (a container built from a checkout: git pull, then termote container up --build):',
  'settings.updates.howCheckout':
    'This server runs from a git checkout: pull, rebuild and restart it there.',
  'settings.updates.howUnknown': 'Update it the way it was installed.',
  'settings.updates.failed': 'Could not reach GitHub to check for updates.',
  'settings.updates.checkingFor': 'Checking for updates…',
  'settings.updates.available': 'Version {version} is available.',
  'settings.updates.newest': 'You are on the newest version.',
  'settings.updates.running': 'Running v{version}',
  'settings.updates.checked': 'Newest v{version} · checked {ago}',
  'settings.updates.notChecked': 'Not checked yet',
  'settings.updates.checking': 'Checking…',
  'settings.updates.check': 'Check for updates',
  'settings.updates.stale': 'This page is v{page}; reload to use v{server}.',
  'settings.updates.reloading': 'Reloading…',
  'settings.updates.reload': 'Reload',
  'settings.updates.copy': 'Copy',
  'settings.updates.commandCopied': 'Command copied',
  'settings.updates.notes': 'Release notes for v{version}',
  'settings.star.prompt':
    'Updated to v{version}. If Termote helps you, a star on GitHub helps others find it.',
  'settings.star.link': 'Star on GitHub',
  'settings.star.decline': 'No thanks',

  // Shortcuts (components/shortcuts-section.tsx, utils/shortcuts.ts)
  'settings.shortcuts.intro':
    'Kept on this device. A key the browser handles first (such as {key}) never reaches the app.',
  'settings.shortcuts.filter': 'Filter shortcuts',
  'settings.shortcuts.filterPlaceholder': 'Filter by name or key',
  'settings.shortcuts.resetAll': 'Reset all shortcuts',
  'settings.shortcuts.none': 'No shortcut matches',
  'settings.shortcuts.resetAllTitle': 'Reset all shortcuts?',
  'settings.shortcuts.resetAllConfirm': 'Reset all',
  'settings.shortcuts.resetAllBody': 'Every command gets its default key back.',
  'settings.shortcuts.useMod': 'Use {mod} with a key',
  'settings.shortcuts.unusable': 'This key cannot be used',
  'settings.shortcuts.browserKeeps': 'The browser keeps this key',
  'settings.shortcuts.usedByEditor': 'Used by the editor',
  'settings.shortcuts.usedByTerminal': 'Used by the terminal',
  'settings.shortcuts.usedForText': 'Used to edit text',
  'settings.shortcuts.alsoUsedBy': 'Also used by {name}',
  'settings.shortcuts.replacedBy': 'Replaced by your shortcut for {name}',
  'settings.shortcuts.noKey': 'No key',
  'settings.shortcuts.change': 'Change',
  'settings.shortcuts.changeName': 'Change the key of {name}',
  'settings.shortcuts.pressKeys': 'Press keys…',
  'settings.shortcuts.remove': 'Remove',
  'settings.shortcuts.removeName': 'Remove the key of {name}',
  'settings.shortcuts.reset': 'Reset',
  'settings.shortcuts.resetName': 'Reset the key of {name}',
  'settings.shortcuts.inTerminalName': '{name}: also in the terminal',
  'settings.shortcuts.terminalUses': 'The terminal uses this key',
  'settings.shortcuts.inTerminal': 'Also in the terminal',
  'settings.shortcuts.recording': 'Press the new key for {name}, or Escape',

  // Prompt templates (components/prompt-templates-section.tsx,
  // template-editor.tsx, utils/prompt-templates.ts)
  'settings.templates.intro':
    'Saved on this server, shared by every device that signs in to it. Insert one from the Chat: the Templates button, the / list or the command palette.',
  'settings.templates.viewOnly':
    'This device is view only: the templates can be read and exported.',
  'settings.templates.newer':
    'Saved by a newer Termote; update it to change templates.',
  'settings.templates.readFailed': 'Could not read the templates',
  'settings.templates.none': 'No templates yet.',
  'settings.templates.new': 'New template',
  'settings.templates.import': 'Import…',
  'settings.templates.export': 'Export',
  'settings.templates.exportFirst':
    'Export first to keep a copy: an import cannot be undone.',
  'settings.templates.file': 'Templates file to import',
  'settings.templates.deleteFailed': 'Could not delete the template',
  'settings.templates.exportFailed': 'Could not export the templates',
  'settings.templates.fileTooLarge': 'The file is larger than {size} MB',
  'settings.templates.readFileFailed': 'Could not read the file',
  'settings.templates.imported': 'Imported: {added} added, {replaced} replaced',
  'settings.templates.at': 'Template {n}: {problem}',
  'settings.templates.importTitle': 'Import templates?',
  'settings.templates.importConfirm': 'Import',
  'settings.templates.added': 'New',
  'settings.templates.replaced': 'Replaces the existing template',
  'settings.templates.listCount': '{title} ({count})',
  'settings.templates.noUndo': 'An import cannot be undone.',
  'settings.templates.newTitle': 'New prompt template',
  'settings.templates.text': 'Text',
  'settings.templates.size': '{used} KB of {max} KB',
  'settings.templates.insertVariable': 'Insert a variable',
  'settings.templates.insert': 'Insert {token}: {hint}',
  'settings.templates.filledIn':
    'Filled in when the template is inserted into the Chat: {list}.',
  'settings.templates.varFile': 'the file shown in Files',
  'settings.templates.varSelection': 'the text selected last',
  'settings.templates.varBranch': 'the git branch',
  'settings.templates.varInput': 'typed when inserting',
  'settings.templates.nameIt': 'Name the template',
  'settings.templates.empty': 'The template is empty',
  'settings.templates.tooLarge': 'The template is larger than {max} KB',
  'settings.templates.textHidden':
    'The template contains hidden characters ({code} at character {index})',
  'settings.templates.notJson': 'This is not a JSON file',
  'settings.templates.notTemplates': 'This is not a templates file',
  'settings.templates.otherVersion':
    'This file was made by another version of Termote',
  'settings.templates.fileEmpty': 'The file has no templates',
  'settings.templates.fileTooMany':
    'The file has {count} templates: up to {max}',
  'settings.templates.noNameOrText': 'Template {n} has no name or text',
  'settings.templates.sameNameAt':
    'Template {n}: another template has this name',
  'settings.templates.nameTaken': 'A template with this name exists',
  'settings.templates.tooMany': 'Up to {max} templates',
  'settings.templates.duplicateName':
    'Two templates in the file have the same name',
  'settings.templates.newerFormat':
    'Saved by a newer Termote; update it to change templates',
  'settings.templates.unavailable':
    'Templates are not available on this server',
  'settings.templates.busy':
    'The templates are being changed elsewhere; try again',
  'settings.templates.importChanged':
    'The templates changed since the check; check again',
  'settings.templates.saveFailed': 'Could not save the templates',

  // The user's tasks (components/user-tasks-section.tsx, user-task-editor.tsx,
  // utils/user-tasks.ts)
  'settings.tasks.intro':
    "Saved on this server, shared by every device. Each runs from a pane's Tasks view, in a tab at the pane's folder.",
  'settings.tasks.newer':
    'Saved by a newer Termote; update it to change tasks.',
  'settings.tasks.readFailed': 'Could not read the tasks',
  'settings.tasks.none': 'No tasks yet.',
  'settings.tasks.new': 'New task',
  'settings.tasks.command': 'Command',
  'settings.tasks.commandHint':
    "Runs in the shell of a tab opened at the pane's folder (bash, zsh, sh, fish or pwsh), as if typed there.",
  'settings.tasks.nameIt': 'Name the task',
  'settings.tasks.enterCommand': 'Enter the command',
  'settings.tasks.oneLine': 'The command must be one line',
  'settings.tasks.commandTooLarge': 'The command is larger than {max} bytes',
  'settings.tasks.commandHidden':
    'The command contains hidden characters ({code})',
  'settings.tasks.nameTaken': 'A task with this name exists',
  'settings.tasks.tooMany': 'Up to {max} tasks',
  'settings.tasks.newerFormat':
    'Saved by a newer Termote; update it to change tasks',
  'settings.tasks.unavailable': 'Tasks are not available on this server',
  'settings.tasks.busy': 'The tasks are being changed elsewhere; try again',
  'settings.tasks.saveFailed': 'Could not save the tasks',

  // Pairing a device (components/pair-device-sheet.tsx)
  'settings.pair.viewHint':
    'Watches the terminal, Chat and Files; changes nothing.',
  'settings.pair.fullHint':
    'Everything this device can do: typing, files, agents, devices.',
  'settings.pair.days_one': '{count} day',
  'settings.pair.days_other': '{count} days',
  'settings.pair.never': 'Never',
  'settings.pair.noLimit': 'stays signed in with no time limit',
  'settings.pair.forDays_one': 'stays signed in for {count} day',
  'settings.pair.forDays_other': 'stays signed in for {count} days',
  'settings.pair.forHours_one': 'stays signed in for {count} hour',
  'settings.pair.forHours_other': 'stays signed in for {count} hours',
  'settings.pair.tooManyCodes':
    'Too many codes are waiting. Use one, or wait 5 minutes',
  'settings.pair.invalidName': 'Use a shorter name without special characters',
  'settings.pair.viewOnly': 'This device is view-only',
  'settings.pair.fullNeedsPassword':
    'A full device is paired from a password sign-in or the CLI',
  'settings.pair.creatorGone': 'This device can no longer pair devices',
  'settings.pair.invalidValidity':
    'Pick how long the new device stays signed in',
  'settings.pair.failed': 'Could not make a pairing code. Try again',
  'settings.pair.nameTooLong': 'Use a name of at most {max} characters',
  'settings.pair.expired': 'This code expired. Make a new one.',
  'settings.pair.howTo':
    'On the new device, scan the code or open the link. In the installed app, use “Have a pairing code?” on the sign-in page.',
  'settings.pair.code': 'Pairing code',
  'settings.pair.qr': 'QR code of the pairing link',
  'settings.pair.expires': 'Expires in {left} · works once',
  'settings.pair.validFor': 'The new device {note}.',
  'settings.pair.copyLink': 'Copy link',
  'settings.pair.newCode': 'New code',
  'settings.pair.role': 'Role',
  'settings.pair.viewOnlyOnly':
    'View only. {hint} Full devices are paired from a password sign-in or <code>termote pair --role full</code>.',
  'settings.pair.trust':
    'A full device can do anything your user account can; a view device sees everything printed.',
  'settings.pair.validity': 'Stays signed in for',
  'settings.pair.outlast': "Can't outlast this device",
  'settings.pair.name': 'Name (optional; the new device can name itself)',
  'settings.pair.namePlaceholder': 'Phone',
  'settings.pair.make': 'Make code',

  // About (components/about-modal.tsx)
  'settings.about.title': 'About {name}',
  'settings.about.description':
    'Terminal + Remote — control CLI tools from anywhere',
  'settings.about.author': 'Author',
  'settings.about.available': 'v{version} available',
  'settings.about.docs': 'Documentation',
  'settings.about.changelog': 'Changelog',
  'settings.about.issue': 'Report an issue',
  'settings.about.support': 'Support this project',
  'settings.about.sponsor': 'Sponsor',
  'settings.about.coffee': 'Coffee',
} as const
