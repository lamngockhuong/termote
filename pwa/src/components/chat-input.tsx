import type { ViewProps } from '../app-views'
import { chatInputAgent } from '../chat-agents'
import { ChatComposer } from './chat-composer'
import { OpenTerminalButton } from './open-terminal-button'
import { ReadOnlyBar } from './read-only-bar'

// The Chat view's input area: the composer for an agent the server can write
// to, else a bar that points to the terminal.
export function ChatInput(props: ViewProps) {
  if (chatInputAgent(props.session.agentName))
    return <ChatComposer {...props} />
  return (
    <ReadOnlyBar
      label="Read only"
      action={<OpenTerminalButton showView={props.showView} />}
    />
  )
}
