import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import { BottomNavigation } from './bottom-navigation'

vi.mock('../hooks/use-haptic', () => ({
  useHaptic: () => ({ trigger: vi.fn(), isSupported: false }),
}))

const SESSIONS: Session[] = [
  { id: 'shell', name: 'Shell', icon: '💻', description: 'Terminal' },
  { id: 'code', name: 'Code', icon: '🤖', description: 'Code editor' },
]

describe('BottomNavigation', () => {
  const defaultProps = {
    sessions: SESSIONS,
    activeId: 'shell',
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onToggleSidebar: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders toggle sidebar and add buttons', () => {
    render(<BottomNavigation {...defaultProps} />)
    expect(screen.getByLabelText('Toggle sessions panel')).toBeInTheDocument()
    expect(screen.getByLabelText('Add session')).toBeInTheDocument()
  })

  it('renders session buttons', () => {
    render(<BottomNavigation {...defaultProps} />)
    expect(screen.getByLabelText('Shell')).toBeInTheDocument()
    expect(screen.getByLabelText('Code')).toBeInTheDocument()
  })

  it('marks active session with aria-current', () => {
    render(<BottomNavigation {...defaultProps} />)
    expect(screen.getByLabelText('Shell')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(screen.getByLabelText('Code')).not.toHaveAttribute('aria-current')
  })

  it('calls onToggleSidebar when toggle button clicked', () => {
    render(<BottomNavigation {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Toggle sessions panel'))
    expect(defaultProps.onToggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('calls onAdd when add button clicked', () => {
    render(<BottomNavigation {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Add session'))
    expect(defaultProps.onAdd).toHaveBeenCalledTimes(1)
  })

  it('calls onSelect with session id when session clicked', () => {
    render(<BottomNavigation {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Code'))
    expect(defaultProps.onSelect).toHaveBeenCalledWith('code')
  })

  it('only renders up to 5 sessions', () => {
    const manySessions: Session[] = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      name: `Session ${i}`,
      icon: '💻',
      description: '',
    }))
    render(
      <BottomNavigation
        {...defaultProps}
        sessions={manySessions}
        activeId="s0"
      />,
    )
    // Only 5 shown
    for (let i = 0; i < 5; i++) {
      expect(screen.getByLabelText(`Session ${i}`)).toBeInTheDocument()
    }
    expect(screen.queryByLabelText('Session 5')).not.toBeInTheDocument()
  })

  it('renders with empty sessions list', () => {
    render(<BottomNavigation {...defaultProps} sessions={[]} />)
    expect(screen.getByLabelText('Toggle sessions panel')).toBeInTheDocument()
    expect(screen.getByLabelText('Add session')).toBeInTheDocument()
  })
})
