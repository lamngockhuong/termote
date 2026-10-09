import { useEffect, useState } from 'react'
import { onPaneRemap } from '../utils/pane-remap'
import { type AgentCommand, fetchAgentCommands } from './use-mux-api'

// How long a pane's custom commands are reused before they are read again.
export const COMMANDS_TTL = 30_000

interface Entry {
  at: number
  commands: Promise<AgentCommand[]>
}

const cache = new Map<string, Entry>()

// A pane id that names another pane now reads its own list.
onPaneRemap((shift) => {
  for (const id of shift.stale) cache.delete(id)
})

// Drops every cached listing (tests).
export function clearAgentCommandsCache() {
  cache.clear()
}

// A pane's custom commands, read once the list is first wanted and shared
// for COMMANDS_TTL. A failed read (another backend, no agent, the network)
// is an empty list, so the built-ins still show, and is not kept.
function load(paneId: string): Promise<AgentCommand[]> {
  const now = Date.now()
  const hit = cache.get(paneId)
  if (hit && now - hit.at < COMMANDS_TTL) return hit.commands
  const entry: Entry = {
    at: now,
    commands: fetchAgentCommands(paneId).catch(() => {
      // Only this read's entry: a newer one for the pane stays
      if (cache.get(paneId) === entry) cache.delete(paneId)
      return []
    }),
  }
  cache.set(paneId, entry)
  return entry.commands
}

export function useAgentCommands(
  paneId: string,
  enabled: boolean,
): AgentCommand[] {
  const [state, setState] = useState<{
    paneId: string
    commands: AgentCommand[]
  }>({ paneId, commands: [] })

  useEffect(() => {
    if (!enabled || !paneId) return
    let live = true
    load(paneId).then((commands) => {
      if (live) setState({ paneId, commands })
    })
    return () => {
      live = false
    }
  }, [paneId, enabled])

  // Another pane's list is never shown while this one loads.
  return state.paneId === paneId ? state.commands : []
}
