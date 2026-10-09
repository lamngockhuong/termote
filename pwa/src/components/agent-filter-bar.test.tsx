import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '../utils/session-filter'
import { AgentFilterBar } from './agent-filter-bar'

describe('AgentFilterBar', () => {
  const summary: SessionSummary = {
    blocked: 2,
    working: 3,
    agents: 5,
  }

  function renderBar(
    overrides: Partial<Parameters<typeof AgentFilterBar>[0]> = {},
  ) {
    const onChange = vi.fn()
    const defaults = {
      summary,
      filter: 'all' as const,
      onChange,
      ...overrides,
    }
    render(<AgentFilterBar {...defaults} />)
    return { onChange }
  }

  it('renders four segment options as radio buttons', () => {
    renderBar()
    const radios = screen.getAllByRole('radio')
    expect(radios.length).toBeGreaterThanOrEqual(4)
  })

  it('displays all sessions label', () => {
    renderBar()
    const btn = screen.getByRole('radio', { name: 'All sessions' })
    expect(btn).toBeInTheDocument()
  })

  it('displays blocked count with correct aria-label', () => {
    renderBar()
    const btn = screen.getByRole('radio', { name: 'Needs you, 2 sessions' })
    expect(btn).toBeInTheDocument()
  })

  it('uses singular "session" for count of 1', () => {
    renderBar({ summary: { blocked: 1, working: 3, agents: 5 } })
    const btn = screen.getByRole('radio', { name: 'Needs you, 1 session' })
    expect(btn).toBeInTheDocument()
  })

  it('displays working count with correct aria-label', () => {
    renderBar()
    const btn = screen.getByRole('radio', { name: 'Working, 3 sessions' })
    expect(btn).toBeInTheDocument()
  })

  it('displays agents count with correct aria-label', () => {
    renderBar()
    const btn = screen.getByRole('radio', { name: 'Agents, 5 sessions' })
    expect(btn).toBeInTheDocument()
  })

  it('calls onChange when needs-you radio clicked', () => {
    const { onChange } = renderBar()
    const btn = screen.getByRole('radio', { name: /Needs you/ })
    fireEvent.click(btn)
    expect(onChange).toHaveBeenCalledWith('needs-you')
  })

  it('calls onChange when working radio clicked', () => {
    const { onChange } = renderBar()
    const btn = screen.getByRole('radio', { name: /Working/ })
    fireEvent.click(btn)
    expect(onChange).toHaveBeenCalledWith('working')
  })

  it('calls onChange when agents radio clicked', () => {
    const { onChange } = renderBar()
    const btn = screen.getByRole('radio', { name: /Agents/ })
    fireEvent.click(btn)
    expect(onChange).toHaveBeenCalledWith('agents')
  })

  it('calls onChange when all radio clicked', () => {
    const { onChange } = renderBar({ filter: 'needs-you' })
    const btn = screen.getByRole('radio', { name: 'All sessions' })
    fireEvent.click(btn)
    expect(onChange).toHaveBeenCalledWith('all')
  })

  it('displays zero counts correctly', () => {
    renderBar({ summary: { blocked: 0, working: 0, agents: 0 } })
    expect(
      screen.getByRole('radio', { name: 'Needs you, 0 sessions' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: 'Working, 0 sessions' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: 'Agents, 0 sessions' }),
    ).toBeInTheDocument()
  })

  it('displays high counts correctly', () => {
    renderBar({ summary: { blocked: 99, working: 100, agents: 200 } })
    expect(
      screen.getByRole('radio', { name: 'Needs you, 99 sessions' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: 'Working, 100 sessions' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: 'Agents, 200 sessions' }),
    ).toBeInTheDocument()
  })

  it('shows count in the radio content', () => {
    renderBar()
    const blockBtn = screen.getByRole('radio', {
      name: 'Needs you, 2 sessions',
    })
    expect(blockBtn).toHaveTextContent('2')
  })

  it('renders icon for blocked status (CircleAlert)', () => {
    renderBar()
    const needsYouBtn = screen.getByRole('radio', {
      name: 'Needs you, 2 sessions',
    })
    expect(needsYouBtn.querySelector('svg')).toBeInTheDocument()
  })

  it('renders icon for working status (LoaderCircle)', () => {
    renderBar()
    const workingBtn = screen.getByRole('radio', {
      name: 'Working, 3 sessions',
    })
    expect(workingBtn.querySelector('svg')).toBeInTheDocument()
  })

  it('spins the working icon only while agents are working', () => {
    renderBar()
    const spinning = screen
      .getByRole('radio', { name: 'Working, 3 sessions' })
      .querySelector('svg')
    expect(spinning).toHaveClass('text-warning', 'motion-safe:animate-spin')
    const others = ['Needs you, 2 sessions', 'Agents, 5 sessions'].map((name) =>
      screen.getByRole('radio', { name }).querySelector('svg'),
    )
    for (const icon of others) {
      expect(icon).not.toHaveClass('motion-safe:animate-spin')
    }
  })

  it('keeps the working icon still and muted at zero', () => {
    renderBar({ summary: { blocked: 0, working: 0, agents: 0 } })
    const icon = screen
      .getByRole('radio', { name: 'Working, 0 sessions' })
      .querySelector('svg')
    expect(icon).toHaveClass('text-fg-subtle')
    expect(icon).not.toHaveClass('motion-safe:animate-spin')
  })

  it('renders icon for agents (Bot)', () => {
    renderBar()
    const agentsBtn = screen.getByRole('radio', { name: 'Agents, 5 sessions' })
    expect(agentsBtn.querySelector('svg')).toBeInTheDocument()
  })

  it('has title attribute on count span showing label', () => {
    renderBar()
    const needsYouBtn = screen.getByRole('radio', {
      name: 'Needs you, 2 sessions',
    })
    const titleSpan = needsYouBtn.querySelector('span[title]')
    expect(titleSpan).toHaveAttribute('title', 'Needs you, 2 sessions')
  })
})
