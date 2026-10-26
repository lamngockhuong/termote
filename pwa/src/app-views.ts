import {
  FolderTree,
  GitCompare,
  ListChecks,
  MessagesSquare,
  SquareTerminal,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { chatAgent } from './chat-agents'
import { ChatInput } from './components/chat-input'
import type { ToastAction, ToastVariant } from './components/toast'
import type { ViewOption } from './components/ui/view-switcher'
import type { MuxInfo } from './hooks/use-local-sessions'
import type { AgentStartControl } from './hooks/use-start-agent'
import type { Session } from './types/session'
import { canStartAgent } from './utils/agent-start'
import { lazyRetry, type Retryable } from './utils/lazy-retry'
import type { OpenWindowEvent } from './utils/open-window'
import {
  CHANGES_VIEW_ID,
  CHAT_VIEW_ID,
  FILES_VIEW_ID,
  TASKS_VIEW_ID,
  TERMINAL_VIEW_ID,
} from './view-ids'

export interface NotifyOptions {
  action?: ToastAction
  variant?: ToastVariant
  duration?: number
}

// What decides whether a view is offered, and what a view is drawn with.
export interface ViewContext {
  mux: MuxInfo
  // Tab (and its streamed pane) on screen
  session: Session
  // View-only role: no view may offer a way to send input
  readOnly: boolean
  // Agents started from this page (App's useStartAgent)
  agentStart?: AgentStartControl
}

export interface ViewProps extends ViewContext {
  isMobile: boolean
  // A short notice (a toast), with a button (Undo) or a tone when given
  notify: (message: string, options?: NotifyOptions) => void
  // Switches to another view of the pane (the terminal, as a way out)
  showView: (id: string) => void
  // Opens Settings, at a group when given (the composer's Manage templates)
  openSettings?: (group?: string) => void
  // Opens a file of the pane, or a side's diff, in a window of its own
  // (desktop only; Shift asks for a popup)
  openWindow?: (target: FileWindowTarget, e: OpenWindowEvent) => void
  // Every tab, for a view that names another pane (Tasks' agent picker)
  sessions?: Session[]
  // Shows a tab (and pane), then a view of it when given (a task's tab,
  // the Chat of the agent its output went to)
  openTab?: (id: string, paneId?: string, view?: string) => void
  // Reads the tabs again (a tab the server just opened)
  refreshSessions?: () => Promise<void>
}

// A file under the pane's root in the Files view, or its diff in Changes
export interface FileWindowTarget {
  view: 'files' | 'changes'
  file: string
  staged?: boolean
  orig?: string
}

// A view component, or a lazy one with retry() for a chunk that failed to load
type LazyView = ComponentType<ViewProps> &
  Partial<Pick<Retryable<ViewProps>, 'retry'>>

// A view of the current pane (terminal, chat, files, changes). Adding one is adding an
// entry here: the header shows the switcher once two are available.
export interface AppView extends ViewOption<string> {
  available: (ctx: ViewContext) => boolean
  // Main area. The terminal view has none: App keeps the terminal mounted
  // under every view so switching back does not reconnect the stream.
  Main?: LazyView
  // Input area at the bottom (a chat composer). The terminal's is the toolbar.
  Input?: ComponentType<ViewProps>
  // Content of the desktop side panel, next to the terminal (changes, files)
  Panel?: LazyView
  // 'panel': on desktop the view opens in the side panel from a header
  // toggle instead of taking the switcher's place; mobile keeps it in the
  // switcher with its Main.
  placement?: 'panel'
}

export {
  CHANGES_VIEW_ID,
  CHAT_VIEW_ID,
  FILES_VIEW_ID,
  TASKS_VIEW_ID,
  TERMINAL_VIEW_ID,
}

// The chat view carries the markdown renderer: loaded on first use.
const ChatView = lazyRetry<ViewProps>(
  () => import('./components/chat-view'),
  'ChatView',
)
// Files and Changes: loaded the first time one is opened.
const FilesView = lazyRetry<ViewProps>(
  () => import('./components/files-view'),
  'FilesView',
)
const ChangesView = lazyRetry<ViewProps>(
  () => import('./components/changes-view'),
  'ChangesView',
)
const TasksView = lazyRetry<ViewProps>(
  () => import('./components/tasks-view'),
  'TasksView',
)

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
    // An agent whose transcript the server reads (chat-agents.ts), or a
    // pane where one can be started or was started from this page
    available: (ctx) =>
      (!!ctx.mux.caps.agentChat &&
        !!ctx.session.hasAgent &&
        chatAgent(ctx.session.agentName)) ||
      startOffered(ctx),
    Main: ChatView,
    Input: ChatInput,
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
  {
    id: TASKS_VIEW_ID,
    label: 'Tasks',
    Icon: ListChecks,
    // The server lists and runs the root's tasks; they run commands, so a
    // full client only
    available: ({ mux, readOnly }) => !!mux.caps.tasks && !readOnly,
    Main: TasksView,
  },
]

// The Chat view of a pane without an agent: its start, or the start made
// there from this page while the snapshot does not show the agent yet (a
// refused one only while the pane can still start one).
export function startOffered({
  mux,
  session,
  readOnly,
  agentStart,
}: ViewContext): boolean {
  if (readOnly || !mux.caps.agentStart || session.hasAgent) return false
  const record = session.paneId ? agentStart?.starts[session.paneId] : undefined
  return canStartAgent(mux, session) || (!!record && record.phase !== 'failed')
}

export function availableViews(views: AppView[], ctx: ViewContext): AppView[] {
  return views.filter((v) => v.available(ctx))
}

// Id of the element that shows a view (the switcher's aria-controls target).
export const viewPanelId = (id: string) => `view-panel-${id}`
