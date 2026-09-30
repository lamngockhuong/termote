import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import { SessionTabs } from './session-tabs'

const SESSIONS: Session[] = [
  { id: 'shell', name: 'Shell', icon: '💻', description: 'Terminal' },
  { id: 'code', name: 'Code', icon: '🤖', description: 'Code editor' },
]

const ONE_SESSION: Session[] = [
  { id: 'shell', name: 'Shell', icon: '💻', description: 'Terminal' },
]

describe('SessionTabs', () => {
  const defaultProps = {
    sessions: SESSIONS,
    activeId: 'shell',
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // scrollIntoView not available in jsdom
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('renders all session tabs', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByText('Shell')).toBeInTheDocument()
    expect(screen.getByText('Code')).toBeInTheDocument()
  })

  it('renders add button', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByLabelText('Add session')).toBeInTheDocument()
  })

  it('calls onAdd when add button clicked', () => {
    render(<SessionTabs {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Add session'))
    expect(defaultProps.onAdd).toHaveBeenCalledTimes(1)
  })

  it('calls onSelect with session id when tab clicked', () => {
    render(<SessionTabs {...defaultProps} />)
    fireEvent.click(screen.getByText('Code'))
    expect(defaultProps.onSelect).toHaveBeenCalledWith('code')
  })

  it('marks the active tab selected and styles it', () => {
    render(<SessionTabs {...defaultProps} />)
    const shell = screen.getByRole('tab', { name: /Shell/ })
    const code = screen.getByRole('tab', { name: /Code/ })
    expect(shell).toHaveAttribute('aria-selected', 'true')
    expect(shell).toHaveAttribute('tabindex', '0')
    expect(code).toHaveAttribute('aria-selected', 'false')
    expect(code).toHaveAttribute('tabindex', '-1')
    expect(shell.parentElement).toHaveClass('shadow-sm')
    expect(code.parentElement).not.toHaveClass('shadow-sm')
  })

  it('never nests the close button in the tab', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(
      screen.getByRole('tablist', { name: 'Sessions' }),
    ).toBeInTheDocument()
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.querySelector('button')).toBeNull()
    }
    expect(
      screen
        .getByRole('tablist')
        .contains(screen.getByLabelText('Add session')),
    ).toBe(false)
  })

  it('arrow keys, Home and End move focus between tabs without switching', () => {
    render(<SessionTabs {...defaultProps} />)
    const [shell, code] = screen.getAllByRole('tab')
    shell.focus()
    fireEvent.keyDown(shell, { key: 'ArrowRight' })
    expect(code).toHaveFocus()
    fireEvent.keyDown(code, { key: 'ArrowRight' })
    expect(shell).toHaveFocus()
    fireEvent.keyDown(shell, { key: 'ArrowLeft' })
    expect(code).toHaveFocus()
    fireEvent.keyDown(code, { key: 'ArrowLeft' })
    expect(shell).toHaveFocus()
    fireEvent.keyDown(shell, { key: 'End' })
    expect(code).toHaveFocus()
    fireEvent.keyDown(code, { key: 'Home' })
    expect(shell).toHaveFocus()
    fireEvent.keyDown(shell, { key: 'a' })
    expect(shell).toHaveFocus()
    expect(defaultProps.onSelect).not.toHaveBeenCalled()
  })

  it('ignores keys when no tab has focus', () => {
    render(<SessionTabs {...defaultProps} />)
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(document.body).toHaveFocus()
  })

  it('Delete closes the focused tab when tabs may be closed', () => {
    const { rerender } = render(<SessionTabs {...defaultProps} />)
    const code = screen.getByRole('tab', { name: /Code/ })
    code.focus()
    fireEvent.keyDown(code, { key: 'Delete' })
    expect(defaultProps.onRemove).toHaveBeenCalledWith('code')
    rerender(<SessionTabs {...defaultProps} canRemove={false} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: /Code/ }), {
      key: 'Delete',
    })
    expect(defaultProps.onRemove).toHaveBeenCalledOnce()
  })

  it('shows the description in the tab title', () => {
    render(
      <SessionTabs
        {...defaultProps}
        sessions={[SESSIONS[0], { ...SESSIONS[1], description: '' }]}
      />,
    )
    expect(screen.getByRole('tab', { name: /Shell/ })).toHaveAttribute(
      'title',
      'Shell - Terminal',
    )
    expect(screen.getByRole('tab', { name: /Code/ })).toHaveAttribute(
      'title',
      'Code',
    )
  })

  it('shows close button when more than one session', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByLabelText('Close Shell')).toBeInTheDocument()
    expect(screen.getByLabelText('Close Code')).toBeInTheDocument()
  })

  it('hides the close button of other tabs until hover, so it cannot be hit unseen', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByLabelText('Close Code')).toHaveClass('invisible')
    expect(screen.getByLabelText('Close Shell')).not.toHaveClass('invisible')
  })

  it('does not show close button with single session', () => {
    render(<SessionTabs {...defaultProps} sessions={ONE_SESSION} />)
    expect(screen.queryByLabelText('Close Shell')).not.toBeInTheDocument()
  })

  it('calls onRemove with session id when close button clicked', () => {
    render(<SessionTabs {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Close Code'))
    expect(defaultProps.onRemove).toHaveBeenCalledWith('code')
  })

  it('stopPropagation on close button prevents onSelect', () => {
    render(<SessionTabs {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Close Code'))
    expect(defaultProps.onSelect).not.toHaveBeenCalled()
  })

  it('scrolls active tab into view when not visible', () => {
    // Make getBoundingClientRect return values where active tab is out of container bounds
    const originalGetBCR = Element.prototype.getBoundingClientRect
    let callCount = 0
    Element.prototype.getBoundingClientRect = vi.fn(() => {
      callCount++
      // First call is for the active element rect, second for the container rect
      // Make element appear outside container (rect.left < containerRect.left)
      return callCount % 2 === 1
        ? ({
            left: 0,
            right: 50,
            top: 0,
            bottom: 40,
            width: 50,
            height: 40,
          } as DOMRect)
        : ({
            left: 100,
            right: 300,
            top: 0,
            bottom: 40,
            width: 200,
            height: 40,
          } as DOMRect)
    })

    const { rerender } = render(
      <SessionTabs {...defaultProps} activeId="shell" />,
    )
    rerender(<SessionTabs {...defaultProps} activeId="code" />)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()

    Element.prototype.getBoundingClientRect = originalGetBCR
  })

  it('renders session icons', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByText('💻')).toBeInTheDocument()
    expect(screen.getByText('🤖')).toBeInTheDocument()
  })

  it('shows the agent badge of a tab', () => {
    render(
      <SessionTabs
        {...defaultProps}
        sessions={[{ ...SESSIONS[0], agentStatus: 'working' }, SESSIONS[1]]}
      />,
    )
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getByRole('img', { name: 'Agent working' })).toBeVisible()
  })

  it('canRemove overrides the per-bar tab count', () => {
    const { rerender } = render(
      <SessionTabs {...defaultProps} sessions={ONE_SESSION} canRemove />,
    )
    expect(screen.getByLabelText('Close Shell')).toBeInTheDocument()
    rerender(<SessionTabs {...defaultProps} canRemove={false} />)
    expect(screen.queryByLabelText('Close Shell')).toBeNull()
  })
})
