import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SessionTabs } from './session-tabs'
import type { Session } from '../types/session'

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

  it('active tab has different styling', () => {
    render(<SessionTabs {...defaultProps} />)
    // Shell is active — its button has shadow-sm class
    const shellBtn = screen.getByText('Shell').closest('button')
    expect(shellBtn).toHaveClass('shadow-sm')
    const codeBtn = screen.getByText('Code').closest('button')
    expect(codeBtn).not.toHaveClass('shadow-sm')
  })

  it('shows close button when more than one session', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByLabelText('Close Shell')).toBeInTheDocument()
    expect(screen.getByLabelText('Close Code')).toBeInTheDocument()
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
        ? { left: 0, right: 50, top: 0, bottom: 40, width: 50, height: 40 } as DOMRect
        : { left: 100, right: 300, top: 0, bottom: 40, width: 200, height: 40 } as DOMRect
    })

    const { rerender } = render(<SessionTabs {...defaultProps} activeId="shell" />)
    rerender(<SessionTabs {...defaultProps} activeId="code" />)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()

    Element.prototype.getBoundingClientRect = originalGetBCR
  })

  it('renders session icons', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByText('💻')).toBeInTheDocument()
    expect(screen.getByText('🤖')).toBeInTheDocument()
  })
})
