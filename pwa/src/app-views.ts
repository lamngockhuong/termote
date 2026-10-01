import {
  FolderTree,
  GitCompare,
  MessagesSquare,
  SquareTerminal,
} from 'lucide-react'
import { type ComponentType, lazy } from 'react'
import { ChatComposer } from './components/chat-composer'
import type { ViewOption } from './components/ui/view-switcher'
import type { MuxInfo } from './hooks/use-local-sessions'
import type { Session } from './types/session'
import {
  CHANGES_VIEW_ID,
  CHAT_VIEW_ID,
  FILES_VIEW_ID,
  TERMINAL_VIEW_ID,
} from './view-ids'

// What decides whether a view is offered, and what a view is drawn with.
export interface ViewContext {
  mux: MuxInfo
  // Tab (and its streamed pane) on screen
  session: Session
  // View-only role: no view may offer a way to send input
  readOnly: boolean
}

export interface ViewProps extends ViewContext {
  isMobile: boolean
  // A short notice (a toast)
  notify: (message: string) => void
  // Switches to another view of the pane (the terminal, as a way out)
  showView: (id: string) => void
}

// A view of the current pane (terminal, chat, files, changes). Adding one is adding an
// entry here: the header shows the switcher once two are available.
export interface AppView extends ViewOption<string> {
  available: (ctx: ViewContext) => boolean
  // Main area. The terminal view has none: App keeps the terminal mounted
  // under every view so switching back does not reconnect the stream.
  Main?: ComponentType<ViewProps>
  // Input area at the bottom (a chat composer). The terminal's is the toolbar.
  Input?: ComponentType<ViewProps>
  // Content of the desktop side panel, next to the terminal (changes, files)
  Panel?: ComponentType<ViewProps>
  // 'panel': on desktop the view opens in the side panel from a header
  // toggle instead of taking the switcher's place; mobile keeps it in the
  // switcher with its Main.
  placement?: 'panel'
}

export { CHANGES_VIEW_ID, CHAT_VIEW_ID, FILES_VIEW_ID, TERMINAL_VIEW_ID }

// The chat view carries the markdown renderer: loaded on first use.
const ChatView = lazy(() => import('./components/chat-view'))
// Files and Changes: loaded the first time one is opened.
const FilesView = lazy(() => import('./components/files-view'))
const ChangesView = lazy(() => import('./components/changes-view'))

export const APP_VIEWS: AppView[] = [
  {
    id: TERMINAL_VIEW_ID,
    label: 'Terminal',
    Icon: SquareTerminal,
    available: () => true,
  },
  {
    id: CHAT_VIEW_ID,
    label: 'Chat',
    Icon: MessagesSquare,
    // Claude Code only: the server reads its transcript and its screen.
    available: ({ mux, session }) =>
      !!mux.caps.agentChat &&
      !!session.hasAgent &&
      session.agentName === 'claude',
    Main: ChatView,
    Input: ChatComposer,
  },
  {
    id: FILES_VIEW_ID,
    label: 'Files',
    Icon: FolderTree,
    // The server reports the pane's directory (tmux on Linux/macOS, Herdr)
    available: ({ mux }) => !!mux.caps.files,
    Main: FilesView,
    Panel: FilesView,
    placement: 'panel',
  },
  {
    id: CHANGES_VIEW_ID,
    label: 'Changes',
    Icon: GitCompare,
    // Same routes; a root outside a repo says so in the view
    available: ({ mux }) => !!mux.caps.files,
    Main: ChangesView,
    Panel: ChangesView,
    placement: 'panel',
  },
]

export function availableViews(views: AppView[], ctx: ViewContext): AppView[] {
  return views.filter((v) => v.available(ctx))
}

// Id of the element that shows a view (the switcher's aria-controls target).
export const viewPanelId = (id: string) => `view-panel-${id}`
