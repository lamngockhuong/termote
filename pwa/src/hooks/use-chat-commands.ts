import { useMemo } from 'react'
import { chatInputAgent } from '../chat-agents'
import {
  BUILTIN_COMMANDS,
  mergeSlashCommands,
  type SlashCommand,
  withTriggers,
} from '../utils/slash-commands'
import { useAgentCommands } from './use-agent-commands'

const NONE: SlashCommand[] = []

// The commands and skills the pane's agent knows, each after its trigger:
// its built-ins, and the custom ones the server lists for an agent the Chat
// view can type to (shared with the composer's list). History, read for an
// agent the pane may no longer run, passes no pane: built-ins only.
export function useChatCommands(
  paneId: string | undefined,
  agentName: string | undefined,
): SlashCommand[] {
  const name = agentName ?? ''
  const custom = useAgentCommands(
    paneId ?? '',
    !!paneId && chatInputAgent(name),
  )
  const key = custom.length ? custom : NONE
  return useMemo(
    () =>
      mergeSlashCommands(
        BUILTIN_COMMANDS[name] ?? NONE,
        withTriggers(name, key),
      ),
    [name, key],
  )
}
