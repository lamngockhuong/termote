import { SquareTerminal } from 'lucide-react'
import type { ComponentType } from 'react'
import type { ViewOption } from './components/ui/view-switcher'
import type { MuxInfo } from './hooks/use-local-sessions'
import type { Session } from './types/session'

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

export const TERMINAL_VIEW_ID = 'terminal'

export const APP_VIEWS: AppView[] = [
  {
    id: TERMINAL_VIEW_ID,
    label: 'Terminal',
    Icon: SquareTerminal,
    available: () => true,
  },
]

export function availableViews(views: AppView[], ctx: ViewContext): AppView[] {
  return views.filter((v) => v.available(ctx))
}

// Id of the element that shows a view (the switcher's aria-controls target).
export const viewPanelId = (id: string) => `view-panel-${id}`
