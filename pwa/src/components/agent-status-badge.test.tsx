import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AgentStatusBadge } from './agent-status-badge'

describe('AgentStatusBadge', () => {
  it('renders nothing without a status', () => {
    const { container } = render(<AgentStatusBadge />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['blocked', 'Agent blocked'],
    ['working', 'Agent working'],
    ['done', 'Agent done'],
    ['idle', 'Agent idle'],
  ] as const)('labels %s for assistive tech', (status, label) => {
    render(<AgentStatusBadge status={status} />)
    const badge = screen.getByRole('img', { name: label })
    expect(badge).toHaveAttribute('data-status', status)
    expect(badge).toHaveAttribute('title', label)
  })

  it('draws a different icon per status, not only a colour', () => {
    const { container: blocked } = render(<AgentStatusBadge status="blocked" />)
    const { container: done } = render(<AgentStatusBadge status="done" />)
    expect(blocked.querySelector('svg')?.getAttribute('class')).not.toBe(
      done.querySelector('svg')?.getAttribute('class'),
    )
  })

  it('passes the size to the icon', () => {
    const { container } = render(<AgentStatusBadge status="idle" size={10} />)
    expect(container.querySelector('svg')).toHaveAttribute('width', '10')
  })
})
