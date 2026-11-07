import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Session } from '../types/session'
import { AgentLogo, hasAgentLogo } from './agent-logo'
import { TabIcon } from './tab-icon'

const tab = (extra: Partial<Session> = {}): Session => ({
  id: 't',
  name: 'tab',
  icon: '📺',
  description: '',
  ...extra,
})

const logo = (c: HTMLElement) =>
  c.querySelector('svg')?.getAttribute('data-agent-logo')

describe('TabIcon', () => {
  it('shows the tab icon while no agent runs', () => {
    const { container } = render(<TabIcon session={tab()} />)
    expect(container.textContent).toBe('📺')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('shows the logo of the agent the tab runs', () => {
    for (const agent of ['claude', 'codex']) {
      const { container } = render(
        <TabIcon session={tab({ agentName: agent })} />,
      )
      expect(logo(container)).toBe(agent)
      expect(container.textContent).toBe('')
    }
  })

  it('shows a robot for an agent with no logo here', () => {
    const { container } = render(
      <TabIcon session={tab({ agentName: 'droid' })} />,
    )
    expect(container.textContent).toBe('🤖')
  })

  it('shows the icon the user picked over the agent logo', () => {
    const { container } = render(
      <TabIcon
        session={tab({ icon: '🚀', customIcon: true, agentName: 'claude' })}
      />,
    )
    expect(container.textContent).toBe('🚀')
    expect(container.querySelector('svg')).toBeNull()
  })
})

describe('AgentLogo', () => {
  it('knows only its own agents, not names an object inherits', () => {
    expect(hasAgentLogo('claude')).toBe(true)
    expect(hasAgentLogo('toString')).toBe(false)
    expect(hasAgentLogo(undefined)).toBe(false)
    const { container } = render(<AgentLogo agent="toString" />)
    expect(container.innerHTML).toBe('')
  })

  it('draws every logo hidden from screen readers', () => {
    for (const agent of [
      'claude',
      'codex',
      'gemini',
      'copilot',
      'cursor',
      'opencode',
      'amp',
      'kimi',
      'qwen',
      'grok',
      'kiro',
      'cline',
      'devin',
      'agy',
      'mastracode',
    ]) {
      const { container } = render(<AgentLogo agent={agent} />)
      const svg = container.querySelector('svg')!
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.querySelector('path')).not.toBeNull()
    }
  })

  it('gives each drawing its own gradient ids', () => {
    const { container } = render(
      <>
        <AgentLogo agent="codex" />
        <AgentLogo agent="codex" />
      </>,
    )
    const ids = [...container.querySelectorAll('linearGradient')].map(
      (g) => g.id,
    )
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^[\w-]+$/)
    // Each fill points at its own drawing's gradient
    const fills = [...container.querySelectorAll('svg')].map((svg) =>
      [...svg.querySelectorAll('path')]
        .map((p) => p.getAttribute('fill'))
        .find((f) => f?.startsWith('url(')),
    )
    expect(fills).toEqual(ids.map((id) => `url(#${id})`))
  })
})
