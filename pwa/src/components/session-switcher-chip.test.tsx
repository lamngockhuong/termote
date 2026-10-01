import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import { SessionSwitcherChip } from './session-switcher-chip'

const SESSION: Session = {
  id: '1',
  name: 'claude',
  icon: '🤖',
  description: '',
  agentStatus: 'working',
}

function renderChip(
  props: Partial<Parameters<typeof SessionSwitcherChip>[0]> = {},
) {
  const onClick = vi.fn()
  render(
    <SessionSwitcherChip
      session={SESSION}
      sessionCount={3}
      connectionState="connected"
      expanded={false}
      onClick={onClick}
      {...props}
    />,
  )
  // The aria-label may be "Open sessions menu" or include blockedElsewhere count
  const chip = screen.getByRole('button', { name: /Open sessions menu/ })
  return {
    onClick,
    chip,
  }
}

describe('SessionSwitcherChip', () => {
  it('shows the session, its agent badge and the tab count', () => {
    const { chip } = renderChip({ groupName: 'termote' })
    expect(chip).toHaveTextContent('🤖')
    expect(chip).toHaveTextContent('claude')
    expect(chip).toHaveTextContent('termote · 3 sessions')
    expect(screen.getByRole('img', { name: 'Agent working' })).toBeVisible()
  })

  it('leaves out a missing group and counts one session', () => {
    const { chip } = renderChip({ sessionCount: 1 })
    expect(chip).toHaveTextContent(/^🤖claude1 session$/)
  })

  it('shows the connection state as a dot', () => {
    const { chip } = renderChip({ connectionState: 'disconnected' })
    expect(chip.querySelector('[data-state]')).toHaveAttribute(
      'data-state',
      'disconnected',
    )
  })

  it('opens the sessions sheet and reports whether it is open', () => {
    const { chip, onClick } = renderChip({ expanded: true })
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog')
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(chip)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('shows the blocked-elsewhere count badge when there are blocked sessions elsewhere', () => {
    renderChip({ blockedElsewhere: 2 })
    const badge = screen.getByTestId('blocked-elsewhere')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('2')
  })

  it('hides the chevron when there are blocked sessions elsewhere', () => {
    const { chip } = renderChip({ blockedElsewhere: 2 })
    // When blockedElsewhere > 0, the badge replaces the chevron
    const chevron = chip.querySelector('svg[class*="chevron"]')
    expect(chevron).not.toBeInTheDocument()
    // And the badge should be there instead
    const badge = screen.getByTestId('blocked-elsewhere')
    expect(badge).toBeInTheDocument()
  })

  it('shows the chevron when blockedElsewhere is 0', () => {
    renderChip({ blockedElsewhere: 0 })
    // When blockedElsewhere is 0, the chevron should be visible
    const chip = screen.getByRole('button', { name: /Open sessions menu/ })
    const chevron = chip.querySelector('svg[class*="chevron"]')
    expect(chevron).toBeInTheDocument()
  })

  it('updates aria-label to include blocked sessions count (singular)', () => {
    const { chip } = renderChip({ blockedElsewhere: 1 })
    expect(chip).toHaveAccessibleName(
      'Open sessions menu, 1 other session needs you',
    )
  })

  it('updates aria-label to include blocked sessions count (plural)', () => {
    const { chip } = renderChip({ blockedElsewhere: 3 })
    expect(chip).toHaveAccessibleName(
      'Open sessions menu, 3 other sessions need you',
    )
  })

  it('uses standard aria-label when blockedElsewhere is 0', () => {
    const { chip } = renderChip({ blockedElsewhere: 0 })
    expect(chip).toHaveAccessibleName('Open sessions menu')
  })

  it('styles the badge with danger color', () => {
    renderChip({ blockedElsewhere: 2 })
    const badge = screen.getByTestId('blocked-elsewhere')
    expect(badge).toHaveClass('bg-danger')
  })
})
