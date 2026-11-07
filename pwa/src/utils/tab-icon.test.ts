import { describe, expect, it } from 'vitest'
import type { Session } from '../types/session'
import { tabIconAgent } from './tab-icon'

const tab = (extra: Partial<Session> = {}): Session => ({
  id: 't',
  name: 'tab',
  icon: '📺',
  description: '',
  ...extra,
})

const pane = (agentName?: string) => ({
  id: `p-${agentName}`,
  label: 'pane',
  hasAgent: !!agentName,
  agentName,
})

describe('tabIconAgent', () => {
  it('names no agent for a tab running none', () => {
    expect(tabIconAgent(tab())).toBeUndefined()
    expect(tabIconAgent(tab({ panes: [pane()] }))).toBeUndefined()
  })

  it('names the agent of the streamed pane first, else of another pane', () => {
    expect(
      tabIconAgent(tab({ agentName: 'codex', panes: [pane('claude')] })),
    ).toBe('codex')
    expect(tabIconAgent(tab({ panes: [pane(), pane('claude')] }))).toBe(
      'claude',
    )
  })

  it('names none once the user picked an icon', () => {
    expect(
      tabIconAgent(tab({ agentName: 'claude', customIcon: true })),
    ).toBeUndefined()
  })
})
