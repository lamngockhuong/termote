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

  it('shows each command under its label, all buttons as tall', () => {
    render(
      <PaneStrip
        panes={[
          { ...PANES[0], command: 'claude' },
          { ...PANES[1], command: 'vim' },
          { id: 'p3', label: 'Pane 3', hasAgent: false },
        ]}
        activePaneId="p1"
        onSelect={vi.fn()}
      />,
    )
    const buttons = within(
      screen.getByRole('group', { name: 'Panes' }),
    ).getAllByRole('button')
    // A command equal to the label is not repeated
    expect(buttons.map((b) => b.textContent)).toEqual([
      'claude',
      'logsvim',
      'Pane 3',
    ])
    for (const b of buttons) expect(b).toHaveClass('h-9')
  })

  it('keeps one line without commands', () => {
    render(<PaneStrip panes={PANES} activePaneId="p1" onSelect={vi.fn()} />)
    for (const b of screen.getAllByRole('button')) expect(b).toHaveClass('h-7')
  })

  it('selects a pane on click', () => {
    const onSelect = vi.fn()
    render(<PaneStrip panes={PANES} activePaneId="p1" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'logs' }))
    expect(onSelect).toHaveBeenCalledWith('p2')
  })

  it('has no close buttons without onClose', () => {
    render(<PaneStrip panes={PANES} activePaneId="p1" onSelect={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Close pane/ })).toBeNull()
  })

  it('asks to close a pane without selecting it', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <PaneStrip
        panes={PANES}
        activePaneId="p1"
        onSelect={onSelect}
        onClose={onClose}
      />,
    )
    const group = screen.getByRole('group', { name: 'Panes' })
    expect(
      within(group)
        .getAllByRole('button', { name: /^Close pane/ })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Close pane claude', 'Close pane logs'])
    fireEvent.click(screen.getByRole('button', { name: 'Close pane logs' }))
    expect(onClose).toHaveBeenCalledWith('p2')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
