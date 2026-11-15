import type { MuxInfo } from '../hooks/use-local-sessions'
import type { Session } from '../types/session'
import { isShell } from './shells'

// The foreground process of the pane the tab streams. A Session carries
// only its panes' commands.
export function paneCommand(session: Session): string | undefined {
  return session.panes?.find((p) => p.id === session.paneId)?.command
}

// An agent can be started in the pane: the server can, no agent runs there
// and the pane shows only its shell.
export function canStartAgent(mux: MuxInfo, session: Session): boolean {
  return (
    !!mux.caps.agentStart &&
    !!session.paneId &&
    !session.hasAgent &&
    isShell(paneCommand(session))
  )
}

// A session of the history can be resumed in the pane itself: the server
// runs tasks (it types the command line as it types a task's) and the pane
// shows only its shell, no agent.
export function canResumeHere(mux: MuxInfo, session: Session): boolean {
  return (
    !!mux.caps.tasks &&
    !!session.paneId &&
    !session.hasAgent &&
    isShell(paneCommand(session))
  )
}
