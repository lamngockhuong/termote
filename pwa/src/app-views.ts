import { MessagesSquare, SquareTerminal } from 'lucide-react'
import { type ComponentType, lazy } from 'react'
import { ChatComposer } from './components/chat-composer'
import type { ViewOption } from './components/ui/view-switcher'
import type { MuxInfo } from './hooks/use-local-sessions'
import type { Session } from './types/session'
import { CHAT_VIEW_ID, TERMINAL_VIEW_ID } from './view-ids'

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
  // Shows a view's Panel in the desktop side panel (null closes it)
  setSidePanel: (id: string | null) => void
  // Switches to another view of the pane (the terminal, as a way out)
  showView: (id: string) => void
}

// A view of the current pane (terminal; later chat, files). Adding one is
// adding an entry here: the header shows the switcher once two are available.
export interface AppView extends ViewOption<string> {
  available: (ctx: ViewContext) => boolean
  // Main area. The terminal view has none: App keeps the terminal mounted
  // under every view so switching back does not reconnect the stream.
  Main?: ComponentType<ViewProps>
  // Input area at the bottom (a chat composer). The terminal's is the toolbar.
  Input?: ComponentType<ViewProps>
  // Content of the desktop side panel, next to the terminal (changes, files)
  Panel?: ComponentType<ViewProps>
}

export { CHAT_VIEW_ID, TERMINAL_VIEW_ID }

// The chat view carries the markdown renderer: loaded on first use.
const ChatView = lazy(() => import('./components/chat-view'))

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
]

export function availableViews(views: AppView[], ctx: ViewContext): AppView[] {
  return views.filter((v) => v.available(ctx))
}

// Id of the element that shows a view (the switcher's aria-controls target).
export const viewPanelId = (id: string) => `view-panel-${id}`
