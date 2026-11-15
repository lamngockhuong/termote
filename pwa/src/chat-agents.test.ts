import { describe, expect, it } from 'vitest'
import { agentLabel, chatAgent, chatInputAgent } from './chat-agents'

describe('chat agents', () => {
  it('offers the Chat view of OpenCode, with input', () => {
    expect(chatAgent('opencode')).toBe(true)
    expect(chatInputAgent('opencode')).toBe(true)
    expect(agentLabel('opencode')).toBe('OpenCode')
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
