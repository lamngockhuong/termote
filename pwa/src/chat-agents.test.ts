import { describe, expect, it } from 'vitest'
import {
  agentLabel,
  chatAgent,
  chatInputAgent,
  historyImageAgent,
  reportedCostAgent,
  sessionFilesAgent,
  subagentAgent,
} from './chat-agents'

describe('chat agents', () => {
  it('offers the Chat view of OpenCode, with input', () => {
    expect(chatAgent('opencode')).toBe(true)
    expect(chatInputAgent('opencode')).toBe(true)
    expect(agentLabel('opencode')).toBe('OpenCode')
  })

  it('reads the session files of Claude Code, Codex and OpenCode', () => {
    expect(sessionFilesAgent('claude')).toBe(true)
    expect(sessionFilesAgent('codex')).toBe(true)
    expect(sessionFilesAgent('opencode')).toBe(true)
    expect(sessionFilesAgent('aider')).toBe(false)
    expect(sessionFilesAgent(undefined)).toBe(false)
  })

  it('knows OpenCode records its own cost', () => {
    expect(reportedCostAgent('opencode')).toBe(true)
    expect(reportedCostAgent('claude')).toBe(false)
    expect(reportedCostAgent(undefined)).toBe(false)
  })

  it('reads the subagents of Claude Code and OpenCode', () => {
    expect(subagentAgent('claude')).toBe(true)
    expect(subagentAgent('opencode')).toBe(true)
    expect(subagentAgent('codex')).toBe(false)
    expect(subagentAgent(undefined)).toBe(false)
  })

  it("serves an old OpenCode session's images only", () => {
    expect(historyImageAgent('opencode')).toBe(true)
    expect(historyImageAgent('claude')).toBe(false)
    expect(historyImageAgent(undefined)).toBe(false)
  })

  it('knows Claude Code and Codex, not other agents', () => {
    expect(chatInputAgent('claude')).toBe(true)
    expect(chatAgent('pi')).toBe(false)
    expect(chatAgent(undefined)).toBe(false)
    expect(chatInputAgent(undefined)).toBe(false)
    expect(agentLabel('pi')).toBe('agent')
    expect(agentLabel(undefined)).toBe('agent')
  })
})
