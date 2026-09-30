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
  return {
    onClick,
    chip: screen.getByRole('button', { name: 'Open sessions menu' }),
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
})
