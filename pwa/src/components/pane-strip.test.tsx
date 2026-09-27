import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionPane } from '../types/session'
import { PaneStrip } from './pane-strip'

const PANES: SessionPane[] = [
  { id: 'p1', label: 'claude', hasAgent: true, agentStatus: 'working' },
  { id: 'p2', label: 'logs', hasAgent: false },
]

describe('PaneStrip', () => {
  it('renders nothing for a single pane', () => {
    const { container } = render(
      <PaneStrip panes={[PANES[0]]} activePaneId="p1" onSelect={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('lists panes with their badge and marks the streamed one', () => {
    render(<PaneStrip panes={PANES} activePaneId="p2" onSelect={vi.fn()} />)
    const group = screen.getByRole('group', { name: 'Panes' })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['claude', 'logs'])
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'false')
    expect(buttons[1]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('img', { name: 'Agent working' })).toBeVisible()
  })

  it('selects a pane on click', () => {
    const onSelect = vi.fn()
    render(<PaneStrip panes={PANES} activePaneId="p1" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'logs' }))
    expect(onSelect).toHaveBeenCalledWith('p2')
  })
})
