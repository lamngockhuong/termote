import type { ViewProps } from '../app-views'
import { chatInputAgent } from '../chat-agents'
import { useT } from '../i18n/i18n-context'
import { ChatComposer } from './chat-composer'
import { OpenTerminalButton } from './open-terminal-button'
import { ReadOnlyBar } from './read-only-bar'

// The Chat view's input area: the composer for an agent the server can write
// to, else a bar that points to the terminal. A pane with no agent (its
// start panel) has none.
export function ChatInput(props: ViewProps) {
  const { t } = useT()
  if (!props.session.hasAgent) return null
  if (chatInputAgent(props.session.agentName))
    return <ChatComposer {...props} />
  return (
    <ReadOnlyBar
      label={t('chat.input.readOnly')}
      action={<OpenTerminalButton showView={props.showView} />}
    />
  )
}
