import { Bot } from 'lucide-react'
import { agentLabel, chatInputAgent } from '../chat-agents'
import type { Session } from '../types/session'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { Sheet } from './ui/sheet'

// A pane whose agent takes a message (the Chat view's input agents)
export interface AgentPaneChoice {
  sessionId: string
  paneId: string
  label: string
  agentName?: string
}

// Every pane of sessions that runs an agent a message can be sent to,
// other than exclude (the task's own pane)
export function agentPanes(
  sessions: Session[],
  exclude?: string,
): AgentPaneChoice[] {
  const out: AgentPaneChoice[] = []
  for (const s of sessions) {
    if (s.panes?.length) {
      for (const p of s.panes)
        if (p.hasAgent && chatInputAgent(p.agentName) && p.id !== exclude)
          out.push({
            sessionId: s.id,
            paneId: p.id,
            label: s.panes.length > 1 ? `${s.name} · ${p.label}` : s.name,
            agentName: p.agentName,
          })
    } else if (
      s.paneId &&
      s.hasAgent &&
      chatInputAgent(s.agentName) &&
      s.paneId !== exclude
    )
      out.push({
        sessionId: s.id,
        paneId: s.paneId,
        label: s.name,
        agentName: s.agentName,
      })
  }
  return out
}

const storeKey = (groupId: string) => `termote-task-agent:${groupId}`

// The agent pane last picked for the tasks of a group, kept on the device
export function rememberedAgent(groupId: string): string | null {
  try {
    return localStorage.getItem(storeKey(groupId))
  } catch {
    return null
  }
}

export function rememberAgent(groupId: string, paneId: string) {
  try {
    localStorage.setItem(storeKey(groupId), paneId)
  } catch {
    // Kept for this send only
  }
}

interface Props {
  isOpen: boolean
  choices: AgentPaneChoice[]
  onPick: (choice: AgentPaneChoice) => void
  onClose: () => void
}

// Which agent receives a task's output: the panes running one
export function AgentPanePicker({ isOpen, choices, onPick, onClose }: Props) {
  return (
    <Sheet isOpen={isOpen} onClose={onClose} title="Send to which agent?">
      {choices.length === 0 ? (
        <p className="p-4 text-sm text-fg-muted">
          No pane runs an agent that takes a message (Claude Code, Codex).
        </p>
      ) : (
        <ul className="flex flex-col gap-1 p-2">
          {choices.map((c) => (
            <li key={c.paneId}>
              <Button
                variant="ghost"
                size="grow"
                className="w-full justify-start text-left"
                onClick={() => onPick(c)}
              >
                <Bot size={16} aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {visibleUnsafe(c.label)}
                </span>
                <span className="shrink-0 text-[12px] text-fg-muted">
                  {agentLabel(c.agentName)}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}
