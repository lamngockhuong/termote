import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type OverviewTabDef, OverviewTabs } from './overview-tabs'

const TABS: OverviewTabDef[] = [
  { id: 'agents', label: 'Agents · 2', name: 'Agents, 2 agents' },
  {
    id: 'plan',
    label: 'Plan · 1 open',
    alert: '1 waiting',
    name: 'Plan, 1 open, 1 waiting',
  },
]

describe('OverviewTabs', () => {
  it('names each tab with its counts and ties it to its panel', () => {
    const onChange = vi.fn()
    render(
      <OverviewTabs
        label="Sections"
        tabs={TABS}
        value="plan"
        onChange={onChange}
        idPrefix="x"
      />,
    )
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeVisible()
    const agents = screen.getByRole('tab', { name: 'Agents, 2 agents' })
    const plan = screen.getByRole('tab', { name: 'Plan, 1 open, 1 waiting' })
    expect(agents).toHaveAttribute('id', 'x-tab-agents')
    expect(agents).toHaveAttribute('aria-controls', 'x-panel-agents')
    expect(agents).toHaveAttribute('aria-selected', 'false')
    expect(agents).toHaveAttribute('tabindex', '-1')
    expect(plan).toHaveAttribute('aria-selected', 'true')
    expect(plan).toHaveAttribute('tabindex', '0')
    // The words show, not only to a screen reader
    expect(agents).toHaveTextContent('Agents · 2')
    expect(plan).toHaveTextContent('Plan · 1 open1 waiting')
    fireEvent.click(agents)
    expect(onChange).toHaveBeenCalledWith('agents')
  })
})
