import { describe, expect, it } from 'vitest'
import {
  agentLabel,
  chatAgent,
  chatInputAgent,
  sessionFilesAgent,
} from './chat-agents'

describe('chat agents', () => {
  it('offers the Chat view of OpenCode, with input', () => {
    expect(chatAgent('opencode')).toBe(true)
    expect(chatInputAgent('opencode')).toBe(true)
    expect(agentLabel('opencode')).toBe('OpenCode')
  })

  it('reads the session files of Claude Code and Codex only', () => {
    expect(sessionFilesAgent('claude')).toBe(true)
    expect(sessionFilesAgent('codex')).toBe(true)
    expect(sessionFilesAgent('opencode')).toBe(false)
    expect(sessionFilesAgent(undefined)).toBe(false)
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
