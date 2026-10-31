// Shared dialogs, toasts and notices: the pieces every area uses, and the
// refusals told in a toast from App
export default {
  // A view or preview that could not load (components/lazy-boundary.tsx)
  'dialogs.loadFailed.retry': 'Try again',
  // A pane with no agent and no title, by its place in the tab
  'dialogs.pane.fallback': 'Pane {n}',
  // The Pane menu of the header (components/pane-layout-menu.tsx)
  'dialogs.paneMenu.label': 'Pane',
  'dialogs.paneMenu.splitRight': 'Split right',
  'dialogs.paneMenu.splitDown': 'Split down',
  'dialogs.paneMenu.zoom': 'Zoom',
  'dialogs.paneMenu.swapNext': 'Swap with next pane',
  'dialogs.paneMenu.resize': 'Resize',
  'dialogs.paneMenu.resizeLeft': 'Resize left',
  'dialogs.paneMenu.resizeRight': 'Resize right',
  'dialogs.paneMenu.resizeUp': 'Resize up',
  'dialogs.paneMenu.resizeDown': 'Resize down',
  'dialogs.paneMenu.close': 'Close pane',
  'dialogs.paneMenu.rename': 'Rename pane',
  // Naming a pane (components/pane-rename-dialog.tsx)
  'dialogs.paneRename.title': 'Rename pane',
  'dialogs.paneRename.label': 'Name',
  'dialogs.paneRename.placeholder': 'e.g. api, tests',
  'dialogs.paneRename.hint': 'Leave empty to remove the name',
  'dialogs.paneRename.save': 'Save',
  'dialogs.paneRename.tooLong': 'At most {n} bytes',
  'dialogs.paneRename.invalid':
    "A name cannot start with '-', end with ';' or hold control characters",
  'dialogs.paneRename.failed': 'Could not rename the pane',
  // A refused layout action, where errors.* says it otherwise
  'dialogs.paneLayout.busy': 'Busy, try again',
  'dialogs.paneLayout.unsupported': 'Not supported for this pane',
  'dialogs.paneLayout.failed': 'Could not change the panes',
  // A refused worktree change (components/worktree-dialog.tsx)
  'dialogs.worktree.invalidName': 'Not a valid branch name',
  'dialogs.worktree.branchExists':
    'This branch exists; it is checked out as it is, without a base',
  'dialogs.worktree.createFailed':
    'Git refused: the branch may be checked out elsewhere, or the folder exists',
  'dialogs.worktree.openFailed':
    'The checkout was made but could not be opened; use Open worktree',
  'dialogs.worktree.linkedSource':
    "Open it from the repository's own workspace",
  'dialogs.worktree.changed': 'This worktree changed; look again',
  'dialogs.worktree.ambiguous':
    'More than one worktree uses this branch; open it in Herdr',
  'dialogs.worktree.gone': 'It no longer exists; the list was refreshed',
  'dialogs.worktree.busy':
    'Another worktree change is still running; try again',
  'dialogs.worktree.unknown':
    'Herdr is still working on it; check the list in a moment',
  'dialogs.worktree.unsupported':
    'This Herdr cannot manage worktrees (needs 0.9.2 or later)',
  // An image that could not be attached (utils/upload-image.ts), where
  // errors.* says it otherwise
  'dialogs.upload.tooLarge': 'Image is larger than 10 MB',
  'dialogs.upload.heic':
    'HEIC images are not supported. Share the photo as JPEG',
  'dialogs.upload.storageFull':
    'Upload storage on the host is full. Try again later',
  'dialogs.upload.unavailable': 'This server cannot take image uploads',
  'dialogs.upload.network': 'Upload failed: network error',
  'dialogs.upload.timeout':
    'Upload took too long. Try a smaller image or a better connection',
  // The Chat view's attached images (hooks/use-chat-attachments.ts)
  'dialogs.upload.tooMany': 'At most {max} images per message.',
  'dialogs.upload.gone': 'No longer on the host',
  // Starting an agent from the Chat view (hooks/use-start-agent.ts)
  'dialogs.startAgent.paneBusy':
    'This pane is running something. Start the agent in a pane that shows only its shell.',
  'dialogs.startAgent.codexUnsupported': 'This server cannot start Codex.',
  'dialogs.startAgent.herdrUnsupported':
    'This Herdr cannot start agents. Update Herdr to 0.8.2 or later.',
  'dialogs.startAgent.gone': 'This pane is gone.',
  'dialogs.startAgent.pending':
    'Herdr still holds the last start in this pane for up to 30 seconds. Try again shortly.',
  'dialogs.startAgent.failed': 'Could not start the agent.',
  'dialogs.startAgent.lost':
    'Could not follow the start. Open the terminal to check.',
  'dialogs.startAgent.readyElsewhere': '{agent} is ready in another pane.',
  'dialogs.startAgent.askingHere':
    '{agent} is asking something in the terminal.',
  'dialogs.startAgent.askingElsewhere':
    "{agent} is asking something in another pane's terminal.",
  'dialogs.startAgent.notStartedHere':
    '{agent} did not start. Open the terminal to see why.',
  'dialogs.startAgent.notStartedElsewhere':
    '{agent} did not start in another pane.',
  // Settings lists read from the server
  'dialogs.devices.readFailed': 'Could not read the paired devices',
  'dialogs.signins.readFailed': 'Could not read the signed-in browsers',
  // A notification when an agent needs the user, shown by the page
  // (utils/agent-notify.ts) or by public/notify-sw.js for a push, which keeps
  // its own copy of these (notify-sw.test.ts holds the two to one table)
  'dialogs.notify.blocked': 'Agent needs you',
  'dialogs.notify.done': 'Agent finished',
  'dialogs.notify.agent': 'Agent',
  'dialogs.notify.fallback': 'An agent may need you',
} as const
