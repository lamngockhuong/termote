import type { Session } from '../types/session'

// A tab running an agent with no logo here shows this instead
export const UNKNOWN_AGENT_ICON = '🤖'

// The agent whose logo a tab shows in place of its icon: the one in the
// tab's streamed pane, else in another of its panes; none once the user
// picked an icon for the tab.
export function tabIconAgent(session: Session): string | undefined {
  if (session.customIcon) return undefined
  return session.agentName ?? session.panes?.find((p) => p.agentName)?.agentName
}
