import type { Session } from '../types/session'
import { tabIconAgent, UNKNOWN_AGENT_ICON } from '../utils/tab-icon'
import { AgentLogo, hasAgentLogo } from './agent-logo'

// A tab's icon: the one the user picked, else the logo of the agent it runs
// (🤖 for an agent with no logo here), else the default one.
export function TabIcon({ session }: { session: Session }) {
  const agent = tabIconAgent(session)
  if (!agent) return session.icon
  if (!hasAgentLogo(agent)) return UNKNOWN_AGENT_ICON
  return <AgentLogo agent={agent} />
}
